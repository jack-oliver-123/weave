import type { ToolCallRequest, ToolCallResult } from '../shared/types.js';
import {
  executionActionDigest,
  executionCapabilityDigest,
  normalizeToolCall,
} from '../security/action-normalizer.js';
import { SecurityIntegrityFailureError } from '../security/authorization.js';
import type { SecurityAuditRecord, SecurityAuditTaskResource } from '../security/audit.js';
import type { CapabilityTicket, NormalizedAction } from '../security/domain.js';
import { CapabilityTicketDeniedError, CapabilityTicketVerifier } from '../security/tickets.js';
import { TaskNonceStore } from './nonce-store.js';
import { TaskProcessRegistry, type ManagedProcessTree } from './process-registry.js';
import {
  deriveActionSandboxProfile,
  type ActionSandboxProfile,
  type ResourceBudget,
} from './resources.js';
import type { AuthenticatedRunnerSession } from './protocol.js';
import type { CapabilityReport } from './capability-report.js';

export interface ActionWorkerLaunchInput {
  readonly taskId: string;
  readonly runId: string;
  readonly call: ToolCallRequest;
  readonly action: NormalizedAction;
  readonly profile: ActionSandboxProfile;
}

export interface ActionWorkerResult {
  readonly result: ToolCallResult;
  readonly taskProcess?: ManagedProcessTree;
}

export interface ActionWorkerBackend {
  execute(signal: AbortSignal): Promise<ActionWorkerResult>;
  close(reason: 'action_completed' | 'cancelled' | 'failed'): Promise<void>;
}

export interface TaskSandboxBackend {
  openWorker(input: ActionWorkerLaunchInput): Promise<ActionWorkerBackend>;
  close(reason: string): Promise<void>;
}

export interface SandboxBackend {
  readonly report: CapabilityReport;
  openTask(input: { readonly taskId: string; readonly sandboxId: string; readonly budget: ResourceBudget }): Promise<TaskSandboxBackend>;
}

export interface SupervisorTaskInput {
  readonly taskId: string;
  readonly sandboxId: string;
  readonly policyVersion: string;
  readonly authorizationEpoch: number;
  readonly revocationVersion: number;
  readonly ticketPublicKey: string;
  readonly budget: ResourceBudget;
  readonly audit: SecurityAuditTaskResource;
}

export interface AuthorizedActionRequest {
  readonly ticket: CapabilityTicket;
  readonly call: ToolCallRequest;
}

export class RunnerSupervisor {
  readonly runnerId: string;

  constructor(
    private readonly session: AuthenticatedRunnerSession,
    private readonly backend: SandboxBackend,
    private readonly createId: () => string,
    private readonly now: () => number = Date.now,
  ) {
    if (session.runnerIdentity !== backend.report.runnerId) throw new Error('RUNNER_CAPABILITY_REPORT_IDENTITY_MISMATCH');
    if (backend.report.capabilities.length === 0) throw new Error('SANDBOX_UNCERTIFIED');
    this.runnerId = session.runnerIdentity;
  }

  async openTask(input: SupervisorTaskInput): Promise<SupervisorTask> {
    const sandbox = await this.backend.openTask({ taskId: input.taskId, sandboxId: input.sandboxId, budget: input.budget });
    return new SupervisorTask(
      this.runnerId, input, sandbox, this.createId, this.now,
    );
  }
}

export class SupervisorTask {
  private readonly verifier: CapabilityTicketVerifier;
  private readonly nonces: TaskNonceStore;
  private readonly processes = new TaskProcessRegistry();
  private closed = false;

  constructor(
    private readonly runnerId: string,
    private readonly input: SupervisorTaskInput,
    private readonly sandbox: TaskSandboxBackend,
    private readonly createId: () => string,
    private readonly now: () => number,
  ) {
    this.verifier = new CapabilityTicketVerifier(input.ticketPublicKey, now);
    this.nonces = new TaskNonceStore(input.taskId, input.revocationVersion, now);
  }

  async execute(request: AuthorizedActionRequest, signal: AbortSignal, onWorkerStart?: () => void): Promise<ToolCallResult> {
    if (this.closed) return denied(request.call, 'TICKET_REVOKED', 'Task sandbox is closed');
    const actionDigest = executionActionDigest(request.call);
    const normalized = normalizeToolCall(request.call, actionDigest);
    if (normalized === undefined) throw new SecurityIntegrityFailureError('RUNNER_NORMALIZATION_FAILED', 'Runner could not normalize the authorized action');
    const capabilityDigest = executionCapabilityDigest(normalized);
    let ticket: CapabilityTicket;
    try {
      ticket = this.verifier.verify(request.ticket, {
        runnerId: this.runnerId,
        sandboxId: this.input.sandboxId,
        taskId: this.input.taskId,
        runId: request.ticket.runId,
        callId: request.call.callId,
        actionDigest,
        capabilityDigest,
        policyVersion: this.input.policyVersion,
        revocationVersion: request.ticket.revocationVersion,
        authorizationEpoch: this.input.authorizationEpoch,
      });
    } catch (error) {
      if (error instanceof CapabilityTicketDeniedError) return denied(request.call, error.code, error.message);
      throw error;
    }
    try {
      await this.input.audit.append([this.auditRecord(ticket)]);
    } catch {
      throw new SecurityIntegrityFailureError('SUPERVISOR_AUDIT_FAILED', 'Supervisor audit failed before nonce consumption');
    }
    try {
      this.nonces.consume(ticket);
    } catch (error) {
      if (error instanceof CapabilityTicketDeniedError) return denied(request.call, error.code, error.message);
      throw error;
    }
    const profile = deriveActionSandboxProfile(normalized, this.input.budget);
    onWorkerStart?.();
    const worker = await this.sandbox.openWorker({
      taskId: this.input.taskId,
      runId: ticket.runId,
      call: structuredClone(request.call),
      action: normalized,
      profile,
    });
    try {
      const outcome = await worker.execute(signal);
      if (outcome.taskProcess !== undefined) this.processes.register(outcome.taskProcess);
      await worker.close('action_completed');
      return outcome.result;
    } catch (error) {
      await worker.close(signal.aborted ? 'cancelled' : 'failed');
      throw error;
    }
  }

  revoke(): number { return this.nonces.revoke(); }

  async close(reason: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.nonces.close();
    const outcomes = await Promise.allSettled([this.processes.close(), this.sandbox.close(reason)]);
    const errors = outcomes.filter((item): item is PromiseRejectedResult => item.status === 'rejected').map((item) => item.reason);
    if (errors.length > 0) throw new AggregateError(errors, 'Failed to close Supervisor Task');
  }

  private auditRecord(ticket: CapabilityTicket): SecurityAuditRecord {
    return Object.freeze({
      schemaVersion: 1,
      eventId: `audit-event:${this.createId()}`,
      occurredAt: this.now(),
      phase: 'supervisor',
      taskId: this.input.taskId,
      runId: ticket.runId,
      callId: ticket.callId,
      actionSummary: 'sandbox action',
      ticketId: ticket.ticketId,
      sandboxBackend: this.runnerId,
      outcome: 'allowed',
    });
  }
}

function denied(call: ToolCallRequest, code: string, message: string): ToolCallResult {
  return {
    callId: call.callId,
    providerCallId: call.providerCallId,
    toolName: call.name,
    isError: true,
    content: { summary: message, error: { code, message, retryable: true } },
  };
}
