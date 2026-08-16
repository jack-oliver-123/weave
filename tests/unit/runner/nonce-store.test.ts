import { describe, expect, it } from 'vitest';
import { TaskNonceStore } from '../../../src/runner/index.js';
import { CapabilityTicketIssuer } from '../../../src/security/index.js';

describe('Task nonce and revocation store', () => {
  it('atomically permits one consumer and reports concurrent replay as integrity failure', async () => {
    const now = 1_700_000_000_000;
    const issuer = new CapabilityTicketIssuer();
    const ticket = issuer.issue({
      ticketId: 'ticket-1', runnerId: 'runner-1', sandboxId: 'sandbox-1', taskId: 'task-1',
      runId: 'run-1', callId: 'call-1', actionDigest: 'action', capabilityDigest: 'capability',
      policyVersion: 'policy-1', revocationVersion: 0, authorizationEpoch: 1,
      nonce: 'nonce-1', issuedAt: now, expiresAt: now + 30_000,
    });
    const store = new TaskNonceStore('task-1', 0, () => now + 1);
    const outcomes = await Promise.allSettled([
      Promise.resolve().then(() => store.consume(ticket)),
      Promise.resolve().then(() => store.consume(ticket)),
    ]);
    expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((item) => item.status === 'rejected')[0]).toMatchObject({ reason: { code: 'TICKET_REPLAY' } });
  });

  it('treats normal expiry and revocation as ordinary denials without consuming the nonce', () => {
    const now = 1_700_000_000_000;
    const issuer = new CapabilityTicketIssuer();
    const base = {
      ticketId: 'ticket-1', runnerId: 'runner-1', sandboxId: 'sandbox-1', taskId: 'task-1',
      runId: 'run-1', callId: 'call-1', actionDigest: 'action', capabilityDigest: 'capability',
      policyVersion: 'policy-1', revocationVersion: 0, authorizationEpoch: 1,
      nonce: 'nonce-1', issuedAt: now, expiresAt: now + 30_000,
    } as const;
    const expired = new TaskNonceStore('task-1', 0, () => now + 30_001);
    expect(() => expired.consume(issuer.issue(base))).toThrow(expect.objectContaining({ code: 'TICKET_EXPIRED' }));
    const revoked = new TaskNonceStore('task-1', 0, () => now + 1);
    revoked.revoke();
    expect(() => revoked.consume(issuer.issue(base))).toThrow(expect.objectContaining({ code: 'TICKET_REVOKED' }));
  });
});
