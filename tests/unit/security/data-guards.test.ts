import { describe, expect, it } from 'vitest';
import {
  CredentialDataBlockedError,
  FinalInputGuard,
  InputGuard,
  OutputGuard,
  SensitiveDataAuthorizationRequiredError,
} from '../../../src/security/index.js';

describe('data guards', () => {
  it('blocks credential-bearing current input before it can be retained', () => {
    const guard = new InputGuard();
    expect(() => guard.classifyCurrentInput('token: ghp_1234567890abcdefghijklmnopqrst'))
      .toThrow(CredentialDataBlockedError);
  });

  it('checks final destination and serialized bytes before provider transport', () => {
    const guard = new FinalInputGuard();
    const expected = { profile: 'p1', protocol: 'openai-responses' as const, model: 'm1', origin: 'https://api.example' };

    expect(() => guard.assertAllowed({
      expectedDestination: expected,
      actualDestination: { ...expected, origin: 'https://redirect.example' },
      headers: {}, body: new TextEncoder().encode('{"input":"safe"}'), authorizedSensitiveValues: [],
    })).toThrow('MODEL_DESTINATION_MISMATCH');
    expect(() => guard.assertAllowed({
      expectedDestination: expected, actualDestination: expected,
      headers: { 'x-debug': 'Bearer secret-secret-secret-secret-secret' },
      body: new TextEncoder().encode('{"input":"safe"}'), authorizedSensitiveValues: [],
    })).toThrow(CredentialDataBlockedError);
  });

  it('streams ordinary chunks through an overlap window and withholds sensitive/credential tails', async () => {
    const ordinary = await collect(new OutputGuard({ overlapCharacters: 4 }).guard(chunks(['hello', ' world'])));
    expect(ordinary).toEqual(['h', 'ello w', 'orld']);

    await expect(collect(new OutputGuard({ overlapCharacters: 8 }).guard(chunks(['safe ', 'WEAVE_SENSITIVE:private']))))
      .rejects.toThrow(SensitiveDataAuthorizationRequiredError);
    await expect(collect(new OutputGuard({ overlapCharacters: 8 }).guard(chunks(['safe ', 'ghp_1234567890abcdefghijklmnopqrst']))))
      .rejects.toThrow(CredentialDataBlockedError);
  });
});

async function* chunks(values: readonly string[]): AsyncGenerator<string> { yield* values; }
async function collect(values: AsyncIterable<string>): Promise<string[]> { const result: string[] = []; for await (const value of values) result.push(value); return result; }
