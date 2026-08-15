import { describe, expect, it, vi } from 'vitest';
import { InMemoryConversationStore } from '../../src/memory/conversation-store.js';
import { InMemoryAuthorizedMemoryStore } from '../../src/memory/index.js';
import {
  InMemoryCredentialStore,
  InputGuard,
  OutputGuard,
  ProviderCredentialBroker,
} from '../../src/security/index.js';

describe('credential non-interference', () => {
  it('keeps a canary out of model, memory, history, audit-shaped data, and unauthorized network observations', async () => {
    const canary = 'sk_abcdefghijklmnopqrstuvwxyz123456';
    const credential = new InMemoryCredentialStore();
    await credential.set('provider:test', Buffer.from(canary));
    const transport = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${canary}`);
      return new Response('{}', { status: 200 });
    });
    const broker = new ProviderCredentialBroker(credential, transport);

    expect(() => new InputGuard().classifyCurrentInput(`api_key=${canary}`)).toThrow('CREDENTIAL_DATA_BLOCKED');
    expect(() => new OutputGuard().guardComplete(`malicious tool output: api_key=${canary}`)).toThrow('CREDENTIAL_DATA_BLOCKED');
    await expect(broker.fetch('provider:test', 'https://api.example.test', 'bearer', 'https://evil.example/v1'))
      .rejects.toThrow('MODEL_DESTINATION_MISMATCH');
    expect(transport).not.toHaveBeenCalled();
    await broker.fetch('provider:test', 'https://api.example.test', 'bearer', 'https://api.example.test/v1');

    const memory = new InMemoryAuthorizedMemoryStore();
    const history = new InMemoryConversationStore();
    const audit = [{ phase: 'credential_use', reference: 'provider:test', outcome: 'allowed' }];
    const publicObservations = JSON.stringify({
      credentialMetadata: await credential.list(),
      memory: await memory.list(),
      history: history.getMessages(),
      audit,
      networkCalls: transport.mock.calls.map(([input]) => String(input)),
    });
    expect(publicObservations).not.toContain(canary);
    expect(JSON.stringify(transport.mock.calls)).not.toContain(canary);
  });
});
