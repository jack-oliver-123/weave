import type { CapabilityTicket } from '../security/domain.js';
import { SecurityIntegrityFailureError } from '../security/authorization.js';
import { CapabilityTicketDeniedError } from '../security/tickets.js';

export class TaskNonceStore {
  private readonly consumed = new Set<string>();
  private revocationVersion: number;
  private closed = false;

  constructor(readonly taskId: string, initialRevocationVersion = 0, private readonly now: () => number = Date.now) {
    this.revocationVersion = initialRevocationVersion;
  }

  get currentRevocationVersion(): number { return this.revocationVersion; }

  consume(ticket: CapabilityTicket): void {
    if (this.closed) throw new CapabilityTicketDeniedError('TICKET_REVOKED', 'Task authorization is closed');
    if (ticket.taskId !== this.taskId) throw new SecurityIntegrityFailureError('TICKET_TASK_MISMATCH', 'Ticket belongs to another Task');
    if (ticket.revocationVersion !== this.revocationVersion) throw new CapabilityTicketDeniedError('TICKET_REVOKED', 'Ticket revocation version is stale');
    if (ticket.expiresAt < this.now()) throw new CapabilityTicketDeniedError('TICKET_EXPIRED', 'Ticket expired normally');
    if (this.consumed.has(ticket.nonce)) throw new SecurityIntegrityFailureError('TICKET_REPLAY', 'Ticket nonce was already consumed');
    this.consumed.add(ticket.nonce);
  }

  revoke(): number {
    this.revocationVersion += 1;
    return this.revocationVersion;
  }

  close(): void {
    this.closed = true;
    this.revoke();
    this.consumed.clear();
  }
}
