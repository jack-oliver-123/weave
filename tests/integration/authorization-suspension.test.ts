import { describe, expect, it, vi } from 'vitest';
import { ConversationBusyError, ConversationManager } from '../../src/engine/conversation-manager.js';
import { InMemoryConversationStore } from '../../src/memory/conversation-store.js';
import { SecurityIntegrityFailureError } from '../../src/security/index.js';
import type {
  LlmStreamEvent,
  ToolCallRequest,
  ToolDefinition,
  ToolExecutor,
  TurnEvent,
} from '../../src/shared/types.js';
import { FakeLlmClient, fakeProfile, openFakeActionTask } from '../fixtures/fake-llm-client.js';
import { createTestActionGateway } from '../fixtures/test-action-gateway.js';

const editDefinition: ToolDefinition = {
  name: 'edit_file', purpose: 'edit', useWhen: ['edit'], avoidWhen: ['read'],
  inputSchema: { type: 'object' }, resultSchema: { type: 'object' }, worksWith: [], executionMode: 'write_exclusive',
};
const start: LlmStreamEvent = { type: 'stream_start' };
const done: LlmStreamEvent = { type: 'stream_complete', finishReason: 'stop' };

describe('authorization suspension', () => {
  it('resumes the same run after an exact decision and performs no work while waiting', async () => {
    const editCall = call('edit_file', { path: 'src/a.ts' }, 1);
    const completeCall = call('complete_task', { result: 'done', verificationSummary: 'verified' }, 2);
    const client = new FakeLlmClient(fakeProfile, [
      [start, { type: 'tool_calls', calls: [editCall] }, done].map((event) => ({ event })),
      [start, { type: 'tool_calls', calls: [completeCall] }, done].map((event) => ({ event })),
    ]);
    const execute = vi.fn<ToolExecutor['execute']>(async (calls, _signal, previousCalls = 0) => ({
      results: calls.map((request) => ({
        callId: request.callId, providerCallId: request.providerCallId, toolName: request.name, isError: false,
        content: { summary: 'edited' },
      })),
      totalCalls: previousCalls + calls.length,
      businessToolLimitReached: false,
    }));
    const executor: ToolExecutor = { definitions: () => [editDefinition], execute };
    let gatewayId = 0;
    const manager = new ConversationManager(client, new InMemoryConversationStore(), {
      maxTokens: 100,
      actionGateway: createTestActionGateway(client, executor, { createId: () => `gateway-${++gatewayId}` }),
      availableTools: [editDefinition],
      permissionMode: 'supervised',
      createTaskId: () => 'task-1',
      createRunId: () => 'run-1',
      createTurnId: () => 'turn-1',
    });
    const iterator = manager.submit({ mode: 'react', content: 'edit the file' })[Symbol.asyncIterator]();
    const beforeAuthorization: TurnEvent[] = [];
    let authorization!: Extract<TurnEvent, { type: 'authorization_requested' }>;
    while (true) {
      const next = await iterator.next();
      expect(next.done).toBe(false);
      beforeAuthorization.push(next.value);
      if (next.value.type === 'authorization_requested') {
        authorization = next.value;
        break;
      }
    }
    const waitingState = await iterator.next();
    expect(waitingState.value).toMatchObject({ type: 'task_state', state: 'awaiting_authorization' });
    expect(client.requests).toHaveLength(1);
    expect(execute).not.toHaveBeenCalled();
    expect(() => manager.submit({ mode: 'react', content: 'ordinary text' })).toThrow(ConversationBusyError);
    expect(() => manager.dispatch({ type: 'continue_task', taskId: 'task-1' })).toThrow(ConversationBusyError);
    expect(() => manager.dispatch({ type: 'answer_question', taskId: 'task-1', questionId: 'q-1', content: 'answer' })).toThrow(ConversationBusyError);
    expect(() => manager.dispatch({ type: 'approve_plan', taskId: 'task-1', planId: 'plan-1', version: 1 })).toThrow(ConversationBusyError);
    expect(() => manager.dispatch({
      type: 'resolve_authorization', taskId: authorization.taskId, runId: 'stale-run',
      authorizationRequestId: authorization.authorizationRequestId, authorizationEpoch: authorization.authorizationEpoch,
      decisions: authorization.items.map((item) => ({ callId: item.callId, actionDigest: item.actionDigest, choice: 'allow_once' })),
    })).toThrow(expect.objectContaining({ code: 'STALE_AUTHORIZATION_REQUEST' }));
    expect(() => manager.dispatch({
      type: 'resolve_authorization', taskId: authorization.taskId, runId: authorization.runId,
      authorizationRequestId: authorization.authorizationRequestId, authorizationEpoch: authorization.authorizationEpoch,
      decisions: [],
    })).toThrow(expect.objectContaining({ code: 'AUTHORIZATION_DECISIONS_INCOMPLETE' }));
    expect(execute).not.toHaveBeenCalled();

    await collect(manager.dispatch({
      type: 'resolve_authorization',
      taskId: authorization.taskId,
      runId: authorization.runId,
      authorizationRequestId: authorization.authorizationRequestId,
      authorizationEpoch: authorization.authorizationEpoch,
      decisions: authorization.items.map((item) => ({ callId: item.callId, actionDigest: item.actionDigest, choice: 'allow_once' })),
    }));
    const remaining = await collectIterator(iterator);
    const all = [...beforeAuthorization, waitingState.value!, ...remaining];
    expect(execute).toHaveBeenCalledOnce();
    expect(client.requests).toHaveLength(2);
    expect(all.filter((event) => event.type === 'authorization_requested')).toHaveLength(1);
    expect(all.filter((event) => event.type === 'agent_iteration').every((event) => event.runId === authorization.runId)).toBe(true);
    expect(all.at(-1)).toMatchObject({ type: 'turn_complete', toolCallCount: 1 });
  });

  it('continues ReAct after an ordinary user denial without invoking Runner', async () => {
    const client = scriptedClient([
      [call('edit_file', { path: 'src/a.ts' }, 1)],
      [call('complete_task', { result: 'used a safer alternative', verificationSummary: 'verified' }, 2)],
    ]);
    const execute = vi.fn<ToolExecutor['execute']>();
    const manager = managerWithEditTool(client, execute);
    const iterator = manager.submit({ mode: 'react', content: 'edit safely' })[Symbol.asyncIterator]();
    const events: TurnEvent[] = [];
    let request!: Extract<TurnEvent, { type: 'authorization_requested' }>;
    while (true) {
      const next = await iterator.next();
      events.push(next.value!);
      if (next.value?.type === 'authorization_requested') { request = next.value; break; }
    }
    events.push((await iterator.next()).value!);
    await collect(manager.dispatch({
      type: 'resolve_authorization', taskId: request.taskId, runId: request.runId,
      authorizationRequestId: request.authorizationRequestId, authorizationEpoch: request.authorizationEpoch,
      decisions: request.items.map((item) => ({ callId: item.callId, actionDigest: item.actionDigest, choice: 'deny' })),
    }));
    events.push(...await collectIterator(iterator));
    expect(execute).not.toHaveBeenCalled();
    expect(client.requests).toHaveLength(2);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool_call_complete', isError: true,
      error: expect.objectContaining({ code: 'PERMISSION_DENIED' }),
    }));
    expect(events.at(-1)).toMatchObject({ type: 'turn_complete', toolErrorCount: 1 });
  });

  it('cancels authorization waiting with zero Runner calls and no late events', async () => {
    const client = scriptedClient([[call('edit_file', { path: 'src/a.ts' }, 1)]]);
    const execute = vi.fn<ToolExecutor['execute']>();
    const manager = managerWithEditTool(client, execute);
    const iterator = manager.submit({ mode: 'react', content: 'edit then cancel' })[Symbol.asyncIterator]();
    const events: TurnEvent[] = [];
    while (true) {
      const next = await iterator.next();
      events.push(next.value!);
      if (next.value?.type === 'authorization_requested') break;
    }
    events.push((await iterator.next()).value!);
    manager.cancel();
    events.push(...await collectIterator(iterator));
    const terminalCount = events.filter((event) => ['turn_cancelled', 'turn_complete', 'turn_error'].includes(event.type)).length;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(execute).not.toHaveBeenCalled();
    expect(events.at(-1)?.type).toBe('turn_cancelled');
    expect(terminalCount).toBe(1);
  });

  it('maps the structured cancel choice to a normal turn cancellation', async () => {
    const client = scriptedClient([[call('edit_file', { path: 'src/a.ts' }, 1)]]);
    const execute = vi.fn<ToolExecutor['execute']>();
    const manager = managerWithEditTool(client, execute);
    const iterator = manager.submit({ mode: 'react', content: 'edit then cancel from the prompt' })[Symbol.asyncIterator]();
    const events: TurnEvent[] = [];
    let request!: Extract<TurnEvent, { type: 'authorization_requested' }>;
    while (true) {
      const next = await iterator.next();
      events.push(next.value!);
      if (next.value?.type === 'authorization_requested') {
        request = next.value;
        break;
      }
    }
    events.push((await iterator.next()).value!);
    await collect(manager.dispatch({
      type: 'resolve_authorization', taskId: request.taskId, runId: request.runId,
      authorizationRequestId: request.authorizationRequestId, authorizationEpoch: request.authorizationEpoch,
      decisions: request.items.map((item) => ({ callId: item.callId, actionDigest: item.actionDigest, choice: 'cancel' })),
    }));
    events.push(...await collectIterator(iterator));
    expect(execute).not.toHaveBeenCalled();
    expect(events.at(-1)?.type).toBe('turn_cancelled');
    expect(events.filter((event) => ['turn_cancelled', 'turn_complete', 'turn_error'].includes(event.type))).toHaveLength(1);
  });

  it('cancels an executing Runner batch through the shared cancellation domain', async () => {
    const client = scriptedClient([[call('edit_file', { path: 'src/a.ts' }, 1)]]);
    let executionStarted!: () => void;
    const started = new Promise<void>((resolve) => { executionStarted = resolve; });
    const execute = vi.fn<ToolExecutor['execute']>(async (_calls, signal) => {
      executionStarted();
      await new Promise<never>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      throw new Error('unreachable');
    });
    const executor: ToolExecutor = { definitions: () => [editDefinition], execute };
    let gatewayId = 0;
    const manager = new ConversationManager(client, new InMemoryConversationStore(), {
      maxTokens: 100,
      actionGateway: createTestActionGateway(client, executor, { createId: () => `gateway-${++gatewayId}` }),
      availableTools: [editDefinition], permissionMode: 'autonomous',
      createTaskId: () => 'task-1', createRunId: () => 'run-1', createTurnId: () => 'turn-1',
    });
    const collected = collect(manager.submit({ mode: 'react', content: 'edit then cancel during execution' }));
    await started;
    manager.cancel();
    const events = await collected;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(execute).toHaveBeenCalledOnce();
    expect(events.at(-1)?.type).toBe('turn_cancelled');
    expect(events.filter((event) => ['turn_cancelled', 'turn_complete', 'turn_error'].includes(event.type))).toHaveLength(1);
  });

  it('does not turn Plan approval into a capability grant', async () => {
    const submitted = {
      goal: 'delivery', successCriteria: ['verified'],
      steps: [{ id: 's1', description: 'edit file', dependencies: [], successCriteria: ['edited'] }],
    };
    const client = scriptedClient([
      [call('submit_plan', submitted, 1)],
      [call('edit_file', { path: 'src/a.ts' }, 2)],
    ]);
    const execute = vi.fn<ToolExecutor['execute']>();
    const executor: ToolExecutor = { definitions: () => [editDefinition], execute };
    let run = 0; let gatewayId = 0;
    const manager = new ConversationManager(client, new InMemoryConversationStore(), {
      maxTokens: 100,
      actionGateway: createTestActionGateway(client, executor, { createId: () => `gateway-${++gatewayId}` }),
      availableTools: [editDefinition], permissionMode: 'supervised',
      createTaskId: () => 'task-1', createRunId: () => `run-${++run}`, createTurnId: () => `turn-${run + 1}`,
      createPlanId: () => 'plan-1',
    });
    const drafted = await collect(manager.submit({ mode: 'plan', content: 'make a plan' }));
    const ready = drafted.find((event): event is Extract<TurnEvent, { type: 'plan_ready' }> => event.type === 'plan_ready')!;
    const iterator = manager.dispatch({
      type: 'approve_plan', taskId: ready.taskId, planId: ready.plan.planId, version: ready.plan.version,
    })[Symbol.asyncIterator]();
    let authorization: TurnEvent | undefined;
    while (authorization?.type !== 'authorization_requested') authorization = (await iterator.next()).value;
    expect(authorization).toMatchObject({ type: 'authorization_requested', runId: 'run-2' });
    expect(execute).not.toHaveBeenCalled();
    await iterator.next();
    manager.cancel();
    await collectIterator(iterator);
  });

  it('destroys the ActionTask on a security integrity failure and does not expose a resume path', async () => {
    const client = scriptedClient([[call('read_file', { path: 'src/a.ts' }, 1)]]);
    const executor: ToolExecutor = {
      definitions: () => [{ ...editDefinition, name: 'read_file', executionMode: 'read_shared' }],
      execute: async (_calls, _signal, previousCalls = 0) => ({ results: [], totalCalls: previousCalls, businessToolLimitReached: false }),
    };
    const task = await openFakeActionTask(client, { toolExecutor: executor });
    const closeReasons: string[] = [];
    const originalClose = task.close.bind(task);
    Object.defineProperty(task, 'performActionBatch', {
      value: async () => { throw new SecurityIntegrityFailureError('TICKET_REPLAY', 'ticket replay detected'); },
    });
    Object.defineProperty(task, 'close', {
      value: async (reason: Parameters<typeof originalClose>[0]) => { closeReasons.push(reason); await originalClose(reason); },
    });
    const manager = new ConversationManager(client, new InMemoryConversationStore(), {
      maxTokens: 100,
      actionGateway: { openTask: async () => task },
      createTaskId: () => 'task-1', createRunId: () => 'run-1', createTurnId: () => 'turn-1',
    });
    const events = await collect(manager.submit({ mode: 'react', content: 'read' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'task_state', state: 'security_integrity_failure' }));
    expect(events.at(-1)).toMatchObject({ type: 'turn_error', error: { code: 'TICKET_REPLAY' } });
    expect(events.at(-1)).not.toHaveProperty('restoreInput');
    expect(closeReasons).toEqual(['security_integrity_failure']);
    expect(() => manager.dispatch({ type: 'resume_task', taskId: 'task-1' })).toThrow();
  });
});

function call(name: string, input: unknown, index: number): ToolCallRequest {
  return { callId: `call-${index}`, providerCallId: `provider-${index}`, name, input };
}

async function collect(events: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const result: TurnEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

async function collectIterator(iterator: AsyncIterator<TurnEvent>): Promise<TurnEvent[]> {
  const result: TurnEvent[] = [];
  while (true) {
    const next = await iterator.next();
    if (next.done) return result;
    result.push(next.value);
  }
}

function scriptedClient(scripts: readonly (readonly ToolCallRequest[])[]): FakeLlmClient {
  return new FakeLlmClient(fakeProfile, scripts.map((calls) => (
    [start, { type: 'tool_calls' as const, calls }, done].map((event) => ({ event }))
  )));
}

function managerWithEditTool(client: FakeLlmClient, execute: ToolExecutor['execute']): ConversationManager {
  const executor: ToolExecutor = { definitions: () => [editDefinition], execute };
  let gatewayId = 0;
  return new ConversationManager(client, new InMemoryConversationStore(), {
    maxTokens: 100,
    actionGateway: createTestActionGateway(client, executor, { createId: () => `gateway-${++gatewayId}` }),
    availableTools: [editDefinition], permissionMode: 'supervised',
    createTaskId: () => 'task-1', createRunId: () => 'run-1', createTurnId: () => 'turn-1',
  });
}
