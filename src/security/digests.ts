import { createHmac, randomBytes as nodeRandomBytes } from 'node:crypto';

type DigestDomain = 'action' | 'capability' | 'content' | 'ticket';

export class SecurityDigests {
  private readonly key: Buffer;

  constructor(key: Uint8Array) {
    if (key.byteLength < 32) throw new TypeError('Security digest key must contain at least 32 bytes');
    this.key = Buffer.from(key);
  }

  action(value: unknown): string { return this.digest('action', value); }
  capability(value: unknown): string { return this.digest('capability', value); }
  content(value: unknown): string { return this.digest('content', value); }
  ticket(value: unknown): string { return this.digest('ticket', value); }

  private digest(domain: DigestDomain, value: unknown): string {
    const input = canonicalJson(value);
    const output = createHmac('sha256', this.key)
      .update(`weave-security:v1:${domain}\0`, 'utf8')
      .update(input, 'utf8')
      .digest('base64url');
    return `${domain}:v1:${output}`;
  }
}

export function createSecurityDigestKey(): Buffer {
  return nodeRandomBytes(32);
}

export function createCorrelationId(
  domain: string,
  randomBytes: (size: number) => Uint8Array = nodeRandomBytes,
): string {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(domain)) throw new TypeError('Correlation ID domain is invalid');
  const bytes = randomBytes(16);
  if (bytes.byteLength !== 16) throw new TypeError('Correlation ID entropy source must return 16 bytes');
  return `${domain}:${Buffer.from(bytes).toString('base64url')}`;
}

export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  return serialize(value, '$', ancestors);
}

function serialize(value: unknown, path: string, ancestors: Set<object>): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path}: digest input contains a non-finite number`);
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value !== 'object') throw new TypeError(`${path}: digest input is not JSON-compatible`);
  if (ancestors.has(value)) throw new TypeError(`${path}: digest input contains a cycle`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item, index) => serialize(item, `${path}[${index}]`, ancestors)).join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${path}: digest input must contain plain objects`);
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${serialize(item, `${path}.${key}`, ancestors)}`).join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}
