import { describe, expect, it } from 'vitest';
import type { ResolvedProfile } from '../../src/config/index.js';
import { ConversationManager } from '../../src/engine/conversation-manager.js';
import { AnthropicMessagesClient } from '../../src/engine/llm/anthropic.js';
import { OpenAIChatCompletionsClient } from '../../src/engine/llm/openai-chat.js';
import { OpenAIResponsesClient } from '../../src/engine/llm/openai-responses.js';
import { InMemoryConversationStore } from '../../src/memory/conversation-store.js';
import type { LlmClient, TurnEvent } from '../../src/shared/types.js';
import { nativeStream } from '../unit/engine/helpers.js';

type Protocol = ResolvedProfile['protocol'];
const protocols: readonly Protocol[] = ['anthropic-messages', 'openai-chat-completions', 'openai-responses'];

describe('三协议控制与取消闭环', () => {
  for (const protocol of protocols) {
    it(`${protocol}: 普通文本纠正后 request_user_input`, async () => {
      const scripts = [plainText(protocol, '只是说明'), control(protocol, 'request_user_input', { prompt: '请选择目标' })];
      const client = clientFor(protocol, async () => nativeStream(scripts.shift()!));
      const manager = new ConversationManager(client, new InMemoryConversationStore(), { maxTokens: 100, createQuestionId: () => 'q1' });
      const events = await collect(manager.submit({ mode: 'react', content: '执行任务' }));
      expect(events.at(-1)?.type).toBe('turn_complete');
      expect(events).toContainEqual(expect.objectContaining({ type: 'task_state', state: 'awaiting_input', questionId: 'q1' }));
    });

    it(`${protocol}: 取消底层模型流并只发布取消终态`, async () => {
      let started!: () => void;
      const gate = new Promise<void>((resolve) => { started = resolve; });
      const client = clientFor(protocol, async (request: { signal: AbortSignal }) => cancellingStream(protocol, request.signal, started));
      const manager = new ConversationManager(client, new InMemoryConversationStore(), { maxTokens: 100 });
      const collecting = collect(manager.submit({ mode: 'react', content: '取消任务' }));
      await gate;
      manager.cancel();
      const events = await collecting;
      expect(events.at(-1)?.type).toBe('turn_cancelled');
      expect(events.filter((event) => event.type === 'turn_cancelled')).toHaveLength(1);
    });
  }
});

function clientFor(protocol: Protocol, transport: (request: any) => any): LlmClient {
  const options = { transport, createCallId: ids() };
  if (protocol === 'anthropic-messages') return new AnthropicMessagesClient(profile(protocol), options);
  if (protocol === 'openai-chat-completions') return new OpenAIChatCompletionsClient(profile(protocol), options);
  return new OpenAIResponsesClient(profile(protocol), options);
}

function plainText(protocol: Protocol, text: string): unknown[] {
  if (protocol === 'anthropic-messages') return [
    { type: 'message_start', message: { usage: { input_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }, { type: 'message_stop' },
  ];
  if (protocol === 'openai-chat-completions') return [{ choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] }];
  return [{ type: 'response.created', response: {} }, { type: 'response.output_text.delta', delta: text }, { type: 'response.completed', response: {} }];
}

function control(protocol: Protocol, name: string, input: unknown): unknown[] {
  const args = JSON.stringify(input);
  if (protocol === 'anthropic-messages') return [
    { type: 'message_start', message: { usage: { input_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `p-${name}`, name, input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: args } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } }, { type: 'message_stop' },
  ];
  if (protocol === 'openai-chat-completions') return [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `p-${name}`, type: 'function', function: { name, arguments: args } }] }, finish_reason: 'tool_calls' }] }];
  const id = `item-${name}`;
  return [{ type: 'response.created', response: {} },
    { type: 'response.output_item.added', item: { type: 'function_call', id, call_id: `p-${name}`, name, arguments: '' } },
    { type: 'response.function_call_arguments.done', item_id: id, arguments: args },
    { type: 'response.output_item.done', item: { type: 'function_call', id, call_id: `p-${name}`, name, arguments: args } },
    { type: 'response.completed', response: {} }];
}

async function* cancellingStream(protocol: Protocol, signal: AbortSignal, started: () => void): AsyncGenerator<unknown> {
  if (protocol === 'anthropic-messages') yield { type: 'message_start', message: { usage: { input_tokens: 1 } } };
  else if (protocol === 'openai-chat-completions') yield { choices: [] };
  else yield { type: 'response.created', response: {} };
  started();
  await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}

function profile(protocol: Protocol): ResolvedProfile { return { name: protocol, protocol, model: 'test', baseUrl: 'https://provider.example/v1', apiKey: 'test', thinking: false, maxTokens: 100 }; }
function ids(): () => string { let value = 0; return () => `internal-${++value}`; }
async function collect(events: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> { const result: TurnEvent[] = []; for await (const event of events) result.push(event); return result; }
