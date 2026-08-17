import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { runCredentialCommand } from '../../../src/config/credential-cli.js';
import { InMemoryCredentialStore } from '../../../src/security/index.js';

describe('credential CLI', () => {
  it('accepts stdin, lists metadata without the secret, and deletes by reference', async () => {
    const store = new InMemoryCredentialStore(() => 10);
    const input = new PassThrough() as PassThrough & { isTTY: boolean };
    input.isTTY = false;
    input.end('canary-secret\n');
    const output = new PassThrough();
    let rendered = '';
    output.on('data', (chunk) => { rendered += chunk.toString(); });
    await runCredentialCommand({ operation: 'set', reference: 'provider:test' }, store, input as NodeJS.ReadStream, output);
    await runCredentialCommand({ operation: 'list' }, store, input as NodeJS.ReadStream, output);
    expect(rendered).toContain('provider:test');
    expect(rendered).not.toContain('canary-secret');
    await store.withSecret('provider:test', async (secret) => expect(Buffer.from(secret).toString()).toBe('canary-secret'));
    await runCredentialCommand({ operation: 'delete', reference: 'provider:test' }, store, input as NodeJS.ReadStream, output);
    expect(await store.list()).toEqual([]);
  });
});
