import { describe, expect, it } from 'vitest';
import { ConversationBusyError, ConversationManager } from '../../../src/engine/conversation-manager.js';
import { InMemoryConversationStore } from '../../../src/memory/conversation-store.js';
import type { LlmClient, LlmRequest, LlmStreamEvent, ProfileSummary, ToolCallRequest, TurnEvent } from '../../../src/shared/types.js';
import { FakeLlmClient } from '../../fixtures/fake-llm-client.js';

const profile: ProfileSummary = { name: 'fake', protocol: 'anthropic-messages', model: 'fake-model' };
const start: LlmStreamEvent = { type: 'stream_start' };
const done: LlmStreamEvent = { type: 'stream_complete', finishReason: 'stop', usage: { inputTokens: 3, outputTokens: 2 } };
const call = (name: string, input: unknown, index = 1): ToolCallRequest => ({ callId: `c${index}`, providerCallId: `p${index}`, name, input });
const calls = (...items: ToolCallRequest[]): LlmStreamEvent => ({ type: 'tool_calls', calls: items });
const completed = (result: string, index = 1) => [start, calls(call('complete_task', { result, verificationSummary: '验证通过' }, index)), done];

describe('ConversationManager', () => {
  it('用 complete_task 完成顶层 ReAct，并在下一任务提供筛选后的公共历史', async () => {
    const client = scripted([completed('答一'), completed('答二', 2)]);
    const store = new InMemoryConversationStore();
    const manager = managerFor(client, store);

    const first = await collect(manager.submit({ mode: 'react', content: '第一问' }));
    const second = await collect(manager.submit({ mode: 'react', content: '第二问' }));

    expect(first.map((event) => event.type)).toEqual(['turn_start', 'agent_iteration', 'agent_iteration', 'text_delta', 'turn_complete']);
    expect(first[0]).toMatchObject({ type: 'turn_start', taskMode: 'react', taskPhase: 'react' });
    expect(first.filter((event) => event.type === 'agent_iteration')).toEqual([
      expect.objectContaining({ taskId: 'task-1', runId: 'run-1', iteration: 1, phase: 'started' }),
      expect.objectContaining({ taskId: 'task-1', runId: 'run-1', iteration: 1, phase: 'completed' }),
    ]);
    expect(second.every((event) => event.turnId === 'turn-2')).toBe(true);
    expect(client.requests[1]?.messages.slice(0, 3)).toEqual([
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '答一\n\n验证：验证通过' },
      { role: 'user', content: '第二问' },
    ]);
    expect(second.at(-1)).toMatchObject({ type: 'turn_complete', modelTurnCount: 1, usage: { inputTokens: 3, outputTokens: 2 } });
  });

  it('活动运行同步拒绝并发提交', async () => {
    const client = new ControllableClient();
    const manager = managerFor(client, new InMemoryConversationStore());
    const first = manager.submit({ mode: 'react', content: '第一问' });
    expect(() => manager.submit({ mode: 'plan', content: '新计划' })).toThrow(ConversationBusyError);
    const collecting = collect(first);
    await client.started;
    client.finish();
    await collecting;
  });

  it('保留 Provider 安全错误且不自动重试', async () => {
    const client = scripted([[start, { type: 'stream_error', error: { code: 'RATE_LIMITED', message: '请求过于频繁。', retryable: true } }]]);
    const result = await collect(managerFor(client, new InMemoryConversationStore()).submit({ mode: 'react', content: '再试一次' }));
    expect(client.requests).toHaveLength(1);
    expect(result.at(-1)).toMatchObject({ type: 'turn_error', restoreInput: '再试一次', error: { code: 'RATE_LIMITED', retryable: true } });
  });

  it('请求输入后用 taskId + questionId 继续同一任务并分配新 runId', async () => {
    const client = scripted([
      [start, calls(call('request_user_input', { prompt: '目标是什么？' })), done],
      completed('已按目标完成', 2),
    ]);
    const manager = managerFor(client, new InMemoryConversationStore());
    const first = await collect(manager.submit({ mode: 'react', content: '执行任务' }));
    expect(first).toContainEqual(expect.objectContaining({ type: 'task_state', state: 'awaiting_input', taskId: 'task-1', questionId: 'question-1' }));
    expect(() => manager.submit({ mode: 'plan', content: '创建另一计划' })).toThrowError(expect.objectContaining({ code: 'TASK_ACTIVE' }));
    const second = await collect(manager.submit({ mode: 'react', content: '目标 A' }));
    expect(second.at(-1)?.type).toBe('turn_complete');
    expect(client.requests).toHaveLength(2);
  });

  it('Plan 规划请求输入后仍回到规划阶段', async () => {
    const submitted = { goal: '交付', successCriteria: ['通过'], steps: [{ id: 's1', description: '实现', dependencies: [], successCriteria: ['单测'] }] };
    const client = scripted([
      [start, calls(call('request_user_input', { prompt: '目标范围？' })), done],
      [start, calls(call('submit_plan', submitted, 2)), done],
    ]);
    const manager = managerFor(client, new InMemoryConversationStore());
    const first = await collect(manager.submit({ mode: 'plan', content: '制定计划' }));
    expect(first[0]).toMatchObject({ type: 'turn_start', taskMode: 'plan', taskPhase: 'plan_draft' });
    expect(first).toContainEqual(expect.objectContaining({ type: 'task_state', state: 'awaiting_input', questionId: 'question-1' }));
    const second = await collect(manager.submit({ mode: 'react', content: '只做核心范围' }));
    expect(client.requests[1]?.tools?.map((tool) => tool.name)).toContain('submit_plan');
    expect(second).toContainEqual(expect.objectContaining({ type: 'plan_ready' }));
    expect(second.at(-1)).toMatchObject({ type: 'turn_complete', usage: { inputTokens: 3, outputTokens: 2 } });
  });

  it('Plan 草拟达到上限后继续仍进入只读规划并可提交计划', async () => {
    const submitted = { goal: '交付', successCriteria: ['通过'], steps: [{ id: 's1', description: '实现', dependencies: [], successCriteria: ['单测'] }] };
    const reads = Array.from({ length: 10 }, (_, index) => [start, calls(call('read_file', { path: `a${index}` }, index)), done]);
    const client = scripted([...reads, [start, calls(call('submit_plan', submitted, 11)), done]]);
    const manager = managerFor(client, new InMemoryConversationStore());
    const stopped = await collect(manager.submit({ mode: 'plan', content: '制定计划' }));
    expect(stopped.at(-1)).toMatchObject({ type: 'turn_error', error: { code: 'AGENT_LOOP_LIMIT_REACHED' } });

    const continued = await collect(manager.dispatch({ type: 'continue_task', taskId: 'task-1' }));
    expect(client.requests[10]?.tools?.map((tool) => tool.name)).toContain('submit_plan');
    expect(continued).toContainEqual(expect.objectContaining({ type: 'plan_ready' }));
  });

  it('Plan 执行停止后的补充要求进入新版本规划', async () => {
    const submitted = { goal: '交付', successCriteria: ['通过'], steps: [{ id: 's1', description: '实现', dependencies: [], successCriteria: ['单测'] }] };
    const revised = { ...submitted, goal: '扩展交付' };
    const client = scripted([
      [start, calls(call('submit_plan', submitted)), done],
      ...Array.from({ length: 10 }, (_, index) => [start, calls(call('read_file', { path: `a${index}` }, index + 2)), done]),
      [start, calls(call('submit_plan', revised, 20)), done],
    ]);
    const manager = managerFor(client, new InMemoryConversationStore());
    const drafted = await collect(manager.submit({ mode: 'plan', content: '完成交付' }));
    const ready = drafted.find((event): event is Extract<TurnEvent, { type: 'plan_ready' }> => event.type === 'plan_ready')!;
    const execution = await collect(manager.dispatch({ type: 'approve_plan', taskId: ready.taskId, planId: ready.plan.planId, version: ready.plan.version }));
    expect(execution).toContainEqual(expect.objectContaining({ type: 'plan_step', stepId: 's1', status: 'failed' }));

    const refined = await collect(manager.dispatch({ type: 'continue_task', taskId: ready.taskId, content: '扩大目标' }));
    const next = refined.find((event): event is Extract<TurnEvent, { type: 'plan_ready' }> => event.type === 'plan_ready')!;
    expect(client.requests.at(-1)?.tools?.map((tool) => tool.name)).toContain('submit_plan');
    expect(next.plan).toMatchObject({ planId: ready.plan.planId, version: 2, goal: '扩展交付' });
  });

  it('等待输入与计划修订终态都保留 usage', async () => {
    const inputClient = scripted([[start, calls(call('request_user_input', { prompt: '路径？' })), done]]);
    const inputEvents = await collect(managerFor(inputClient, new InMemoryConversationStore()).submit({ mode: 'react', content: '执行' }));
    expect(inputEvents.at(-1)).toMatchObject({ type: 'turn_complete', usage: { inputTokens: 3, outputTokens: 2 } });

    const submitted = { goal: '交付', successCriteria: ['通过'], steps: [{ id: 's1', description: '实现', dependencies: [], successCriteria: ['完成'] }] };
    const revisionClient = scripted([
      [start, calls(call('submit_plan', submitted)), done],
      [start, calls(call('request_plan_revision', { reason: '范围变化', suggestion: '重做计划' }, 2)), done],
    ]);
    const revisionManager = managerFor(revisionClient, new InMemoryConversationStore());
    const drafted = await collect(revisionManager.submit({ mode: 'plan', content: '制定计划' }));
    const ready = drafted.find((event): event is Extract<TurnEvent, { type: 'plan_ready' }> => event.type === 'plan_ready')!;
    const revisionEvents = await collect(revisionManager.dispatch({ type: 'approve_plan', taskId: ready.taskId, planId: ready.plan.planId, version: ready.plan.version }));
    expect(revisionEvents.at(-1)).toMatchObject({ type: 'turn_complete', usage: { inputTokens: 3, outputTokens: 2 } });
  });

  it('Plan 草拟、过期审批拒绝、当前版本审批与串行执行形成闭环', async () => {
    const submitted = { goal: '交付', successCriteria: ['全量通过'], steps: [{ id: 's1', description: '实现', dependencies: [], successCriteria: ['单测通过'] }] };
    const criterion = (name: string, evidence: string) => [{ criterion: name, passed: true, evidence }];
    const client = scripted([
      [start, calls(call('submit_plan', submitted)), done],
      [start, calls(call('complete_step', { stepId: 's1', criteria: criterion('单测通过', 'unit') }, 2)), done],
      [start, calls(call('complete_task', { result: '完成', verificationSummary: 'all', criteria: criterion('全量通过', 'all') }, 3)), done],
    ]);
    const manager = managerFor(client, new InMemoryConversationStore());
    const draft = await collect(manager.submit({ mode: 'plan', content: '完成交付' }));
    const ready = draft.find((event): event is Extract<TurnEvent, { type: 'plan_ready' }> => event.type === 'plan_ready')!;
    expect(() => manager.dispatch({ type: 'approve_plan', taskId: ready.taskId, planId: ready.plan.planId, version: 0 })).toThrowError(expect.objectContaining({ code: 'STALE_PLAN_APPROVAL' }));
    const execution = await collect(manager.dispatch({ type: 'approve_plan', taskId: ready.taskId, planId: ready.plan.planId, version: ready.plan.version }));
    expect(execution.filter((event) => event.type === 'plan_step').map((event) => event.status)).toEqual(['running', 'completed']);
    expect(execution.at(-1)?.type).toBe('turn_complete');
  });

  it('取消生成后进入可恢复状态，恢复使用新运行', async () => {
    const client = new DelayedThenCompleteClient();
    const manager = managerFor(client, new InMemoryConversationStore());
    const collecting = collect(manager.submit({ mode: 'react', content: '长任务' }));
    await client.started;
    manager.cancel();
    const cancelled = await collecting;
    expect(cancelled.map((event) => event.type).slice(-2)).toEqual(['task_state', 'turn_cancelled']);
    const resumed = await collect(manager.dispatch({ type: 'resume_task', taskId: 'task-1' }));
    expect(resumed.at(-1)?.type).toBe('turn_complete');
  });
});

function scripted(scripts: readonly (readonly LlmStreamEvent[])[]) {
  return new FakeLlmClient(profile, scripts.map((events) => events.map((event) => ({ event }))));
}

function managerFor(client: LlmClient, store: InMemoryConversationStore): ConversationManager {
  let turn = 0; let task = 0; let run = 0; let question = 0; let plan = 0; let now = 100;
  return new ConversationManager(client, store, {
    maxTokens: 123,
    createTurnId: () => `turn-${++turn}`,
    createTaskId: () => `task-${++task}`,
    createRunId: () => `run-${++run}`,
    createQuestionId: () => `question-${++question}`,
    createPlanId: () => `plan-${++plan}`,
    now: () => (now += 5),
  });
}

async function collect(events: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> { const result: TurnEvent[] = []; for await (const event of events) result.push(event); return result; }

class ControllableClient implements LlmClient {
  readonly profile = profile; readonly requests: LlmRequest[] = [];
  private release!: () => void; private markStarted!: () => void;
  readonly started = new Promise<void>((resolve) => { this.markStarted = resolve; });
  private readonly released = new Promise<void>((resolve) => { this.release = resolve; });
  finish(): void { this.release(); }
  async *stream(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
    this.requests.push(request); this.markStarted(); yield start; await this.released;
    yield calls(call('complete_task', { result: '完成', verificationSummary: '验证' })); yield done;
  }
}

class DelayedThenCompleteClient implements LlmClient {
  readonly profile = profile; private count = 0; private markStarted!: () => void;
  readonly started = new Promise<void>((resolve) => { this.markStarted = resolve; });
  async *stream(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
    this.count += 1; yield start;
    if (this.count === 1) {
      this.markStarted();
      await new Promise<void>((resolve) => request.signal.addEventListener('abort', () => resolve(), { once: true }));
      return;
    }
    yield calls(call('complete_task', { result: '恢复完成', verificationSummary: '验证' }, 2)); yield done;
  }
}
