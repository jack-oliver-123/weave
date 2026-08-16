import { describe, expect, it } from 'vitest';
import { SecurityDigests, createCorrelationId } from '../../../src/security/index.js';

const secret = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');

describe('security digests', () => {
  it('is stable across instances with the same protected key and canonical input', () => {
    const first = new SecurityDigests(secret);
    const second = new SecurityDigests(Buffer.from(secret));

    expect(first.action({ tool: 'read_file', input: { path: 'a.ts', line: 2 } }))
      .toBe(second.action({ input: { line: 2, path: 'a.ts' }, tool: 'read_file' }));
  });

  it('separates action, capability, content, and ticket digest domains', () => {
    const digests = new SecurityDigests(secret);
    const value = { shortSecret: '1234' };
    const outputs = [
      digests.action(value),
      digests.capability(value),
      digests.content(value),
      digests.ticket(value),
    ];

    expect(new Set(outputs)).toHaveLength(4);
    expect(outputs.every((output) => !output.includes('1234'))).toBe(true);
  });

  it('does not expose a dictionary-verifiable bare hash for short sensitive values', () => {
    const first = new SecurityDigests(secret).content('1234');
    const second = new SecurityDigests(Buffer.alloc(32, 7)).content('1234');

    expect(first).not.toBe(second);
    expect(first).toMatch(/^content:v1:[A-Za-z0-9_-]{43}$/);
  });

  it('creates random correlation ids without deriving them from sensitive input', () => {
    const bytes = [Buffer.alloc(16, 1), Buffer.alloc(16, 2)];
    const randomBytes = () => bytes.shift()!;

    expect(createCorrelationId('event', randomBytes)).toBe('event:AQEBAQEBAQEBAQEBAQEBAQ');
    expect(createCorrelationId('event', randomBytes)).toBe('event:AgICAgICAgICAgICAgICAg');
  });

  it('preserves stability and domain separation for a fixed-seed generated corpus', () => {
    const first = new SecurityDigests(secret);
    const second = new SecurityDigests(Buffer.from(secret));
    let seed = 0x5eed1234;

    for (let index = 0; index < 256; index += 1) {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      const value = { nested: { flag: (seed & 1) === 0, value: seed }, index, text: `value-${seed}` };
      const reordered = { text: value.text, index: value.index, nested: { value: seed, flag: value.nested.flag } };
      const action = first.action(value);

      expect(action).toBe(second.action(reordered));
      expect(action).not.toBe(first.capability(value));
      expect(action).not.toBe(first.content(value));
      expect(action).not.toBe(first.ticket(value));
    }
  });
});
