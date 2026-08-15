import type { ChatMessage } from '../shared/types.js';
import type { DataClassification, ProvenanceEnvelope } from './domain.js';
import { deepFreeze, SECURITY_SCHEMA_VERSION } from './domain.js';
import type { SecurityDigests } from './digests.js';

export type DataDestination = 'model' | 'terminal' | 'history' | 'file' | 'network' | 'audit';

export class SecureContextDestroyedError extends Error {
  constructor() { super('SECURE_CONTEXT_DESTROYED: Task 安全上下文已销毁'); this.name = 'SecureContextDestroyedError'; }
}

export class RequiredContextAuthorizationError extends Error {
  constructor(entryId: string, destination: DataDestination) {
    super(`CONTEXT_DESTINATION_NOT_AUTHORIZED: ${entryId} -> ${destination}`);
    this.name = 'RequiredContextAuthorizationError';
  }
}

interface LedgerEntry {
  readonly entryId: string;
  readonly message: ChatMessage;
  readonly envelope: ProvenanceEnvelope;
  readonly destinations: readonly DataDestination[];
  readonly required: boolean;
}

export interface SecureContextLedgerOptions {
  readonly taskId: string;
  readonly digests: SecurityDigests;
  readonly createId: () => string;
}

export class SecureContextLedger {
  private entries: LedgerEntry[] = [];
  private destroyed = false;

  constructor(private readonly options: SecureContextLedgerOptions) {}

  get size(): number { return this.entries.length; }

  acceptMessage(input: {
    readonly message: ChatMessage;
    readonly source: ProvenanceEnvelope['source'];
    readonly classification: DataClassification;
    readonly purpose: string;
    readonly destinations: readonly DataDestination[];
    readonly required: boolean;
  }): ProvenanceEnvelope {
    this.assertActive();
    const entryId = this.options.createId();
    const contentDigest = this.options.digests.content(input.message);
    const envelope: ProvenanceEnvelope = deepFreeze({
      schemaVersion: SECURITY_SCHEMA_VERSION,
      envelopeId: entryId,
      source: { ...input.source },
      classification: input.classification,
      contentDigest,
      purpose: input.purpose,
      contentRef: `task:${this.options.taskId}:entry:${entryId}`,
    });
    this.entries.push(deepFreeze({
      entryId,
      message: structuredClone(input.message),
      envelope,
      destinations: [...new Set(input.destinations)],
      required: input.required,
    }));
    return envelope;
  }

  messagesFor(destination: DataDestination): readonly ChatMessage[] {
    this.assertActive();
    const messages: ChatMessage[] = [];
    for (const entry of this.entries) {
      if (entry.destinations.includes(destination)) messages.push(structuredClone(entry.message));
      else if (entry.required) throw new RequiredContextAuthorizationError(entry.entryId, destination);
    }
    return deepFreeze(messages);
  }

  omissionsFor(destination: DataDestination): readonly { readonly entryId: string; readonly classification: DataClassification; readonly purpose: string }[] {
    this.assertActive();
    return deepFreeze(this.entries
      .filter((entry) => !entry.destinations.includes(destination) && !entry.required)
      .map((entry) => ({ entryId: entry.entryId, classification: entry.envelope.classification, purpose: entry.envelope.purpose })));
  }

  destroy(): void {
    this.entries = [];
    this.destroyed = true;
  }

  private assertActive(): void {
    if (this.destroyed) throw new SecureContextDestroyedError();
  }
}

interface DisclosureDescriptor {
  readonly contentDigest: string;
  readonly sourceReference: string;
  readonly classification: DataClassification;
  readonly purpose: string;
  readonly destination: DataDestination;
}

export class DisclosurePolicy {
  private readonly grants = new Set<string>();

  constructor(private readonly taskId: string) {}

  grant(input: DisclosureDescriptor): void {
    if (input.classification === 'credential') return;
    this.grants.add(this.key(input));
  }

  canDisclose(input: DisclosureDescriptor): boolean {
    if (input.classification === 'credential') return false;
    if (input.classification === 'ordinary') return input.destination === 'model' || input.destination === 'terminal';
    return this.grants.has(this.key(input));
  }

  private key(input: DisclosureDescriptor): string {
    return JSON.stringify([
      this.taskId,
      input.contentDigest,
      input.sourceReference,
      input.classification,
      input.purpose,
      input.destination,
    ]);
  }
}
