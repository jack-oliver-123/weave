import { describe, expect, it, vi } from 'vitest';
import {
  EnvironmentMigrationCredentialStore,
  InMemoryCredentialStore,
  ProviderCredentialBroker,
} from '../../../src/security/index.js';

describe('Credential Broker', () => {
  it('lists only metadata and zeroes ephemeral secret bytes after use', async () => {
    const store = new InMemoryCredentialStore(() => 10);
    const source = new TextEncoder().encode('canary-secret');
    await store.set('provider:test', source);
    source.fill(0);
    let ephemeral: Uint8Array | undefined;
    await store.withSecret('provider:test', async (secret) => { ephemeral = secret; expect(new TextDecoder().decode(secret)).toBe('canary-secret'); });
    expect(ephemeral).toEqual(new Uint8Array('canary-secret'.length));
    expect(await store.list()).toEqual([{ reference: 'provider:test', createdAt: 10, updatedAt: 10 }]);
    expect(JSON.stringify(await store.list())).not.toContain('canary-secret');
  });

  it.each([
    ['bearer', 'authorization', 'Bearer canary-secret', 'x-api-key'],
    ['anthropic-api-key', 'x-api-key', 'canary-secret', 'authorization'],
  ] as const)('injects %s only at the fixed-origin fetch boundary and rejects redirects', async (
    scheme,
    expectedHeader,
    expectedValue,
    absentHeader,
  ) => {
    const store = new InMemoryCredentialStore();
    await store.set('provider:test', new TextEncoder().encode('canary-secret'));
    const transport = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get(expectedHeader)).toBe(expectedValue);
      expect(headers.get(absentHeader)).toBeNull();
      expect(init?.redirect).toBe('manual');
      return new Response(null, { status: 302, headers: { location: 'https://evil.invalid' } });
    });
    const broker = new ProviderCredentialBroker(store, transport);
    await expect(broker.fetch('provider:test', 'https://api.example.test', scheme, 'https://evil.invalid/v1'))
      .rejects.toThrow('MODEL_DESTINATION_MISMATCH');
    expect(transport).not.toHaveBeenCalled();
    await expect(broker.fetch('provider:test', 'https://api.example.test', scheme, 'https://api.example.test/v1'))
      .rejects.toThrow('PROVIDER_REDIRECT_REJECTED');
    expect(transport).toHaveBeenCalledOnce();
    expect(JSON.stringify(transport.mock.calls)).not.toContain('canary-secret');
  });

  it('fails closed before reading the credential for plaintext destinations', async () => {
    const store = new InMemoryCredentialStore();
    await store.set('provider:test', new TextEncoder().encode('canary-secret'));
    const withSecret = vi.spyOn(store, 'withSecret');
    const transport = vi.fn(async () => new Response(null, { status: 200 }));
    const broker = new ProviderCredentialBroker(store, transport);

    await expect(broker.fetch('provider:test', 'http://api.example.test', 'bearer', 'http://api.example.test/v1'))
      .rejects.toThrow('MODEL_DESTINATION_TLS_REQUIRED');
    expect(withSecret).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it('supports the deprecated environment reference without storing or listing its value', async () => {
    const store = new EnvironmentMigrationCredentialStore(new InMemoryCredentialStore(), { LEGACY_KEY: 'legacy-secret' });
    await store.withSecret('env:LEGACY_KEY', async (secret) => { expect(new TextDecoder().decode(secret)).toBe('legacy-secret'); });
    expect(await store.list()).toEqual([]);
  });
});
