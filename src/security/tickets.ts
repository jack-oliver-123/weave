import { createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { canonicalJson } from './digests.js';
import { parseCapabilityTicket, SECURITY_SCHEMA_VERSION, type CapabilityTicket } from './domain.js';
import { SecurityIntegrityFailureError } from './authorization.js';

export type UnsignedCapabilityTicket = Omit<CapabilityTicket, 'schemaVersion' | 'signature'>;

export class CapabilityTicketDeniedError extends Error {
  constructor(readonly code: 'TICKET_EXPIRED' | 'TICKET_REVOKED', message: string) {
    super(message);
    this.name = 'CapabilityTicketDeniedError';
  }
}

export class CapabilityTicketIssuer {
  readonly #privateKey: KeyObject;
  readonly publicKey: string;

  constructor() {
    const pair = generateKeyPairSync('ed25519');
    this.#privateKey = pair.privateKey;
    this.publicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  }

  issue(input: UnsignedCapabilityTicket): CapabilityTicket {
    validateWindow(input.issuedAt, input.expiresAt);
    const unsigned = { schemaVersion: SECURITY_SCHEMA_VERSION, ...input } as const;
    const signature = sign(null, ticketPayload(unsigned), this.#privateKey).toString('base64url');
    return parseCapabilityTicket({ ...unsigned, signature });
  }
}

export interface CapabilityTicketBinding {
  readonly runnerId: string;
  readonly sandboxId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly callId: string;
  readonly actionDigest: string;
  readonly capabilityDigest: string;
  readonly policyVersion: string;
  readonly revocationVersion: number;
  readonly authorizationEpoch: number;
}

export class CapabilityTicketVerifier {
  private readonly publicKey: KeyObject;

  constructor(publicKey: string, private readonly now: () => number = Date.now) {
    this.publicKey = createPublicKey({ key: Buffer.from(publicKey, 'base64url'), type: 'spki', format: 'der' });
  }

  verify(ticketValue: unknown, binding: CapabilityTicketBinding): CapabilityTicket {
    const ticket = parseCapabilityTicket(ticketValue);
    const { signature, ...unsigned } = ticket;
    if (!verify(null, ticketPayload(unsigned), this.publicKey, Buffer.from(signature, 'base64url'))) {
      throw new SecurityIntegrityFailureError('TICKET_SIGNATURE_INVALID', 'Capability ticket signature is invalid');
    }
    for (const key of Object.keys(binding) as (keyof CapabilityTicketBinding)[]) {
      if (ticket[key] !== binding[key]) {
        throw new SecurityIntegrityFailureError('TICKET_BINDING_MISMATCH', `Capability ticket binding mismatch: ${key}`);
      }
    }
    if (ticket.expiresAt < this.now()) throw new CapabilityTicketDeniedError('TICKET_EXPIRED', 'Capability ticket expired normally');
    if (ticket.issuedAt > this.now() + 5_000) throw new SecurityIntegrityFailureError('TICKET_TIME_INVALID', 'Capability ticket was issued in the future');
    return ticket;
  }
}

function ticketPayload(ticket: Omit<CapabilityTicket, 'signature'>): Buffer {
  return Buffer.from(`weave-capability-ticket:v1\0${canonicalJson(ticket)}`, 'utf8');
}

function validateWindow(issuedAt: number, expiresAt: number): void {
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt || expiresAt - issuedAt > 60_000) {
    throw new TypeError('Capability ticket validity window must be positive and at most 60 seconds');
  }
}
