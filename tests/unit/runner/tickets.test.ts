import { describe, expect, it } from 'vitest';
import { CapabilityTicketIssuer, CapabilityTicketVerifier } from '../../../src/security/index.js';

const now = 1_700_000_000_000;

describe('Capability Ticket signing', () => {
  it('binds every execution field with an ephemeral Ed25519 signature', () => {
    const issuer = new CapabilityTicketIssuer();
    const input = unsigned();
    const ticket = issuer.issue(input);
    const verifier = new CapabilityTicketVerifier(issuer.publicKey, () => now + 1);
    expect(verifier.verify(ticket, input)).toEqual(ticket);
    expect(Object.keys(issuer)).toEqual(['publicKey']);
    expect(JSON.stringify(issuer)).not.toContain('private');
  });

  it('treats signature and identity tampering as integrity failures', () => {
    const issuer = new CapabilityTicketIssuer();
    const input = unsigned();
    const ticket = issuer.issue(input);
    const verifier = new CapabilityTicketVerifier(issuer.publicKey, () => now + 1);
    expect(() => verifier.verify({ ...ticket, actionDigest: 'tampered' }, { ...input, actionDigest: 'tampered' }))
      .toThrow(expect.objectContaining({ code: 'TICKET_SIGNATURE_INVALID' }));
    expect(() => verifier.verify(ticket, { ...input, runnerId: 'runner-2' }))
      .toThrow(expect.objectContaining({ code: 'TICKET_BINDING_MISMATCH' }));
  });

  it('maps ordinary expiry to a retryable authorization denial', () => {
    const issuer = new CapabilityTicketIssuer();
    const input = unsigned();
    const ticket = issuer.issue(input);
    const verifier = new CapabilityTicketVerifier(issuer.publicKey, () => ticket.expiresAt + 1);
    expect(() => verifier.verify(ticket, input)).toThrow(expect.objectContaining({ code: 'TICKET_EXPIRED' }));
  });

  it('rejects invalid or overlong validity windows', () => {
    const issuer = new CapabilityTicketIssuer();
    expect(() => issuer.issue({ ...unsigned(), expiresAt: now })).toThrow('validity window');
    expect(() => issuer.issue({ ...unsigned(), expiresAt: now + 60_001 })).toThrow('validity window');
  });
});

function unsigned() {
  return {
    ticketId: 'ticket-1', runnerId: 'runner-1', sandboxId: 'sandbox-1', taskId: 'task-1',
    runId: 'run-1', callId: 'call-1', actionDigest: 'execution-action:v1:test',
    capabilityDigest: 'execution-capability:v1:test', policyVersion: 'policy-1',
    revocationVersion: 0, authorizationEpoch: 1, nonce: 'nonce-1', issuedAt: now, expiresAt: now + 30_000,
  } as const;
}
