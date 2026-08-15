import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ConversationManager } from '../../src/engine/conversation-manager.js';
import { InMemoryConversationStore } from '../../src/memory/conversation-store.js';
import {
  ActionGatewayImpl,
  SecurityIntegrityFailureError,
  type ActionRunnerTaskResource,
  type ModelProviderTaskResource,
  type OpenActionTaskInput,
  type SecurityAuditParticipant,
  type SecurityAuditRecord,
  type SecurityAuditTaskResource,
} from '../../src/security/index.js';
import type { ModelExchangeResponse, RuntimeStateContext, ToolDefinition, ToolExecutor } from '../../src/shared/types.js';
import { FakeLlmClient, fakeProfile } from '../fixtures/fake-llm-client.js';
import { DeterministicClock, DeterministicIds, noToolsTask } from '../fixtures/security-harness.js';

const runtime: RuntimeStateContext = { type: 'agent_state', mode: 'react', iterationLimit: 10 };
const readTool: ToolDefinition = {
  name: 'read_file', purpose: 'read', useWhen: ['read'], avoidWhen: ['write'],
  inputSchema: { type: 'object' }, resultSchema: { type: 'object' }, worksWith: [], executionMode: 'read_shared',
};

describe('durable audit barriers', () => {
  it('does not invoke Runner when the batch preflight audit fails', async () => {
    const setup = createSetup(1);
    const task = await setup.gateway.openTask(taskInput('task-1'));
    const proposal = await proposeRead(task, setup.provider);
    await expect(task.performActionBatch(
      task.prepareActionBatch('run-1', proposal),
      new AbortController().signal,
    )).rejects.toMatchObject<Partial<SecurityIntegrityFailureError>>({
      code: 'PREFLIGHT_AUDIT_FAILED', effectsMayHaveOccurred: false,
    });
    expect(setup.runner.execute).not.toHaveBeenCalled();
    expect(setup.audit.resource.appendCalls).toHaveLength(1);
    expect(setup.audit.resource.appendCalls[0]).toHaveLength(1);
  });

  it('withholds an executed result and terminates the Task when outcome audit fails', async () => {
    const setup = createSetup(2);
    const executor: ToolExecutor = {
      definitions: () => [readTool],
      execute: async () => { throw new Error('host executor must remain unreachable'); },
    };
    const manager = new ConversationManager(
      new FakeLlmClient(fakeProfile, []),
      new InMemoryConversationStore(),
      {
        maxTokens: 100, actionGateway: setup.gateway, availableTools: executor.definitions('all'), workspaceRoot: process.cwd(),
        createTaskId: () => 'task-1', createRunId: () => 'run-1', createTurnId: () => 'turn-1',
      },
    );
    const events = [];
    for await (const event of manager.submit({ mode: 'react', content: 'read package metadata' })) events.push(event);

    expect(setup.runner.execute).toHaveBeenCalledOnce();
    expect(setup.provider.resource.exchanges).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'task_state', state: 'security_integrity_failure',
      summary: expect.stringContaining('效果可能已经发生'),
      effectsMayHaveOccurred: true,
    }));
    expect(events.at(-1)).toMatchObject({ type: 'turn_error', error: { code: 'OUTCOME_AUDIT_FAILED' } });
    expect(events.some((event) => event.type === 'tool_call_complete')).toBe(false);
    expect(setup.audit.resource.closeReasons).toEqual(['security_integrity_failure']);
  });

  it('hard-denies a registered security-internal target before Runner execution', async () => {
    const setup = createSetup();
    const target = resolve('package.json');
    setup.provider.resource.calls = [{ callId: 'call-1', providerCallId: 'provider-1', name: 'read_file', input: { path: target } }];
    const task = await setup.gateway.openTask({ ...taskInput('task-1'), securityInternalRoots: [target] });
    const proposal = await proposeRead(task, setup.provider);
    const outcome = await task.performActionBatch(
      task.prepareActionBatch('run-1', proposal),
      new AbortController().signal,
    );
    expect(setup.runner.execute).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      kind: 'business',
      batch: { results: [{ isError: true, content: { error: { code: 'SECURITY_INTERNAL_RESOURCE' } } }] },
    });
  });

  it('never serializes prompt, path, command, output, or credential content into audit records', async () => {
    const setup = createSetup();
    setup.runner.resultContent = {
      summary: 'stdout=stdout-canary stderr=stderr-canary api_key=short-canary',
      data: { prompt: 'prompt-canary', path: 'path-canary', command: 'command-canary' },
    };
    const task = await setup.gateway.openTask(taskInput('task-1'));
    const proposal = await proposeRead(task, setup.provider);
    await expect(task.performActionBatch(
      task.prepareActionBatch('run-1', proposal),
      new AbortController().signal,
    )).rejects.toThrow('CREDENTIAL_DATA_BLOCKED');
    const serialized = JSON.stringify(setup.audit.resource.appendCalls);
    for (const canary of [
      'prompt-canary', 'path-canary', 'command-canary', 'stdout-canary', 'stderr-canary', 'short-canary', 'package.json',
    ]) expect(serialized).not.toContain(canary);
  });

  it('keeps Runner at zero after HITL allow when the durable decision audit fails', async () => {
    const setup = createSetup(1);
    const task = await setup.gateway.openTask({
      ...taskInput('task-1'),
      permissionMode: 'supervised',
      permissionRules: [{
        schemaVersion: 1, id: 'ask-read', effect: 'ask', source: 'user', target: { capability: 'FilesystemRead' },
      }],
    });
    const proposal = await proposeRead(task, setup.provider);
    let requested!: import('../../src/shared/types.js').AuthorizationRequestView;
    let publish!: () => void;
    const published = new Promise<void>((resolve) => { publish = resolve; });
    const executing = task.performActionBatch(
      task.prepareActionBatch('run-1', proposal),
      new AbortController().signal,
      0,
      { onAuthorizationRequested: (request) => { requested = request; publish(); } },
    );
    await published;
    task.resolveAuthorization({
      taskId: requested.taskId, runId: requested.runId,
      authorizationRequestId: requested.authorizationRequestId,
      authorizationEpoch: requested.authorizationEpoch,
      decisions: requested.items.map((item) => ({ actionDigest: item.actionDigest, choice: 'allow_once' })),
    });
    await expect(executing).rejects.toMatchObject({ code: 'HITL_AUDIT_FAILED' });
    expect(setup.runner.execute).not.toHaveBeenCalled();
  });

  it('flushes eight ordinary read preflight records once while preserving per-action correlation', async () => {
    const setup = createSetup();
    setup.provider.resource.calls = Array.from({ length: 8 }, (_, index) => ({
      callId: `call-${index}`, providerCallId: `provider-${index}`, name: 'read_file', input: { path: 'package.json' },
    }));
    const task = await setup.gateway.openTask(taskInput('task-1'));
    const proposal = await proposeRead(task, setup.provider);
    await task.performActionBatch(task.prepareActionBatch('run-1', proposal), new AbortController().signal);
    expect(setup.audit.resource.appendCalls[0]).toHaveLength(8);
    expect(new Set(setup.audit.resource.appendCalls[0]!.map((record) => record.callId))).toHaveProperty('size', 8);
    expect(setup.runner.execute).toHaveBeenCalledOnce();
  });
});

function createSetup(failOnAppend?: number) {
  const ids = new DeterministicIds();
  const clock = new DeterministicClock(1_700_000_000_000);
  const provider = new ScriptedProvider();
  const runner = new RunnerParticipant();
  const audit = new FailingAuditParticipant(failOnAppend);
  const gateway = new ActionGatewayImpl({ provider, runner, audit, createId: ids.next, now: clock.now });
  return { gateway, provider, runner, audit };
}

function taskInput(taskId: string): OpenActionTaskInput {
  return {
    ...noToolsTask(taskId), toolsEnabled: true, permissionMode: 'read_only', workspaceRoot: process.cwd(),
    modelDestination: {
      profile: fakeProfile.name, protocol: fakeProfile.protocol, model: fakeProfile.model,
      origin: 'https://provider.invalid', credentialRef: 'credential:test',
    },
    modelContext: { messages: [], currentUserInput: 'read package metadata', maxTokens: 100 },
  };
}

async function proposeRead(task: Awaited<ReturnType<ActionGatewayImpl['openTask']>>, _provider: ScriptedProvider): Promise<string> {
  const response = await task.performModelExchange(
    task.prepareModelExchange({ runId: 'run-1', iteration: 1, runtime, businessTools: [readTool] }),
    new AbortController().signal,
  );
  return response.proposalBatch!.proposalBatchRef;
}

class ScriptedProvider {
  readonly resource = new ScriptedProviderResource();
  async openTask(): Promise<ModelProviderTaskResource> { return this.resource; }
}

class ScriptedProviderResource implements ModelProviderTaskResource {
  readonly exchanges: unknown[] = [];
  calls: ModelExchangeResponse['calls'] = [
    { callId: 'call-1', providerCallId: 'provider-1', name: 'read_file', input: { path: 'package.json' } },
  ];
  async exchange(input: unknown): Promise<ModelExchangeResponse> {
    this.exchanges.push(input);
    return {
      text: '', calls: this.calls, completion: { type: 'stream_complete', finishReason: 'stop' },
      audit: {
        promptVersion: 'test', stableHash: 'stable', assemblyHash: 'assembly', modules: [], fragments: [],
        protocol: fakeProfile.protocol, model: fakeProfile.model,
      },
    };
  }
  async close(): Promise<void> {}
}

class RunnerParticipant {
  resultContent: { readonly summary: string; readonly data?: unknown } = { summary: 'read complete', data: { bytes: 10 } };
  readonly execute = vi.fn<ActionRunnerTaskResource['execute']>(async (calls, _signal, previousCalls = 0) => ({
    results: calls.map((call) => ({
      callId: call.callId, providerCallId: call.providerCallId, toolName: call.name, isError: false,
      content: this.resultContent,
    })),
    totalCalls: previousCalls + calls.length,
    businessToolLimitReached: false,
  }));
  async openTask(): Promise<ActionRunnerTaskResource> {
    return { definitions: () => [readTool], execute: this.execute, close: async () => undefined };
  }
}

class FailingAuditParticipant implements SecurityAuditParticipant {
  readonly resource: FailingAuditResource;
  constructor(failOnAppend?: number) { this.resource = new FailingAuditResource(failOnAppend); }
  async openTask(): Promise<SecurityAuditTaskResource> { return this.resource; }
}

class FailingAuditResource implements SecurityAuditTaskResource {
  readonly appendCalls: SecurityAuditRecord[][] = [];
  readonly closeReasons: string[] = [];
  constructor(private readonly failOnAppend?: number) {}
  async append(records: readonly SecurityAuditRecord[]): Promise<void> {
    this.appendCalls.push(structuredClone(records));
    if (this.appendCalls.length === this.failOnAppend) throw new Error('disk unavailable');
  }
  async close(reason: string): Promise<void> { this.closeReasons.push(reason); }
}
