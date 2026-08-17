import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { WindowsCredentialManagerStore } from '../../src/security/index.js';

const enabled = process.platform === 'win32' && process.env.WEAVE_CREDENTIAL_CERTIFICATION === 'windows';

describe.skipIf(!enabled)('Windows Credential Manager certification', () => {
  it('round-trips a temporary generic credential and removes it', async () => {
    const store = new WindowsCredentialManagerStore();
    const reference = `certification:${randomBytes(8).toString('hex')}`;
    const value = randomBytes(32);
    try {
      await store.set(reference, value);
      await store.withSecret(reference, async (secret) => expect(secret).toEqual(value));
      expect((await store.list()).some((item) => item.reference === reference)).toBe(true);
    } finally {
      await store.delete(reference);
      value.fill(0);
    }
  });
});
