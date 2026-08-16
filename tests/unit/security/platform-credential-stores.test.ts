import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  LinuxSecretServiceStore,
  WindowsCredentialManagerStore,
  WslHostCredentialProxyStore,
  type NativeCommandRunner,
} from '../../../src/security/index.js';

describe('platform credential stores', () => {
  it.skipIf(process.platform !== 'win32')('keeps Windows secrets out of process arguments and lists metadata only', async () => {
    const calls: { args: readonly string[]; input: Record<string, unknown> }[] = [];
    const run: NativeCommandRunner = vi.fn(async (_executable, args, stdin) => {
      const input = JSON.parse(Buffer.from(stdin).toString('utf8')) as Record<string, unknown>;
      calls.push({ args, input });
      const output = input.operation === 'get'
        ? { secret: Buffer.from('canary-secret').toString('base64') }
        : input.operation === 'list'
          ? { credentials: [{ reference: 'provider:test', createdAt: 1, updatedAt: 2 }] }
          : input.operation === 'delete' ? { deleted: true } : { ok: true };
      return { status: 0, stdout: Buffer.from(JSON.stringify(output)), stderr: Buffer.alloc(0) };
    });
    const store = new WindowsCredentialManagerStore(run);
    await store.set('provider:test', Buffer.from('canary-secret'));
    await store.withSecret('provider:test', async (secret) => expect(Buffer.from(secret).toString()).toBe('canary-secret'));
    expect(await store.list()).toEqual([{ reference: 'provider:test', createdAt: 1, updatedAt: 2 }]);
    expect(await store.delete('provider:test')).toBe(true);
    expect(JSON.stringify(calls.map((call) => call.args))).not.toContain('canary-secret');
  });

  it('uses Secret Service attributes for lookup without exposing a secret in arguments or metadata', async () => {
    const calls: readonly string[][] = [];
    const mutableCalls = calls as string[][];
    const run: NativeCommandRunner = vi.fn(async (_executable, args) => {
      mutableCalls.push([...args]);
      if (args.includes('lookup')) return { status: 0, stdout: Buffer.from('canary-secret\n'), stderr: Buffer.alloc(0) };
      if (args.includes('search')) return { status: 0, stdout: Buffer.from('attribute.reference = provider:test\n'), stderr: Buffer.alloc(0) };
      return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    });
    const store = new LinuxSecretServiceStore(run);
    await store.set('provider:test', Buffer.from('canary-secret'));
    await store.withSecret('provider:test', async (secret) => expect(Buffer.from(secret).toString()).toBe('canary-secret'));
    expect(await store.list()).toEqual([{ reference: 'provider:test', createdAt: 0, updatedAt: 0 }]);
    expect(JSON.stringify(calls)).not.toContain('canary-secret');
  });

  it('rejects an unauthenticated WSL host proxy response', async () => {
    const key = Buffer.alloc(32, 7);
    const goodTransport = {
      async exchange(request: Uint8Array): Promise<Uint8Array> {
        const envelope = JSON.parse(Buffer.from(request).toString('utf8')) as { payload: { operation: string } };
        const payload = envelope.payload.operation === 'list' ? { credentials: [] } : { deleted: true };
        const bytes = Buffer.from(JSON.stringify(payload));
        const mac = createHmac('sha256', key).update(bytes).digest('base64url');
        return Buffer.from(JSON.stringify({ payload, mac }));
      },
    };
    await expect(new WslHostCredentialProxyStore(goodTransport, key, () => 1, () => 'nonce').list()).resolves.toEqual([]);
    const badTransport = { async exchange() { return Buffer.from(JSON.stringify({ payload: {}, mac: 'invalid' })); } };
    await expect(new WslHostCredentialProxyStore(badTransport, key).list()).rejects.toThrow('CREDENTIAL_PROXY_AUTH_FAILED');
  });
});
