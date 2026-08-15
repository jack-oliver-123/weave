import { describe, expect, it } from 'vitest';
import { ConversationManager } from '../../../src/engine/conversation-manager.js';
import { InMemoryConversationStore } from '../../../src/memory/conversation-store.js';
import { ToolCallScheduler } from '../../../src/tool/scheduler.js';
import { SchedulerToolExecutor } from '../../../src/tool/executor.js';
import type { LlmStreamEvent, ToolCallRequest, ToolCallResult, ToolDefinition, TurnEvent } from '../../../src/shared/types.js';
import { FakeLlmClient, fakeProfile } from '../../fixtures/fake-llm-client.js';
import { CONTROL_DECISION_CHECKPOINT } from '../../../src/engine/prompt-rules.js';
import { createTestActionGateway } from '../../fixtures/test-action-gateway.js';

const definition: ToolDefinition = {
  name: 'read_file', purpose: '读取文件', useWhen: ['需要内容'], avoidWhen: ['需要修改'],
  inputSchema: { type: 'object' }, resultSchema: { type: 'object' }, worksWith: [], executionMode: 'read_shared',
};
const start: LlmStreamEvent = { type: 'stream_start' };
const done: LlmStreamEvent = { type: 'stream_complete', finishReason: 'stop', usage: { inputTokens: 2, outputTokens: 3, cacheReadInputTokens: 0, cacheWriteInputTokens: 1 } };
const call = (index: number, name = 'read_file', input: unknown = { index }): ToolCallRequest => ({ callId: `c${index}`, providerCallId: `p${index}`, name, input });
const calls = (...items: ToolCallRequest[]): LlmStreamEvent => ({ type: 'tool_calls', calls: items });
const complete = (index: number, result: string) => call(index, 'complete_task', { result, verificationSummary: '验证通过' });

describe('ConversationManager AgentLoop 边界', () => {
  it('只发布确定性工具事件与最终结果，并汇总统计', async () => {
    const client = scripted([
      [start, { type: 'text_delta', delta: '内部行动说明' }, calls(call(1)), done],
      [start, calls(complete(2, '文件内容是 hello。')), done],
    ]);
    const store = new InMemoryConversationStore();
    const events = await collect(manager(client, store).submit({ mode: 'react', content: '读取文件' }));
    expect(events.map((event) => event.type)).toEqual([
      'turn_start', 'agent_iteration', 'tool_call_queued', 'tool_call_start', 'tool_call_complete', 'agent_iteration',
      'agent_iteration', 'agent_iteration', 'text_delta', 'turn_complete',
    ]);
    expect(JSON.stringify(events)).not.toContain('内部行动说明');
    expect(events.at(-1)).toMatchObject({ type: 'turn_complete', modelTurnCount: 2, toolCallCount: 1, toolErrorCount: 0, usage: {
      inputTokens: 4, outputTokens: 6, cacheReadInputTokens: 0, cacheWriteInputTokens: 2,
    } });
    const completedEvent = events.at(-1) as Extract<TurnEvent, { type: 'turn_complete' }>;
    expect(completedEvent.promptAudits).toHaveLength(2);
    expect(completedEvent.promptAudits).toEqual(expect.arrayContaining([
      expect.objectContaining({ protocol: 'anthropic-messages', model: fakeProfile.model, promptVersion: '1.0.2', usage: done.usage }),
    ]));
    expect(completedEvent.promptAudits?.every((audit) => /^[a-f0-9]{64}$/.test(audit.stableHash) && /^[a-f0-9]{64}$/.test(audit.assemblyHash))).toBe(true);
    expect(JSON.stringify(completedEvent.promptAudits)).not.toContain('读取文件');
    expect(JSON.stringify(completedEvent.promptAudits)).not.toContain('内部行动说明');
    expect(JSON.stringify(client.requests[1]?.prompt.messages)).toContain(CONTROL_DECISION_CHECKPOINT);
    expect(store.getMessages().map((message) => message.role)).toEqual(['user', 'assistant']);
  });

  it('工具失败作为观察回传，随后仍可完成', async () => {
    const client = scripted([[start, calls(call(1)), done], [start, calls(complete(2, '已调整方案')), done]]);
    const events = await collect(manager(client, new InMemoryConversationStore(), true).submit({ mode: 'react', content: '找文件' }));
    expect(events.at(-1)).toMatchObject({ type: 'turn_complete', toolErrorCount: 1 });
    expect(client.requests[1]?.prompt.messages.at(-1)).toMatchObject({ role: 'tool', content: [{ result: { isError: true, content: { error: { code: 'NOT_FOUND' } } } }] });
  });

  it('模型流错误保留已完成业务轨迹', async () => {
    const client = scripted([[start, calls(call(1)), done], [start, { type: 'stream_error', error: { code: 'PROTOCOL_ERROR', message: '协议错误', retryable: false } }]]);
    const store = new InMemoryConversationStore();
    const events = await collect(manager(client, store).submit({ mode: 'react', content: '执行' }));
    expect(events.at(-1)).toMatchObject({ type: 'turn_error', error: { code: 'PROTOCOL_ERROR' } });
    expect(store.getMessages().map((message) => message.role)).toEqual(['user', 'assistant']);
  });

  it('十次不同批次后硬停止且不额外调用模型', async () => {
    const client = scripted(Array.from({ length: 10 }, (_, index) => [start, calls(call(index)), done]));
    const events = await collect(manager(client, new InMemoryConversationStore()).submit({ mode: 'react', content: '循环' }));
    expect(client.requests).toHaveLength(10);
    expect(events.at(-1)).toMatchObject({ type: 'turn_error', error: { code: 'AGENT_LOOP_LIMIT_REACHED' }, promptAudits: expect.arrayContaining([
      expect.objectContaining({ protocol: 'anthropic-messages', model: fakeProfile.model, usage: done.usage }),
    ]) });
    const terminal = events.at(-1) as Extract<TurnEvent, { type: 'turn_error' }>;
    expect(terminal.promptAudits).toHaveLength(10);
    expect(JSON.stringify(terminal.promptAudits)).not.toContain('循环');
  });

  it('单响应 33 个调用不执行，并在三次等价违规后异常停止', async () => {
    const batch = calls(...Array.from({ length: 33 }, (_, index) => call(index)));
    const client = scripted(Array.from({ length: 3 }, () => [start, batch, done]));
    let dispatched = 0;
    const events = await collect(manager(client, new InMemoryConversationStore(), false, () => { dispatched += 1; }).submit({ mode: 'react', content: '过多调用' }));
    expect(dispatched).toBe(0);
    expect(events.at(-1)).toMatchObject({ type: 'turn_error', error: { code: 'AGENT_LOOP_ABNORMAL' } });
  });
});

function scripted(scripts: readonly (readonly LlmStreamEvent[])[]) { return new FakeLlmClient(fakeProfile, scripts.map((events) => events.map((event) => ({ event })))); }
function manager(client: FakeLlmClient, store: InMemoryConversationStore, fail = false, onDispatch: () => void = () => undefined) {
  const dispatch = async (request: ToolCallRequest): Promise<ToolCallResult> => {
    onDispatch();
    return fail
      ? { callId: request.callId, providerCallId: request.providerCallId, toolName: request.name, isError: true, content: { summary: '失败', error: { code: 'NOT_FOUND', message: '不存在', retryable: false } } }
      : { callId: request.callId, providerCallId: request.providerCallId, toolName: request.name, isError: false, content: { summary: '完成', data: { content: 'hello' } } };
  };
  const scheduler = new ToolCallScheduler({ definitions: [definition], dispatch });
  const executor = new SchedulerToolExecutor([definition], scheduler);
  return new ConversationManager(client, store, {
    maxTokens: 100, actionGateway: createTestActionGateway(client, executor), availableTools: [definition],
  });
}
async function collect(events: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> { const result: TurnEvent[] = []; for await (const event of events) result.push(event); return result; }
