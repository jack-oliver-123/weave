import { describe, expect, it } from 'vitest';
import type { ResolvedProfile } from '../../src/config/index.js';
import { ConversationManager } from '../../src/engine/conversation-manager.js';
import { AnthropicMessagesClient } from '../../src/engine/llm/anthropic.js';
import { OpenAIChatCompletionsClient } from '../../src/engine/llm/openai-chat.js';
import { OpenAIResponsesClient } from '../../src/engine/llm/openai-responses.js';
import { InMemoryConversationStore } from '../../src/memory/conversation-store.js';
import type { LlmClient, TurnEvent } from '../../src/shared/types.js';
import { nativeStream } from '../unit/engine/helpers.js';

const submission = { goal: '交付', successCriteria: ['全量通过'], steps: [{ id: 's1', description: '实现', dependencies: [], successCriteria: ['单测通过'] }] };
const stepInput = { stepId: 's1', criteria: [{ criterion: '单测通过', passed: true, evidence: 'unit ok' }] };
const completeInput = { result: '交付完成', verificationSummary: 'all ok', criteria: [{ criterion: '全量通过', passed: true, evidence: 'all ok' }] };

describe('三协议 Plan 闭环', () => {
  it('Anthropic 完成 submit_plan、complete_step 与 complete_task', async () => {
    const scripts = [anthropicControl('submit_plan', submission), anthropicControl('complete_step', stepInput), anthropicControl('complete_task', completeInput)];
    const client = new AnthropicMessagesClient(profile('anthropic-messages'), { transport: async () => nativeStream(scripts.shift()!), createCallId: ids() });
    await verifyPlan(client);
  });

  it('Chat Completions 完成 submit_plan、complete_step 与 complete_task', async () => {
    const scripts = [chatControl('submit_plan', submission), chatControl('complete_step', stepInput), chatControl('complete_task', completeInput)];
    const client = new OpenAIChatCompletionsClient(profile('openai-chat-completions'), { transport: async () => nativeStream(scripts.shift()!), createCallId: ids() });
    await verifyPlan(client);
  });

  it('Responses 完成 submit_plan、complete_step 与 complete_task', async () => {
    const scripts = [responsesControl('submit_plan', submission), responsesControl('complete_step', stepInput), responsesControl('complete_task', completeInput)];
    const client = new OpenAIResponsesClient(profile('openai-responses'), { transport: async () => nativeStream(scripts.shift()!), createCallId: ids() });
    await verifyPlan(client);
  });

  for (const protocol of ['anthropic-messages', 'openai-chat-completions', 'openai-responses'] as const) {
    it(`${protocol}: Plan 执行请求修订且不批准旧版本`, async () => {
      const scripts = [nativeControl(protocol, 'submit_plan', submission), nativeControl(protocol, 'request_plan_revision', { reason: '范围变化', suggestion: '新增验收步骤' })];
      const client = clientFor(protocol, async () => nativeStream(scripts.shift()!));
      const manager = new ConversationManager(client, new InMemoryConversationStore(), { maxTokens: 100, createTaskId: () => 'task-1', createPlanId: () => 'plan-1' });
      const draft = await collect(manager.submit({ mode: 'plan', content: '完成交付' }));
      const ready = draft.find((event): event is Extract<TurnEvent, { type: 'plan_ready' }> => event.type === 'plan_ready')!;
      const events = await collect(manager.dispatch({ type: 'approve_plan', taskId: ready.taskId, planId: ready.plan.planId, version: ready.plan.version }));
      expect(events).toContainEqual(expect.objectContaining({ type: 'plan_revision', reason: '范围变化' }));
      expect(events).toContainEqual(expect.objectContaining({ type: 'task_state', state: 'awaiting_approval' }));
    });
  }
});

async function verifyPlan(client: LlmClient): Promise<void> {
  const store = new InMemoryConversationStore();
  const manager = new ConversationManager(client, store, { maxTokens: 100, createTaskId: () => 'task-1', createPlanId: () => 'plan-1' });
  const draft = await collect(manager.submit({ mode: 'plan', content: '完成交付' }));
  const ready = draft.find((event): event is Extract<TurnEvent, { type: 'plan_ready' }> => event.type === 'plan_ready')!;
  expect(ready.plan).toMatchObject({ planId: 'plan-1', version: 1 });
  const executed = await collect(manager.dispatch({ type: 'approve_plan', taskId: ready.taskId, planId: ready.plan.planId, version: ready.plan.version }));
  expect(executed.filter((event) => event.type === 'plan_step').map((event) => event.status)).toEqual(['running', 'completed']);
  expect(executed.at(-1)?.type).toBe('turn_complete');
  const serialized = JSON.stringify(store.getMessages());
  expect(serialized).toContain('计划 v1');
  expect(serialized).toContain('交付完成');
  expect(serialized).not.toContain('submit_plan');
  expect(serialized).not.toContain('complete_step');
  expect(serialized).not.toContain('complete_task');
}

function anthropicControl(name: string, input: unknown): unknown[] {
  const json = JSON.stringify(input);
  return [
    { type: 'message_start', message: { usage: { input_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `p-${name}`, name, input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: json } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ];
}

function chatControl(name: string, input: unknown): unknown[] {
  return [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `p-${name}`, type: 'function', function: { name, arguments: JSON.stringify(input) } }] }, finish_reason: 'tool_calls' }] }];
}

function responsesControl(name: string, input: unknown): unknown[] {
  const id = `item-${name}`; const callId = `p-${name}`; const args = JSON.stringify(input);
  return [
    { type: 'response.created', response: {} },
    { type: 'response.output_item.added', item: { type: 'function_call', id, call_id: callId, name, arguments: '' } },
    { type: 'response.function_call_arguments.done', item_id: id, arguments: args },
    { type: 'response.output_item.done', item: { type: 'function_call', id, call_id: callId, name, arguments: args } },
    { type: 'response.completed', response: {} },
  ];
}

function nativeControl(protocol: ResolvedProfile['protocol'], name: string, input: unknown): unknown[] {
  if (protocol === 'anthropic-messages') return anthropicControl(name, input);
  if (protocol === 'openai-chat-completions') return chatControl(name, input);
  return responsesControl(name, input);
}

function clientFor(protocol: ResolvedProfile['protocol'], transport: (request: any) => any): LlmClient {
  const options = { transport, createCallId: ids() };
  if (protocol === 'anthropic-messages') return new AnthropicMessagesClient(profile(protocol), options);
  if (protocol === 'openai-chat-completions') return new OpenAIChatCompletionsClient(profile(protocol), options);
  return new OpenAIResponsesClient(profile(protocol), options);
}

function profile(protocol: ResolvedProfile['protocol']): ResolvedProfile {
  return { name: protocol, protocol, model: 'test', baseUrl: 'https://provider.example/v1', apiKey: 'test', thinking: false, maxTokens: 100 };
}
function ids(): () => string { let value = 0; return () => `internal-${++value}`; }
async function collect(events: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> { const result: TurnEvent[] = []; for await (const event of events) result.push(event); return result; }
