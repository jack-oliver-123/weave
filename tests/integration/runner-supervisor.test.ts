import { describe, expect, it, vi } from 'vitest';
import {
  authenticateRunnerSession,
  buildCapabilityReport,
  defaultResourceBudget,
  EphemeralRunnerIdentity,
  REQUIRED_SANDBOX_PROBES,
  RunnerSupervisor,
  RUNNER_PROTOCOL_VERSION,
  SupervisorActionRunnerParticipant,
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
  ActionGatewayImpl,
  type ModelProviderTaskResource,
  type OpenActionTaskInput,
  type SecurityAuditRecord,
  type SecurityAuditTaskResource,
} from '../../src/security/index.js';
import type { ModelExchangeResponse, RuntimeStateContext, ToolCallRequest, ToolCallResult, ToolDefinition } from '../../src/shared/types.js';

const now = 1_700_000_000_000;
const call: ToolCallRequest = {
  callId: 'call-1', providerCallId: 'provider-1', name: 'read_file', input: { path: 'package.json' },
};
const readTool: ToolDefinition = {
  name: 'read_file', purpose: 'read', useWhen: ['read'], avoidWhen: ['write'],
  inputSchema: { type: 'object' }, resultSchema: { type: 'object' }, worksWith: [], executionMode: 'read_shared',
};

describe('Runner Supervisor vertical boundary', () => {
  it('re-normalizes the action, audits before nonce consumption, and gives Worker no ticket or control channel', async () => {
    const setup = await createSetup();
    const ticket = issue(setup.issuer, call);
    const result = await setup.task.execute({ ticket, call }, new AbortController().signal);
    expect(result.isError).toBe(false);
    expect(setup.audit.records).toHaveLength(1);
    expect(setup.backend.task.launches).toHaveLength(1);
    const launch = setup.backend.task.launches[0]!;
    expect(launch.action).toEqual(normalizeToolCall(call, executionActionDigest(call)));
    expect(launch.profile).toMatchObject({ controlChannelVisible: false, ticketVisible: false, environment: {} });
    expect(JSON.stringify(launch)).not.toMatch(/ticketId|nonce|signature|policyVersion|audit-event/);
    expect(setup.backend.task.workers[0]?.closeReasons).toEqual(['action_completed']);
  });

  it('does not consume nonce or launch Worker when Supervisor audit fails', async () => {
    const setup = await createSetup();
    const ticket = issue(setup.issuer, call);
    setup.audit.fail = true;
    await expect(setup.task.execute({ ticket, call }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'SUPERVISOR_AUDIT_FAILED', effectsMayHaveOccurred: false });
    expect(setup.backend.task.launches).toEqual([]);
    setup.audit.fail = false;
    await expect(setup.task.execute({ ticket, call }, new AbortController().signal)).resolves.toMatchObject({ isError: false });
    expect(setup.backend.task.launches).toHaveLength(1);
  });

  it('detects replay and action tampering as integrity failures with zero extra Workers', async () => {
    const setup = await createSetup();
    const ticket = issue(setup.issuer, call);
    await setup.task.execute({ ticket, call }, new AbortController().signal);
    await expect(setup.task.execute({ ticket, call }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'TICKET_REPLAY' });
    const fresh = issue(setup.issuer, call, 'ticket-2', 'nonce-2');
    await expect(setup.task.execute({ ticket: fresh, call: { ...call, input: { path: 'src/main.ts' } } }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'TICKET_BINDING_MISMATCH' });
    expect(setup.backend.task.launches).toHaveLength(1);
  });

  it('maps normal expiry and revocation to ordinary denied results', async () => {
    const setup = await createSetup();
    const expired = issue(setup.issuer, call, 'ticket-expired', 'nonce-expired', now - 31_000, now - 1);
    await expect(setup.task.execute({ ticket: expired, call }, new AbortController().signal))
      .resolves.toMatchObject({ isError: true, content: { error: { code: 'TICKET_EXPIRED' } } });
    setup.task.revoke();
    const stale = issue(setup.issuer, call, 'ticket-stale', 'nonce-stale');
    await expect(setup.task.execute({ ticket: stale, call }, new AbortController().signal))
      .resolves.toMatchObject({ isError: true, content: { error: { code: 'TICKET_REVOKED' } } });
    expect(setup.backend.task.launches).toEqual([]);
  });

  it('kills retained Task process trees and closes the persistent sandbox on Task close', async () => {
    const setup = await createSetup();
    const killTree = vi.fn(async () => undefined);
    setup.backend.task.nextTaskProcess = { processId: 'process-1', killTree };
    await setup.task.execute({ ticket: issue(setup.issuer, call), call }, new AbortController().signal);
    await setup.task.close('completed');
    expect(killTree).toHaveBeenCalledWith('task_closed');
    expect(setup.backend.task.closeReasons).toEqual(['completed']);
  });

  it('refuses to start with an uncertified Capability Report', () => {
    const session = authenticatedSession();
    const report = reportWith('unknown');
    expect(() => new RunnerSupervisor(session, new FakeBackend(report), () => 'id', () => now)).toThrow('SANDBOX_UNCERTIFIED');
  });

  it('runs a Gateway proposal through preflight audit, signed ticket, Supervisor, Worker, and outcome audit', async () => {
    const audit = new FakeAudit();
    const backend = new FakeBackend(reportWith('passed'));
    let nextId = 0;
    const createId = () => `gateway-id-${++nextId}`;
    const supervisor = new RunnerSupervisor(authenticatedSession(), backend, createId, () => now);
    const runner = new SupervisorActionRunnerParticipant(
      supervisor, [readTool], defaultResourceBudget({ cpuCores: 8, memoryBytes: 16 * 1024 ** 3 }),
      () => 'sandbox-1', ['FilesystemRead'],
    );
    const provider = new SingleReadProvider();
    const gateway = new ActionGatewayImpl({
      provider, runner, audit: { openTask: async () => audit }, createId, now: () => now,
    });
    const task = await gateway.openTask(gatewayTaskInput());
    const runtime: RuntimeStateContext = { type: 'agent_state', mode: 'react', iterationLimit: 10 };
    const model = await task.performModelExchange(
      task.prepareModelExchange({ runId: 'run-1', iteration: 1, runtime, businessTools: [readTool] }),
      new AbortController().signal,
    );
    const outcome = await task.performActionBatch(
      task.prepareActionBatch('run-1', model.proposalBatch!.proposalBatchRef),
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({ kind: 'business', batch: { results: [{ isError: false }] } });
    expect(audit.records.map((record) => record.phase)).toEqual([
      'preflight', 'supervisor', 'outcome', 'preflight', 'preflight',
    ]);
    expect(audit.records.slice(-2)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actionSummary: 'Disclose tool result to model',
        capabilityTypes: ['DataDisclose'], classification: 'ordinary', outcome: 'allowed',
      }),
      expect.objectContaining({
        actionSummary: 'Disclose tool result to terminal',
        capabilityTypes: ['DataDisclose'], classification: 'ordinary', outcome: 'allowed',
      }),
    ]));
    expect(backend.task.launches).toHaveLength(1);
    expect(JSON.stringify(backend.task.launches[0])).not.toMatch(/ticketId|nonce|signature/);
  });
});

async function createSetup() {
  const issuer = new CapabilityTicketIssuer();
  const audit = new FakeAudit();
  const backend = new FakeBackend(reportWith('passed'));
  let nextId = 0;
  const supervisor = new RunnerSupervisor(authenticatedSession(), backend, () => `id-${++nextId}`, () => now);
  const task = await supervisor.openTask({
    taskId: 'task-1', sandboxId: 'sandbox-1', policyVersion: 'policy-1', authorizationEpoch: 1,
    revocationVersion: 0, ticketPublicKey: issuer.publicKey,
    budget: defaultResourceBudget({ cpuCores: 8, memoryBytes: 16 * 1024 ** 3 }), audit,
  });
  return { issuer, audit, backend, supervisor, task };
}

function issue(
  issuer: CapabilityTicketIssuer,
  request: ToolCallRequest,
  ticketId = 'ticket-1',
  nonce = 'nonce-1',
  issuedAt = now,
  expiresAt = now + 30_000,
) {
  const actionDigest = executionActionDigest(request);
  const action = normalizeToolCall(request, actionDigest)!;
  return issuer.issue({
    ticketId, runnerId: 'runner-1', sandboxId: 'sandbox-1', taskId: 'task-1', runId: 'run-1',
    callId: request.callId, actionDigest, capabilityDigest: executionCapabilityDigest(action),
    policyVersion: 'policy-1', revocationVersion: 0, authorizationEpoch: 1,
    nonce, issuedAt, expiresAt,
  });
}

function authenticatedSession() {
  const host = new EphemeralRunnerIdentity('host-1');
  const runner = new EphemeralRunnerIdentity('runner-1');
  return authenticateRunnerSession({
    endpoint: {
      protocolVersion: RUNNER_PROTOCOL_VERSION, transport: 'windows_named_pipe',
      address: '\\\\.\\pipe\\weave-runner-test', ownerIdentity: 'user-1',
      access: 'current_user_only', tcpListening: false,
    },
    expectedOwner: 'user-1',
    expectedHostIdentity: 'host-1', expectedRunnerIdentity: 'runner-1',
    hostProof: host.prove('host', 'supervisor-challenge-12345'), hostPublicKey: host.publicKey,
    supervisorProof: runner.prove('supervisor', 'host-challenge-123456789'), supervisorPublicKey: runner.publicKey,
  });
}

function reportWith(status: 'passed' | 'unknown'): CapabilityReport {
  return buildCapabilityReport({
    runnerId: 'runner-1', backend: 'fake', backendVersion: '1', requestedCapabilities: ['FilesystemRead'],
    evidence: REQUIRED_SANDBOX_PROBES.map((probeId) => ({
      probeId, status, commit: 'commit-1', os: 'test', backend: 'fake', backendVersion: '1',
      probeVersion: '1', evidenceDigest: `evidence:${probeId}`,
    })),
  });
}

class FakeAudit implements SecurityAuditTaskResource {
  records: SecurityAuditRecord[] = [];
  fail = false;
  async append(records: readonly SecurityAuditRecord[]): Promise<void> {
    if (this.fail) throw new Error('audit unavailable');
    this.records.push(...structuredClone(records));
  }
  async close(): Promise<void> {}
}

class FakeBackend implements SandboxBackend {
  readonly task = new FakeTaskSandbox();
  constructor(readonly report: CapabilityReport) {}
  async openTask(): Promise<TaskSandboxBackend> { return this.task; }
}

class FakeTaskSandbox implements TaskSandboxBackend {
  readonly launches: ActionWorkerLaunchInput[] = [];
  readonly workers: FakeWorker[] = [];
  readonly closeReasons: string[] = [];
  nextTaskProcess: import('../../src/runner/index.js').ManagedProcessTree | undefined;
  async openWorker(input: ActionWorkerLaunchInput): Promise<ActionWorkerBackend> {
    this.launches.push(structuredClone(input));
    const worker = new FakeWorker(this.nextTaskProcess);
    this.nextTaskProcess = undefined;
    this.workers.push(worker);
    return worker;
  }
  async close(reason: string): Promise<void> { this.closeReasons.push(reason); }
}

class FakeWorker implements ActionWorkerBackend {
  readonly closeReasons: string[] = [];
  constructor(private readonly taskProcess?: import('../../src/runner/index.js').ManagedProcessTree) {}
  async execute(): Promise<{ result: ToolCallResult; taskProcess?: import('../../src/runner/index.js').ManagedProcessTree }> {
    return {
      result: {
        callId: call.callId, providerCallId: call.providerCallId, toolName: call.name, isError: false,
        content: { summary: 'read complete' },
      },
      ...(this.taskProcess === undefined ? {} : { taskProcess: this.taskProcess }),
    };
  }
  async close(reason: 'action_completed' | 'cancelled' | 'failed'): Promise<void> { this.closeReasons.push(reason); }
}

class SingleReadProvider {
  readonly resource = new SingleReadProviderResource();
  async openTask(): Promise<ModelProviderTaskResource> { return this.resource; }
}

class SingleReadProviderResource implements ModelProviderTaskResource {
  async exchange(): Promise<ModelExchangeResponse> {
    return {
      text: '', calls: [call], completion: { type: 'stream_complete', finishReason: 'stop' },
      audit: {
        promptVersion: 'test', stableHash: 'stable', assemblyHash: 'assembly', modules: [], fragments: [],
        protocol: 'openai-responses', model: 'test-model',
      },
    };
  }
  async close(): Promise<void> {}
}

function gatewayTaskInput(): OpenActionTaskInput {
  return {
    schemaVersion: 1, taskId: 'task-1', policySnapshotId: 'policy-1', permissionMode: 'read_only',
    modelDestination: {
      profile: 'test', protocol: 'openai-responses', model: 'test-model',
      origin: 'https://provider.invalid', credentialRef: 'credential:test',
    },
    pathBoundary: { readRoots: ['.'], writeRoots: [] }, workspaceRoot: process.cwd(),
    authorizationEpoch: 1, toolsEnabled: true,
    modelContext: { messages: [], currentUserInput: 'read package metadata', maxTokens: 100 },
  };
}
