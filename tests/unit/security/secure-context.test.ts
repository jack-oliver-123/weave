import { describe, expect, it } from 'vitest';
import {
  DisclosurePolicy,
  SecureContextLedger,
  SecurityDigests,
  SecureContextDestroyedError,
} from '../../../src/security/index.js';

const digests = () => new SecurityDigests(Buffer.from('0123456789abcdef0123456789abcdef'));

describe('Secure Context Ledger', () => {
  it('keeps private model context separate from the public transcript and destroys it with the task', () => {
    let nextId = 1;
    const ledger = new SecureContextLedger({ taskId: 'task-1', digests: digests(), createId: () => `entry-${nextId++}` });
    ledger.acceptMessage({
      message: { role: 'tool', content: 'private tool result' },
      source: { kind: 'tool', reference: 'call-1' },
      classification: 'ordinary', purpose: 'model_observation', destinations: ['model'], required: false,
    });

    expect(ledger.messagesFor('model')).toEqual([{ role: 'tool', content: 'private tool result' }]);
    expect(ledger.messagesFor('terminal')).toEqual([]);
    expect(ledger.size).toBe(1);

    ledger.destroy();
    expect(ledger.size).toBe(0);
    expect(() => ledger.messagesFor('model')).toThrow(SecureContextDestroyedError);
  });

  it('omits optional unauthorized context but never silently drops required current input', () => {
    const ledger = new SecureContextLedger({ taskId: 'task-1', digests: digests(), createId: () => 'entry-1' });
    ledger.acceptMessage({
      message: { role: 'user', content: 'optional history' },
      source: { kind: 'history', reference: 'public-1' },
      classification: 'sensitive', purpose: 'background', destinations: [], required: false,
    });
    ledger.acceptMessage({
      message: { role: 'user', content: 'current request' },
      source: { kind: 'user', reference: 'turn-1' },
      classification: 'ordinary', purpose: 'task_input', destinations: ['model'], required: true,
    });

    expect(ledger.messagesFor('model')).toEqual([{ role: 'user', content: 'current request' }]);
    expect(ledger.omissionsFor('model')).toEqual([{ entryId: 'entry-1', classification: 'sensitive', purpose: 'background' }]);
  });

  it('requires an independent destination-bound disclosure grant for sensitive content', () => {
    const policy = new DisclosurePolicy('task-1');
    const content = { contentDigest: 'digest-1', sourceReference: 'file:secret.txt', classification: 'sensitive' as const };

    expect(policy.canDisclose({ ...content, purpose: 'answer', destination: 'model' })).toBe(false);
    policy.grant({ ...content, purpose: 'answer', destination: 'terminal' });
    expect(policy.canDisclose({ ...content, purpose: 'answer', destination: 'terminal' })).toBe(true);
    expect(policy.canDisclose({ ...content, purpose: 'answer', destination: 'model' })).toBe(false);
    expect(policy.canDisclose({ ...content, classification: 'credential', purpose: 'answer', destination: 'terminal' })).toBe(false);
  });
});
