export interface CredentialMetadata {
  readonly reference: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CredentialStore {
  set(reference: string, secret: Uint8Array): Promise<void>;
  delete(reference: string): Promise<boolean>;
  list(): Promise<readonly CredentialMetadata[]>;
  withSecret<T>(reference: string, operation: (secret: Uint8Array) => Promise<T>): Promise<T>;
}

export class InMemoryCredentialStore implements CredentialStore {
  private readonly values = new Map<string, { secret: Uint8Array; createdAt: number; updatedAt: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  async set(reference: string, secret: Uint8Array): Promise<void> {
    validateReference(reference);
    if (secret.byteLength === 0) throw new TypeError('Credential secret must not be empty');
    const existing = this.values.get(reference);
    const timestamp = this.now();
    this.values.set(reference, {
      secret: new Uint8Array(secret), createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp,
    });
  }

  async delete(reference: string): Promise<boolean> {
    validateReference(reference);
    const existing = this.values.get(reference);
    if (existing === undefined) return false;
    existing.secret.fill(0);
    return this.values.delete(reference);
  }

  async list(): Promise<readonly CredentialMetadata[]> {
    return Object.freeze([...this.values.entries()].map(([reference, value]) => Object.freeze({
      reference, createdAt: value.createdAt, updatedAt: value.updatedAt,
    })).sort((left, right) => left.reference.localeCompare(right.reference)));
  }

  async withSecret<T>(reference: string, operation: (secret: Uint8Array) => Promise<T>): Promise<T> {
    validateReference(reference);
    const stored = this.values.get(reference);
    if (stored === undefined) throw new Error('CREDENTIAL_NOT_FOUND');
    const ephemeral = new Uint8Array(stored.secret);
    try { return await operation(ephemeral); }
    finally { ephemeral.fill(0); }
  }
}

export class EnvironmentMigrationCredentialStore implements CredentialStore {
  constructor(
    private readonly delegate: CredentialStore,
    private readonly environment: Readonly<Record<string, string | undefined>> = process.env,
  ) {}
  set(reference: string, secret: Uint8Array): Promise<void> { return this.delegate.set(reference, secret); }
  delete(reference: string): Promise<boolean> { return this.delegate.delete(reference); }
  list(): Promise<readonly CredentialMetadata[]> { return this.delegate.list(); }
  async withSecret<T>(reference: string, operation: (secret: Uint8Array) => Promise<T>): Promise<T> {
    if (!reference.startsWith('env:')) return this.delegate.withSecret(reference, operation);
    const name = reference.slice(4);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('CREDENTIAL_REFERENCE_INVALID');
    const value = this.environment[name];
    if (value === undefined || value.length === 0) throw new Error('CREDENTIAL_NOT_FOUND');
    const ephemeral = new TextEncoder().encode(value);
    try { return await operation(ephemeral); }
    finally { ephemeral.fill(0); }
  }
}

export class ProviderCredentialBroker {
  constructor(
    private readonly store: CredentialStore,
    private readonly transport: typeof fetch = createBrokeredFetchTransport(),
  ) {}

  async fetch(
    reference: string,
    expectedOrigin: string,
    scheme: 'bearer' | 'anthropic-api-key',
    input: string | URL | Request,
    init: RequestInit = {},
  ): Promise<Response> {
    const url = input instanceof Request ? new URL(input.url) : new URL(input.toString());
    const expected = new URL(expectedOrigin);
    if (url.protocol !== 'https:' || expected.protocol !== 'https:') throw new Error('MODEL_DESTINATION_TLS_REQUIRED');
    if (url.origin !== expected.origin) throw new Error('MODEL_DESTINATION_MISMATCH');
    return this.store.withSecret(reference, async (bytes) => {
      const secret = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      new Headers(init.headers).forEach((value, key) => headers.set(key, value));
      if (scheme === 'bearer') headers.set('authorization', `Bearer ${secret}`);
      else headers.set('x-api-key', secret);
      const response = await this.transport(input, { ...init, headers, redirect: 'manual' });
      if (response.status >= 300 && response.status < 400) throw new Error('PROVIDER_REDIRECT_REJECTED');
      return response;
    });
  }
}

export function validateReference(reference: string): void {
  if (!/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(reference)) throw new Error('CREDENTIAL_REFERENCE_INVALID');
}
import { createBrokeredFetchTransport } from './egress-broker.js';
