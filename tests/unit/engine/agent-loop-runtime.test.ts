import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../../../src/engine/agent-loop.js';
import type { AgentEvent, LlmStreamEvent, Plan, ToolCallRequest, ToolCallResult, ToolDefinition, ToolExecutor } from '../../../src/shared/types.js';
import { FakeLlmClient, fakeProfile } from '../../fixtures/fake-llm-client.js';

const schema = { type: 'object', additionalProperties: false } as const;
const read: ToolDefinition = { name: 'read_file', purpose: '读取', useWhen: ['读取'], avoidWhen: ['修改'], inputSchema: schema, resultSchema: schema, worksWith: [], executionMode: 'read_shared' };
const start: LlmStreamEvent = { type: 'stream_start' };
const done: LlmStreamEvent = { type: 'stream_complete', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 2 } };
const toolCall = (name: string, input: unknown, index = 1): ToolCallRequest => ({ callId: `c${index}`, providerCallId: `p${index}`, name, input });
const calls = (...items: ToolCallRequest[]): LlmStreamEvent => ({ type: 'tool_calls', calls: items });

describe('AgentLoop runtime', () => {
  it('keeps model text private, feeds business results back, and completes only with complete_task', async () => {
    const client = scripted([
      [start, { type: 'text_delta', delta: '内部思考' }, calls(toolCall('read_file', { path: 'a.ts' })), done],
      [start, calls(toolCall('complete_task', { result: '完成', verificationSummary: '读取验证通过' }, 2)), done],
    ]);
    const events = await run(client, executor());
    expect(events.map((event) => event.type)).toEqual([
      'run_started', 'iteration_started', 'tool_call_queued', 'tool_call_started', 'tool_call_completed', 'iteration_completed',
      'iteration_started', 'iteration_completed', 'run_stopped',
    ]);
    expect(events.some((event) => JSON.stringify(event).includes('内部思考'))).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'run_stopped', outcome: { reason: 'completed', result: '完成', iterationCount: 2, toolCallCount: 1 } });
    expect(client.requests[1]?.prompt.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', content: expect.arrayContaining([expect.objectContaining({ type: 'text', text: '内部思考' })]) }),
      expect.objectContaining({ role: 'tool' }),
    ]));
  });

  it('publishes tool start before a running batch completes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const client = scripted([[start, calls(toolCall('read_file', { path: 'a.ts' })), done], [start, calls(toolCall('complete_task', { result: '完成', verificationSummary: '验证' }, 2)), done]]);
    const tools: ToolExecutor = {
      definitions: () => [read],
      execute: async (requests, _signal, previous = 0, hooks = {}) => {
        hooks.onStart?.(requests[0]!);
        await gate;
        return { results: [{ callId: 'c1', providerCallId: 'p1', toolName: 'read_file', isError: false, content: { summary: 'ok' } }], totalCalls: previous + 1, businessToolLimitReached: false };
      },
    };
    const iterator = new AgentLoop(client, tools, 100).run({ taskId: 't1', runId: 'r1', kind: 'react', task: '任务', messages: [], signal: new AbortController().signal });
    expect((await iterator.next()).value?.type).toBe('run_started');
    expect((await iterator.next()).value?.type).toBe('iteration_started');
    expect((await iterator.next()).value?.type).toBe('tool_call_queued');
    expect((await iterator.next()).value?.type).toBe('tool_call_started');
    release();
    const remaining: AgentEvent[] = [];
    for await (const event of { [Symbol.asyncIterator]: () => iterator }) remaining.push(event);
    expect(remaining.at(-1)).toMatchObject({ type: 'run_stopped', outcome: { reason: 'completed' } });
  });

  it('corrects plain text and stops after three equivalent invalid iterations', async () => {
    const client = scripted(Array.from({ length: 3 }, () => [start, { type: 'text_delta', delta: '只是文字' }, done]));
    const events = await run(client, executor([]));
    expect(client.requests).toHaveLength(3);
    expect(client.requests[1]?.prompt.messages.at(-1)).toEqual({ role: 'assistant', content: [{ type: 'text', text: '只是文字' }] });
    expect(client.requests[1]?.prompt.system.reminder?.text).toContain('protocolCorrection');
    expect(client.requests[1]?.prompt.system.reminder?.text).toContain('普通文本不能结束任务');
    expect(events.at(-1)).toMatchObject({ type: 'run_stopped', outcome: { reason: 'abnormal', iterationCount: 3 } });
  });

  it('detects three equivalent business batches while ignoring volatile result fields', async () => {
    const request = toolCall('read_file', { path: 'a.ts' });
    const client = scripted(Array.from({ length: 3 }, () => [start, calls(request), done]));
    let duration = 0;
    const events = await run(client, executor([read], () => ({ durationMs: duration++ })));
    expect(events.at(-1)).toMatchObject({ type: 'run_stopped', outcome: { reason: 'abnormal', iterationCount: 3 } });
  });

  it('stops after three equivalent invalid control submissions without changing state', async () => {
    const invalid = toolCall('complete_task', { result: '' });
    const client = scripted(Array.from({ length: 3 }, () => [start, calls(invalid), done]));
    const events = await run(client, executor([]));
    expect(events.filter((event) => event.type === 'iteration_completed')).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({ type: 'run_stopped', outcome: { reason: 'abnormal' } });
  });

  it('requests user input and ends the current stream with correlated ids', async () => {
    const client = scripted([[start, calls(toolCall('request_user_input', { prompt: '选择目标' })), done]]);
    const events = await run(client, executor([]), { createQuestionId: () => 'question-1' });
    expect(events).toContainEqual(expect.objectContaining({ type: 'user_input_requested', taskId: 'task-1', runId: 'run-1', questionId: 'question-1' }));
    expect(events.at(-1)).toMatchObject({ type: 'run_stopped', outcome: { reason: 'awaiting_input', question: { questionId: 'question-1' } } });
  });

  it('hard stops React after ten iterations without an extra model call', async () => {
    const scripts = Array.from({ length: 10 }, (_, index) => [start, calls(toolCall('read_file', { path: `a${index}.ts` }, index)), done]);
    const client = scripted(scripts);
    const events = await run(client, executor());
    expect(client.requests).toHaveLength(10);
    expect(events.at(-1)).toMatchObject({ type: 'run_stopped', outcome: {
      reason: 'iteration_limit', iterationCount: 10,
      progress: { completedWork: expect.arrayContaining(['read_file: ok']), unfinishedWork: ['任务'], sideEffects: [] },
    } });
    expect(JSON.stringify(events.at(-1))).toContain('已完成：read_file: ok');
  });

  it('cancels the shared model stream and emits no late events', async () => {
    const controller = new AbortController();
    const client = new FakeLlmClient(fakeProfile, [[{ event: start }, { delayMs: 20, event: calls(toolCall('read_file', {})) }, { event: done }]]);
    const collecting = run(client, executor(), { signal: controller.signal });
    setTimeout(() => controller.abort(), 1);
    const events = await collecting;
    expect(events.at(-1)).toMatchObject({ type: 'run_stopped', outcome: { reason: 'cancelled' } });
    expect(events.filter((event) => event.type === 'run_stopped')).toHaveLength(1);
  });

  it('removes business definitions after the cumulative limit and keeps control tools', async () => {
    const first = toolCall('read_file', {});
    const client = scripted([
      [start, calls(first), done],
      [start, calls(toolCall('complete_task', { result: '完成', verificationSummary: '验证' }, 2)), done],
    ]);
    const limited: ToolExecutor = {
      definitions: (scope) => scope === 'none' ? [] : [read],
      execute: async (requests) => ({
        results: requests.map((request) => ({ callId: request.callId, providerCallId: request.providerCallId, toolName: request.name, isError: false, content: { summary: 'ok', data: {} } })),
        totalCalls: 100, businessToolLimitReached: true,
      }),
    };
    await run(client, limited);
    expect(client.requests[1]?.prompt.tools.map((item) => item.name)).toEqual(['complete_task', 'request_user_input']);
  });

  it('drafts a structured plan with read-only business definitions', async () => {
    const input = { goal: '交付', successCriteria: ['全部通过'], steps: [{ id: 's1', description: '实现', dependencies: [], successCriteria: ['单测通过'] }] };
    const client = scripted([[start, calls(toolCall('submit_plan', input)), done]]);
    const events = await run(client, executor(), { kind: 'plan_draft', createPlanId: () => 'plan-1' });
    expect(client.requests[0]?.prompt.tools.map((item) => item.name)).toEqual(['read_file', 'submit_plan', 'request_user_input']);
    expect(events).toContainEqual(expect.objectContaining({ type: 'plan_submitted', plan: expect.objectContaining({ planId: 'plan-1', version: 1 }) }));
  });

  it('executes plan steps serially and verifies task-level criteria', async () => {
    const plan: Plan = {
      planId: 'plan-1', version: 1, goal: '交付', successCriteria: ['全量通过'],
      steps: [
        { id: 's1', description: '实现', dependencies: [], successCriteria: ['单测通过'], status: 'pending', evidence: [] },
        { id: 's2', description: '验证', dependencies: ['s1'], successCriteria: ['构建通过'], status: 'pending', evidence: [] },
      ],
    };
    const criteria = (criterion: string, evidence: string) => [{ criterion, passed: true, evidence }];
    const client = scripted([
      [start, calls(toolCall('complete_step', { stepId: 's1', criteria: criteria('单测通过', 'unit') })), done],
      [start, calls(toolCall('complete_step', { stepId: 's2', criteria: criteria('构建通过', 'build') })), done],
      [start, calls(toolCall('complete_task', { result: '完成', verificationSummary: 'all', criteria: criteria('全量通过', 'all') })), done],
    ]);
    const events = await run(client, executor(), { kind: 'plan_execute', plan });
    expect(events.filter((event) => event.type === 'plan_step_started').map((event) => event.stepId)).toEqual(['s1', 's2']);
    expect(client.requests[1]?.prompt.messages.at(-1)).toMatchObject({ role: 'tool', content: [{ result: { toolName: 'complete_step', isError: false } }] });
    expect(events.at(-1)).toMatchObject({ type: 'run_stopped', outcome: { reason: 'completed', plan: { steps: [{ status: 'completed' }, { status: 'completed' }] } } });
  });

  it('limits a single plan step to ten iterations', async () => {
    const plan: Plan = { planId: 'p1', version: 1, goal: '交付', successCriteria: ['通过'], steps: [
      { id: 's1', description: '实现', dependencies: [], successCriteria: ['完成'], status: 'pending', evidence: [] },
    ] };
    const client = scripted(Array.from({ length: 10 }, (_, index) => [start, calls(toolCall('read_file', { path: `a${index}` }, index)), done]));
    const events = await run(client, executor(), { kind: 'plan_execute', plan });
    expect(client.requests).toHaveLength(10);
    expect(events.at(-2)).toMatchObject({ type: 'plan_step_failed', stepId: 's1', reason: '计划步骤 s1 已达到 10 次迭代上限。' });
    expect(events.at(-1)).toMatchObject({ type: 'run_stopped', outcome: { reason: 'iteration_limit', iterationCount: 10, plan: { steps: [{ status: 'failed' }] } } });
  });

  it('enforces the fifty-iteration whole-plan limit across distinct completed steps', async () => {
    const steps = Array.from({ length: 51 }, (_, index) => ({ id: `s${index}`, description: `步骤${index}`, dependencies: index === 0 ? [] : [`s${index - 1}`], successCriteria: [`标准${index}`], status: 'pending' as const, evidence: [] }));
    const plan: Plan = { planId: 'p1', version: 1, goal: '交付', successCriteria: ['通过'], steps };
    const client = scripted(steps.slice(0, 50).map((step, index) => [start, calls(toolCall('complete_step', { stepId: step.id, criteria: [{ criterion: step.successCriteria[0], passed: true, evidence: 'ok' }] }, index)), done]));
    const events = await run(client, executor(), { kind: 'plan_execute', plan });
    expect(client.requests).toHaveLength(50);
    expect(events.at(-1)).toMatchObject({ type: 'run_stopped', outcome: { reason: 'iteration_limit', iterationCount: 50 } });
  });

  it('blocks a dependent step after its prerequisite is skipped', async () => {
    const plan: Plan = { planId: 'p1', version: 1, goal: '交付', successCriteria: ['通过'], steps: [
      { id: 's1', description: '前置', dependencies: [], successCriteria: ['完成'], status: 'pending', evidence: [] },
      { id: 's2', description: '后续', dependencies: ['s1'], successCriteria: ['完成'], status: 'pending', evidence: [] },
    ] };
    const client = scripted([[start, calls(toolCall('skip_step', { stepId: 's1', reason: '外部条件缺失' })), done]]);
    const events = await run(client, executor(), { kind: 'plan_execute', plan });
    expect(client.requests).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'run_stopped', outcome: { reason: 'abnormal', plan: { steps: [{ status: 'skipped' }, { status: 'pending' }] } } });
  });

  it('drafting without submit_plan stops at ten and produces no plan', async () => {
    const scripts = Array.from({ length: 10 }, (_, index) => [start, calls(toolCall('read_file', { path: `a${index}` }, index)), done]);
    const client = scripted(scripts);
    const events = await run(client, executor(), { kind: 'plan_draft' });
    expect(events.at(-1)).toMatchObject({ type: 'run_stopped', outcome: { reason: 'iteration_limit' } });
    expect((events.at(-1) as Extract<AgentEvent, { type: 'run_stopped' }>).outcome).not.toHaveProperty('plan');
  });

  it('separates plan revision from factual input requests', async () => {
    const plan: Plan = { planId: 'p1', version: 1, goal: '交付', successCriteria: ['通过'], steps: [
      { id: 's1', description: '实现', dependencies: [], successCriteria: ['完成'], status: 'pending', evidence: [] },
    ] };
    const revision = await run(scripted([[start, calls(toolCall('request_plan_revision', { reason: '范围变化', suggestion: '新增步骤' })), done]]), executor(), { kind: 'plan_execute', plan });
    expect(revision.at(-1)).toMatchObject({ type: 'run_stopped', outcome: { reason: 'plan_revision', revision: { reason: '范围变化' } } });
    const input = await run(scripted([[start, calls(toolCall('request_user_input', { prompt: '目标路径？' })), done]]), executor(), { kind: 'plan_execute', plan });
    expect(input.at(-1)).toMatchObject({ type: 'run_stopped', outcome: { reason: 'awaiting_input', plan: { version: 1 } } });
  });
});

function scripted(scripts: readonly (readonly LlmStreamEvent[])[]) {
  return new FakeLlmClient(fakeProfile, scripts.map((events) => events.map((event) => ({ event }))));
}

function executor(definitions: readonly ToolDefinition[] = [read], volatile?: () => object): ToolExecutor {
  return {
    definitions: (scope) => scope === 'none' ? [] : definitions,
    execute: async (requests, _signal, previous = 0, hooks = {}) => {
      const results = requests.map((request) => {
        hooks.onStart?.(request);
        return { callId: request.callId, providerCallId: request.providerCallId, toolName: request.name, isError: false, content: { summary: 'ok', data: { content: 'x', ...volatile?.() } } } satisfies ToolCallResult;
      });
      return { results, totalCalls: previous + requests.length, businessToolLimitReached: false };
    },
  };
}

async function run(client: FakeLlmClient, tools: ToolExecutor, overrides: Partial<Parameters<AgentLoop['run']>[0]> = {}): Promise<AgentEvent[]> {
  const loop = new AgentLoop(client, tools, 100);
  const events: AgentEvent[] = [];
  for await (const event of loop.run({ taskId: 'task-1', runId: 'run-1', kind: 'react', task: '任务', messages: [], signal: new AbortController().signal, ...overrides })) events.push(event);
  return events;
}
