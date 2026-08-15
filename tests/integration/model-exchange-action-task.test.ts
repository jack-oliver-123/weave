import { describe, expect, it } from 'vitest';
import {
  ActionGatewayImpl,
  ActionTaskClosedError,
  type ModelProviderTaskResource,
  type OpenActionTaskInput,
} from '../../src/security/index.js';
import type { ModelExchangeResponse, RuntimeStateContext, ToolDefinition } from '../../src/shared/types.js';
import { createSecurityHarness, FakeTaskParticipant, noToolsTask } from '../fixtures/security-harness.js';

const runtime: RuntimeStateContext = { type: 'agent_state', mode: 'react', iterationLimit: 10 };
const controlTool: ToolDefinition = {
  name: 'complete_task', purpose: '完成任务', useWhen: ['完成时'], avoidWhen: ['未完成时'],
  inputSchema: { type: 'object' }, resultSchema: { type: 'object' }, worksWith: [], executionMode: 'write_exclusive',
};
const writeTool: ToolDefinition = {
  name: 'edit_file', purpose: 'write', useWhen: ['write'], avoidWhen: ['read'],
  inputSchema: { type: 'object' }, resultSchema: { type: 'object' }, worksWith: [], executionMode: 'write_exclusive',
};
const readTool: ToolDefinition = {
  name: 'read_file', purpose: 'read', useWhen: ['read'], avoidWhen: ['write'],
  inputSchema: {}, resultSchema: {}, worksWith: [], executionMode: 'read_shared',
};

describe('ActionTask model exchange', () => {
  it('consumes a task-bound ref once and keeps the fixed destination outside AgentLoop', async () => {
    const harness = createSecurityHarness();
    const provider = new FakeModelProvider();
    const gateway = new ActionGatewayImpl({
      provider,
      runner: harness.runner,
      audit: harness.audit,
      createId: harness.ids.next,
      now: harness.clock.now,
    });
    const task = await gateway.openTask(modelTask('task-1'));
    const request = task.prepareModelExchange({ runId: 'run-1', iteration: 1, runtime, tools: [controlTool] });

    expect(request).toEqual({
      schemaVersion: 1,
      type: 'model_exchange',
      taskId: 'task-1',
      runId: 'run-1',
      requestId: 'test-id-3',
      modelExchangeRef: 'test-id-4',
    });
    const response = await task.performModelExchange(request, new AbortController().signal);

    expect(response.text).toBe('完成');
    expect(response).not.toHaveProperty('calls');
    expect(JSON.stringify(response)).not.toContain('"result":');
    expect(response.proposalBatch?.actions).toEqual([{
      callId: 'call-1',
      toolName: 'complete_task',
      actionDigest: expect.any(String),
      kind: 'control',
      summary: expect.any(String),
    }]);
    expect(provider.resource.exchanges[0]).toMatchObject({
      destination: {
        profile: 'fixed-profile', protocol: 'anthropic-messages', model: 'fixed-model',
        origin: 'https://provider.example',
      },
      messages: [{ role: 'user', content: expect.stringContaining('"trust":"untrusted_context"') }],
      tools: [{ name: 'complete_task' }],
    });
    await expect(task.performModelExchange(request, new AbortController().signal))
      .rejects.toThrow('MODEL_EXCHANGE_REF_INVALID');

    await task.close('completed');
    expect(() => task.prepareModelExchange({ runId: 'run-2', iteration: 1, runtime, tools: [] }))
      .toThrow(ActionTaskClosedError);
  });

  it('binds a proposal ref to its run and consumes it exactly once', async () => {
    const harness = createSecurityHarness();
    const gateway = new ActionGatewayImpl({
      provider: new FakeModelProvider(),
      runner: harness.runner,
      audit: harness.audit,
      createId: harness.ids.next,
      now: harness.clock.now,
    });
    const task = await gateway.openTask(modelTask('task-1'));
    const response = await task.performModelExchange(
      task.prepareModelExchange({ runId: 'run-1', iteration: 1, runtime, controlTools: [controlTool] }),
      new AbortController().signal,
    );
    const ref = response.proposalBatch?.proposalBatchRef;
    expect(ref).toBeDefined();

    await expect(task.performActionBatch(
      task.prepareActionBatch('run-2', ref!),
      new AbortController().signal,
    )).rejects.toThrow('PROPOSAL_BATCH_REF_INVALID');
    await expect(task.performActionBatch(
      task.prepareActionBatch('run-1', 'tampered-ref'),
      new AbortController().signal,
    )).rejects.toThrow('PROPOSAL_BATCH_REF_INVALID');

    const outcome = await task.performActionBatch(
      task.prepareActionBatch('run-1', ref!),
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({ kind: 'control', calls: [{ name: 'complete_task' }] });
    await expect(task.performActionBatch(
      task.prepareActionBatch('run-1', ref!),
      new AbortController().signal,
    )).rejects.toThrow('PROPOSAL_BATCH_REF_INVALID');
  });

  it('expires an unconsumed proposal ref', async () => {
    const harness = createSecurityHarness();
    const gateway = new ActionGatewayImpl({
      provider: new FakeModelProvider(),
      runner: harness.runner,
      audit: harness.audit,
      createId: harness.ids.next,
      now: harness.clock.now,
    });
    const task = await gateway.openTask(modelTask('task-1'));
    const response = await task.performModelExchange(
      task.prepareModelExchange({ runId: 'run-1', iteration: 1, runtime, controlTools: [controlTool] }),
      new AbortController().signal,
    );
    harness.clock.advance(60_001);

    await expect(task.performActionBatch(
      task.prepareActionBatch('run-1', response.proposalBatch!.proposalBatchRef),
      new AbortController().signal,
    )).rejects.toThrow('PROPOSAL_BATCH_REF_INVALID');
  });

  it('invalidates an old proposal when new natural language advances the authorization epoch', async () => {
    const harness = createSecurityHarness();
    const gateway = new ActionGatewayImpl({
      provider: new FakeModelProvider(), runner: harness.runner, audit: harness.audit,
      createId: harness.ids.next, now: harness.clock.now,
    });
    const task = await gateway.openTask(modelTask('task-1'));
    const response = await task.performModelExchange(
      task.prepareModelExchange({ runId: 'run-1', iteration: 1, runtime, controlTools: [controlTool] }),
      new AbortController().signal,
    );
    task.appendUserInput('new task direction');

    await expect(task.performActionBatch(
      task.prepareActionBatch('run-1', response.proposalBatch!.proposalBatchRef),
      new AbortController().signal,
    )).rejects.toThrow('PROPOSAL_BATCH_REF_INVALID');
  });

  it('rejects a proposal for a tool removed by the permission intersection', async () => {
    const harness = createSecurityHarness();
    const provider = new FakeModelProvider();
    provider.resource.calls = [{
      callId: 'call-write', providerCallId: 'provider-write', name: 'edit_file', input: { path: 'secret.txt' },
    }];
    const runner = new FakeTaskParticipant('runner', [writeTool]);
    const gateway = new ActionGatewayImpl({
      provider,
      runner,
      audit: harness.audit,
      createId: harness.ids.next,
      now: harness.clock.now,
    });
    const task = await gateway.openTask({ ...modelTask('task-1'), toolsEnabled: true });
    const response = await task.performModelExchange(
      task.prepareModelExchange({ runId: 'run-1', iteration: 1, runtime, businessTools: [writeTool] }),
      new AbortController().signal,
    );

    expect(provider.resource.exchanges[0]?.tools).toEqual([]);
    const outcome = await task.performActionBatch(
      task.prepareActionBatch('run-1', response.proposalBatch!.proposalBatchRef),
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({
      kind: 'business',
      batch: { results: [{ content: { error: { code: 'TOOL_NOT_AVAILABLE' } } }] },
    });
    expect(runner.resources[0]?.executionCalls).toEqual([]);
  });

  it('treats an unknown tool as a write barrier while preserving earlier results', async () => {
    const harness = createSecurityHarness();
    const provider = new FakeModelProvider();
    provider.resource.calls = [
      { callId: 'call-before', providerCallId: 'provider-before', name: 'read_file', input: { path: 'before.txt' } },
      { callId: 'call-unknown', providerCallId: 'provider-unknown', name: 'missing_tool', input: {} },
      { callId: 'call-after', providerCallId: 'provider-after', name: 'read_file', input: { path: 'after.txt' } },
    ];
    const executed: string[] = [];
    const runner = {
      async openTask() {
        return {
          securityContext: { runnerId: 'runner-1', sandboxId: 'sandbox-1' },
          definitions: () => [readTool],
          execute: async () => ({ results: [], totalCalls: 0, businessToolLimitReached: false }),
          executeAuthorized: async (actions: readonly { call: import('../../src/shared/types.js').ToolCallRequest; issueTicket: () => unknown }[]) => ({
            results: actions.map((action) => {
              action.issueTicket();
              executed.push(action.call.callId);
              return {
                callId: action.call.callId,
                providerCallId: action.call.providerCallId,
                toolName: action.call.name,
                isError: false,
                content: { summary: 'read complete' },
              };
            }),
            totalCalls: actions.length,
            businessToolLimitReached: false,
          }),
          close: async () => undefined,
        };
      },
    };
    const gateway = new ActionGatewayImpl({
      provider, runner, audit: harness.audit, createId: harness.ids.next, now: harness.clock.now,
    });
    const task = await gateway.openTask({ ...modelTask('task-1'), toolsEnabled: true });
    const response = await task.performModelExchange(
      task.prepareModelExchange({ runId: 'run-1', iteration: 1, runtime, businessTools: [readTool] }),
      new AbortController().signal,
    );
    const outcome = await task.performActionBatch(
      task.prepareActionBatch('run-1', response.proposalBatch!.proposalBatchRef),
      new AbortController().signal,
    );

    expect(executed).toEqual(['call-before']);
    expect(outcome).toMatchObject({
      kind: 'business',
      batch: {
        results: [
          { callId: 'call-before', isError: false },
          { callId: 'call-unknown', content: { error: { code: 'UNKNOWN_TOOL' } } },
          { callId: 'call-after', content: { error: { code: 'PRIOR_WRITE_FAILED' } } },
        ],
      },
    });
  });

  it('suspends a supervised batch, resumes it once, and reuses a narrow task grant', async () => {
    const harness = createSecurityHarness();
    const provider = new FakeModelProvider();
    provider.resource.calls = [{
      callId: 'call-write', providerCallId: 'provider-write', name: 'edit_file', input: { path: 'src/a.ts' },
    }];
    const runner = new FakeTaskParticipant('runner', [writeTool]);
    const gateway = new ActionGatewayImpl({
      provider, runner, audit: harness.audit, createId: harness.ids.next, now: harness.clock.now,
    });
    const task = await gateway.openTask({
      ...modelTask('task-1'), permissionMode: 'supervised', toolsEnabled: true,
      pathBoundary: { readRoots: ['.'], writeRoots: ['.'] },
    });
    const response = await task.performModelExchange(
      task.prepareModelExchange({ runId: 'run-1', iteration: 1, runtime, businessTools: [writeTool] }),
      new AbortController().signal,
    );
    let requested!: import('../../src/shared/types.js').AuthorizationRequestView;
    let publish!: () => void;
    const published = new Promise<void>((resolve) => { publish = resolve; });
    const performing = task.performActionBatch(
      task.prepareActionBatch('run-1', response.proposalBatch!.proposalBatchRef),
      new AbortController().signal,
      0,
      { onAuthorizationRequested: (request) => { requested = request; publish(); } },
    );
    await published;
    expect(runner.resources[0]?.executionCalls).toEqual([]);
    task.resolveAuthorization({
      taskId: requested.taskId,
      runId: requested.runId,
      authorizationRequestId: requested.authorizationRequestId,
      authorizationEpoch: requested.authorizationEpoch,
      decisions: requested.items.map((item) => ({ actionDigest: item.actionDigest, choice: 'allow_for_task' })),
    });
    await expect(performing).resolves.toMatchObject({ kind: 'business' });
    expect(runner.resources[0]?.executionCalls).toHaveLength(1);

    const repeated = await task.performModelExchange(
      task.prepareModelExchange({ runId: 'run-1', iteration: 2, runtime, businessTools: [writeTool] }),
      new AbortController().signal,
    );
    let askedAgain = false;
    await task.performActionBatch(
      task.prepareActionBatch('run-1', repeated.proposalBatch!.proposalBatchRef),
      new AbortController().signal,
      1,
      { onAuthorizationRequested: () => { askedAgain = true; } },
    );
    expect(askedAgain).toBe(false);
    expect(runner.resources[0]?.executionCalls).toHaveLength(2);
  });

  it('remembers an explicit denial but does not invoke Runner', async () => {
    const harness = createSecurityHarness();
    const provider = new FakeModelProvider();
    provider.resource.calls = [{
      callId: 'call-write', providerCallId: 'provider-write', name: 'edit_file', input: { path: 'src/a.ts' },
    }];
    const runner = new FakeTaskParticipant('runner', [writeTool]);
    const gateway = new ActionGatewayImpl({ provider, runner, audit: harness.audit, createId: harness.ids.next, now: harness.clock.now });
    const task = await gateway.openTask({
      ...modelTask('task-1'), permissionMode: 'supervised', toolsEnabled: true,
      pathBoundary: { readRoots: ['.'], writeRoots: ['.'] },
    });
    const first = await task.performModelExchange(
      task.prepareModelExchange({ runId: 'run-1', iteration: 1, runtime, businessTools: [writeTool] }),
      new AbortController().signal,
    );
    let request!: import('../../src/shared/types.js').AuthorizationRequestView;
    let publish!: () => void;
    const published = new Promise<void>((resolve) => { publish = resolve; });
    const performing = task.performActionBatch(
      task.prepareActionBatch('run-1', first.proposalBatch!.proposalBatchRef),
      new AbortController().signal,
      0,
      { onAuthorizationRequested: (value) => { request = value; publish(); } },
    );
    await published;
    task.resolveAuthorization({
      ...request,
      decisions: request.items.map((item) => ({ actionDigest: item.actionDigest, choice: 'deny' })),
    });
    await expect(performing).resolves.toMatchObject({
      kind: 'business', batch: { results: [{ content: { error: { code: 'PERMISSION_DENIED' } } }] },
    });
    expect(runner.resources[0]?.executionCalls).toEqual([]);

    const repeated = await task.performModelExchange(
      task.prepareModelExchange({ runId: 'run-1', iteration: 2, runtime, businessTools: [writeTool] }),
      new AbortController().signal,
    );
    await expect(task.performActionBatch(
      task.prepareActionBatch('run-1', repeated.proposalBatch!.proposalBatchRef),
      new AbortController().signal,
    )).resolves.toMatchObject({
      kind: 'business', batch: { results: [{ content: { error: { code: 'PREVIOUSLY_DENIED' } } }] },
    });
  });

  it('stores model/control history inside the task and destroys it on close', async () => {
    const harness = createSecurityHarness();
    const provider = new FakeModelProvider();
    const gateway = new ActionGatewayImpl({
      provider,
      runner: harness.runner,
      audit: harness.audit,
      createId: harness.ids.next,
      now: harness.clock.now,
    });
    const task = await gateway.openTask(modelTask('task-1'));
    const first = task.prepareModelExchange({ runId: 'run-1', iteration: 1, runtime, tools: [controlTool] });
    await task.performModelExchange(first, new AbortController().signal);
    await task.appendResults([{
      callId: 'call-1', providerCallId: 'provider-1', toolName: 'complete_task', isError: true,
      content: { summary: '参数错误', error: { code: 'INVALID_CONTROL_INPUT', message: '参数错误', retryable: false } },
    }]);
    const second = task.prepareModelExchange({ runId: 'run-1', iteration: 2, runtime, tools: [controlTool] });
    await task.performModelExchange(second, new AbortController().signal);

    expect(provider.resource.exchanges[1]?.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool']);
    await task.close('completed');
    expect(provider.resource.closeCount).toBe(1);
    expect(() => task.appendUserInput('关闭后输入')).toThrow(ActionTaskClosedError);
  });

  it('keeps a sensitive tool result private and gives the model a content-free disclosure denial', async () => {
    const harness = createSecurityHarness();
    const provider = new FakeModelProvider();
    const gateway = new ActionGatewayImpl({ provider, runner: harness.runner, audit: harness.audit, createId: harness.ids.next, now: harness.clock.now });
    const task = await gateway.openTask(modelTask('task-1'));
    await task.performModelExchange(
      task.prepareModelExchange({ runId: 'run-1', iteration: 1, runtime, tools: [controlTool] }),
      new AbortController().signal,
    );
    await task.appendResults([{
      callId: 'call-sensitive', providerCallId: 'provider-sensitive', toolName: 'read_file', isError: false,
      content: { summary: 'WEAVE_SENSITIVE:private-result' },
    }]);
    await task.performModelExchange(
      task.prepareModelExchange({ runId: 'run-1', iteration: 2, runtime, tools: [controlTool] }),
      new AbortController().signal,
    );

    const sent = JSON.stringify(provider.resource.exchanges[1]?.messages);
    expect(sent).not.toContain('private-result');
    expect(sent).toContain('DATA_DISCLOSURE_DENIED');
  });

  it('releases a sensitive tool result only after destination-bound disclosure authorization', async () => {
    const harness = createSecurityHarness();
    const provider = new FakeModelProvider();
    const gateway = new ActionGatewayImpl({
      provider,
      runner: harness.runner,
      audit: harness.audit,
      createId: harness.ids.next,
      now: harness.clock.now,
    });
    const task = await gateway.openTask({ ...modelTask('task-1'), permissionMode: 'supervised' });
    const requests: import('../../src/shared/types.js').AuthorizationRequestView[] = [];
    const terminalResults = await task.appendResults([{
      callId: 'call-sensitive', providerCallId: 'provider-sensitive', toolName: 'read_file', isError: false,
      content: { summary: 'WEAVE_SENSITIVE:authorized-result' },
    }], 'run-1', { onAuthorizationRequested: (request) => {
      requests.push(request);
      task.resolveAuthorization({
        ...request,
        decisions: [{
          actionDigest: request.items[0]!.actionDigest,
          choice: requests.length === 1 ? 'allow_once' : 'deny',
        }],
      });
    } });
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.items[0])).toEqual([
      expect.objectContaining({ toolName: 'data_disclose', capabilityTypes: ['DataDisclose'], summary: expect.stringContaining('模型') }),
      expect.objectContaining({ toolName: 'data_disclose', capabilityTypes: ['DataDisclose'], summary: expect.stringContaining('终端') }),
    ]);
    expect(terminalResults[0]).toMatchObject({ content: { error: { code: 'DATA_DISCLOSURE_DENIED' } } });
    await task.performModelExchange(
      task.prepareModelExchange({ runId: 'run-1', iteration: 1, runtime, tools: [controlTool] }),
      new AbortController().signal,
    );
    expect(JSON.stringify(provider.resource.exchanges[0]?.messages)).toContain('authorized-result');
    expect(harness.audit.resources[0]?.auditRecords.flat().map((record) => record.phase)).toEqual([
      'hitl', 'preflight', 'hitl', 'preflight',
    ]);
  });

  it('blocks credential-bearing model output before it can enter later exchanges', async () => {
    const harness = createSecurityHarness();
    const provider = new FakeModelProvider();
    provider.resource.text = 'ghp_1234567890abcdefghijklmnopqrst';
    const gateway = new ActionGatewayImpl({ provider, runner: harness.runner, audit: harness.audit, createId: harness.ids.next, now: harness.clock.now });
    const task = await gateway.openTask(modelTask('task-1'));

    await expect(task.performModelExchange(
      task.prepareModelExchange({ runId: 'run-1', iteration: 1, runtime, tools: [controlTool] }),
      new AbortController().signal,
    )).rejects.toThrow('CREDENTIAL_DATA_BLOCKED');
    provider.resource.text = '安全响应';
    await task.performModelExchange(
      task.prepareModelExchange({ runId: 'run-1', iteration: 2, runtime, tools: [controlTool] }),
      new AbortController().signal,
    );
    expect(JSON.stringify(provider.resource.exchanges[1]?.messages)).not.toContain('ghp_');
  });
});

function modelTask(taskId: string): OpenActionTaskInput {
  return {
    ...noToolsTask(taskId),
    modelDestination: {
      profile: 'fixed-profile', protocol: 'anthropic-messages', model: 'fixed-model',
      origin: 'https://provider.example', credentialRef: 'credential:test',
    },
    modelContext: {
      messages: [{ role: 'user', content: '执行任务' }],
      maxTokens: 256,
    },
  };
}

class FakeModelProvider {
  readonly resource = new FakeModelResource();

  async openTask(_input: OpenActionTaskInput): Promise<ModelProviderTaskResource> {
    return this.resource;
  }
}

class FakeModelResource implements ModelProviderTaskResource {
  readonly exchanges: any[] = [];
  closeCount = 0;
  text = '完成';
  calls: ModelExchangeResponse['calls'] = [
    { callId: 'call-1', providerCallId: 'provider-1', name: 'complete_task', input: { result: '完成' } },
  ];

  async exchange(input: any): Promise<ModelExchangeResponse> {
    this.exchanges.push(input);
    return {
      text: this.text,
      calls: this.calls,
      completion: { type: 'stream_complete', finishReason: 'stop' },
      audit: {
        promptVersion: 'test', stableHash: 'stable', assemblyHash: 'assembly', modules: [], fragments: [],
        protocol: 'anthropic-messages', model: 'fixed-model',
      },
    };
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}
