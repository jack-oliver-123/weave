import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import {
  buildCapabilityReport,
  defaultResourceBudget,
  EphemeralRunnerIdentity,
  openRunnerControlChannel,
  REQUIRED_SANDBOX_PROBES,
  RunnerSupervisor,
  RUNNER_PROTOCOL_VERSION,
  type ActionWorkerBackend,
  type ActionWorkerLaunchInput,
  type CapabilityReport,
  type SandboxBackend,
  type TaskSandboxBackend,
} from '../../src/runner/index.js';
import {
  CapabilityTicketIssuer,
  executionActionDigest,
  executionCapabilityDigest,
  normalizeToolCall,
  type SecurityAuditRecord,
} from '../../src/security/index.js';
import type { ToolCallRequest, ToolCallResult } from '../../src/shared/types.js';

const now = 1_700_000_000_000;
const call: ToolCallRequest = {
  callId: 'call-1', providerCallId: 'provider-1', name: 'read_file', input: { path: 'package.json' },
};

describe('Runner IPC control plane', () => {
  it('routes task control and the durable audit callback through an authenticated local pipe', async () => {
    const owner = userInfo().username;
    const runnerId = 'ipc-runner';
    const endpoint = {
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      transport: process.platform === 'win32' ? 'windows_named_pipe' as const : 'unix_socket' as const,
      address: process.platform === 'win32'
        ? `\\\\.\\pipe\\weave-${randomUUID()}`
        : `/tmp/weave-${randomUUID()}.sock`,
      ownerIdentity: owner,
      access: 'current_user_only' as const,
      tcpListening: false as const,
    };
    const backend = new FakeBackend(report(runnerId));
    const control = await openRunnerControlChannel({
      endpoint,
      expectedOwner: owner,
      hostIdentity: new EphemeralRunnerIdentity('host-ipc'),
      supervisorIdentity: new EphemeralRunnerIdentity(runnerId),
      createSupervisor: (session) => new RunnerSupervisor(session, backend, randomUUID, () => now),
    });
    const issuer = new CapabilityTicketIssuer();
    const audit = new FakeAudit();
    const task = await control.openTask({
      taskId: 'task-1', sandboxId: 'sandbox-1', policyVersion: 'policy-1', authorizationEpoch: 1,
      revocationVersion: 0, ticketPublicKey: issuer.publicKey,
      budget: defaultResourceBudget({ cpuCores: 8, memoryBytes: 16 * 1024 ** 3 }), audit,
    });
    const actionDigest = executionActionDigest(call);
    const action = normalizeToolCall(call, actionDigest)!;
    const ticket = issuer.issue({
      ticketId: 'ticket-1', runnerId, sandboxId: 'sandbox-1', taskId: 'task-1', runId: 'run-1',
      callId: call.callId, actionDigest, capabilityDigest: executionCapabilityDigest(action),
      policyVersion: 'policy-1', revocationVersion: 0, authorizationEpoch: 1,
      nonce: 'nonce-1', issuedAt: now, expiresAt: now + 30_000,
    });
    let started = false;
    const result = await task.execute({ ticket, call }, new AbortController().signal, () => { started = true; });

    expect(result.isError).toBe(false);
    expect(started).toBe(true);
    expect(audit.records).toHaveLength(1);
    expect(backend.task.launches).toHaveLength(1);
    expect(JSON.stringify(backend.task.launches[0])).not.toContain(endpoint.address);

    await task.close('completed');
    await control.dispose();
  });

  it('aborts active Workers and destroys the Task sandbox when the control pipe disconnects', async () => {
    const owner = userInfo().username;
    const runnerId = 'ipc-runner-disconnect';
    const endpoint = {
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      transport: process.platform === 'win32' ? 'windows_named_pipe' as const : 'unix_socket' as const,
      address: process.platform === 'win32'
        ? `\\\\.\\pipe\\weave-${randomUUID()}`
        : `/tmp/weave-${randomUUID()}.sock`,
      ownerIdentity: owner,
      access: 'current_user_only' as const,
      tcpListening: false as const,
    };
    const backend = new FakeBackend(report(runnerId));
    backend.task.hangWorkers = true;
    const control = await openRunnerControlChannel({
      endpoint,
      expectedOwner: owner,
      hostIdentity: new EphemeralRunnerIdentity('host-ipc-disconnect'),
      supervisorIdentity: new EphemeralRunnerIdentity(runnerId),
      createSupervisor: (session) => new RunnerSupervisor(session, backend, randomUUID, () => now),
    });
    const issuer = new CapabilityTicketIssuer();
    const task = await control.openTask({
      taskId: 'task-1', sandboxId: 'sandbox-1', policyVersion: 'policy-1', authorizationEpoch: 1,
      revocationVersion: 0, ticketPublicKey: issuer.publicKey,
      budget: defaultResourceBudget({ cpuCores: 8, memoryBytes: 16 * 1024 ** 3 }), audit: new FakeAudit(),
    });
    const actionDigest = executionActionDigest(call);
    const ticket = issuer.issue({
      ticketId: 'ticket-1', runnerId, sandboxId: 'sandbox-1', taskId: 'task-1', runId: 'run-1',
      callId: call.callId, actionDigest,
      capabilityDigest: executionCapabilityDigest(normalizeToolCall(call, actionDigest)!),
      policyVersion: 'policy-1', revocationVersion: 0, authorizationEpoch: 1,
      nonce: 'nonce-1', issuedAt: now, expiresAt: now + 30_000,
    });
    const execution = task.execute({ ticket, call }, new AbortController().signal);
    await backend.task.workerOpened;
    await control.dispose();

    await expect(execution).rejects.toMatchObject({ code: 'RUNNER_CONTROL_CHANNEL_LOST' });
    await vi.waitFor(() => {
      expect(backend.task.workerAborted).toBe(true);
      expect(backend.task.closeReasons).toContain('security_integrity_failure');
    });
  });
});

class FakeAudit {
  readonly records: SecurityAuditRecord[] = [];
  async append(records: readonly SecurityAuditRecord[]): Promise<void> { this.records.push(...structuredClone(records)); }
  async close(): Promise<void> {}
}

class FakeBackend implements SandboxBackend {
  readonly task = new FakeTaskSandbox();
  constructor(readonly report: CapabilityReport) {}
  async openTask(): Promise<TaskSandboxBackend> { return this.task; }
}

class FakeTaskSandbox implements TaskSandboxBackend {
  readonly launches: ActionWorkerLaunchInput[] = [];
  readonly closeReasons: string[] = [];
  hangWorkers = false;
  workerAborted = false;
  private resolveWorkerOpened!: () => void;
  readonly workerOpened = new Promise<void>((resolve) => { this.resolveWorkerOpened = resolve; });

  async openWorker(input: ActionWorkerLaunchInput): Promise<ActionWorkerBackend> {
    this.launches.push(structuredClone(input));
    this.resolveWorkerOpened();
    return new FakeWorker(input.call, this);
  }
  async close(reason: string): Promise<void> { this.closeReasons.push(reason); }
}

class FakeWorker implements ActionWorkerBackend {
  constructor(private readonly request: ToolCallRequest, private readonly owner: FakeTaskSandbox) {}
  async execute(signal: AbortSignal): Promise<{ result: ToolCallResult }> {
    if (this.owner.hangWorkers) {
      await new Promise<never>((_resolve, reject) => {
        const abort = () => {
          this.owner.workerAborted = true;
          reject(signal.reason ?? new Error('cancelled'));
        };
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
    }
    return {
      result: {
        callId: this.request.callId,
        providerCallId: this.request.providerCallId,
        toolName: this.request.name,
        isError: false,
        content: { summary: 'read complete' },
      },
    };
  }
  async close(): Promise<void> {}
}

function report(runnerId: string): CapabilityReport {
  return buildCapabilityReport({
    runnerId,
    backend: 'fake',
    backendVersion: '1',
    requestedCapabilities: ['FilesystemRead'],
    evidence: REQUIRED_SANDBOX_PROBES.map((probeId) => ({
      probeId,
      status: 'passed',
      commit: 'commit-1',
      os: 'test',
      backend: 'fake',
      backendVersion: '1',
      probeVersion: '1',
      evidenceDigest: `evidence:${probeId}`,
    })),
  });
}
