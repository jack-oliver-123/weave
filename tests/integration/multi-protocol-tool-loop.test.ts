import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedProfile } from '../../src/config/index.js';
import { ConversationManager } from '../../src/engine/conversation-manager.js';
import { AnthropicMessagesClient } from '../../src/engine/llm/anthropic.js';
import { OpenAIChatCompletionsClient } from '../../src/engine/llm/openai-chat.js';
import { OpenAIResponsesClient } from '../../src/engine/llm/openai-responses.js';
import { InMemoryConversationStore } from '../../src/memory/conversation-store.js';
import type { LlmClient, TurnEvent } from '../../src/shared/types.js';
import { createCoreToolRegistry } from '../../src/tool/core-tools.js';
import { registryDispatcher } from '../../src/tool/registry.js';
import { ToolCallScheduler } from '../../src/tool/scheduler.js';
import { Workspace } from '../../src/tool/workspace.js';
import { nativeStream } from '../unit/engine/helpers.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('三协议工具闭环', () => {
  it('Anthropic: definitions -> tool_use -> tool_result -> final text', async () => {
    let turn = 0;
    const transport = vi.fn(async (request: any) => {
      turn += 1;
      if (turn === 1) {
        expect(request.tools).toHaveLength(8);
        expect(request.toolChoice).toEqual({ type: 'auto' });
        return nativeStream(anthropicCalls());
      }
      const results = request.messages.at(-1)?.content;
      expect(results).toHaveLength(4);
      expect(results.map((item: any) => item.is_error)).toEqual([false, true, false, false]);
      return nativeStream(anthropicControl('complete_task', { result: '全部完成。', verificationSummary: '文件已复查。' }));
    });
    await verifyLoop(new AnthropicMessagesClient(profile('anthropic-messages'), { transport, createCallId: ids() }), transport);
  });

  it('Chat Completions: definitions -> delta.tool_calls -> role tool -> final text', async () => {
    let turn = 0;
    const transport = vi.fn(async (request: any) => {
      turn += 1;
      if (turn === 1) {
        expect(request.tools).toHaveLength(8);
        expect(request.toolChoice).toBe('auto');
        return nativeStream(chatCalls());
      }
      const results = request.messages.filter((item: any) => item.role === 'tool');
      expect(results).toHaveLength(4);
      expect(results.map((item: any) => JSON.parse(item.content).isError)).toEqual([false, true, false, false]);
      return nativeStream([{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'complete', type: 'function', function: { name: 'complete_task', arguments: JSON.stringify({ result: '全部完成。', verificationSummary: '文件已复查。' }) } }] }, finish_reason: 'tool_calls' }] }]);
    });
    await verifyLoop(new OpenAIChatCompletionsClient(profile('openai-chat-completions'), { transport, createCallId: ids() }), transport);
  });

  it('Responses: definitions -> function call items -> function_call_output -> final text', async () => {
    let turn = 0;
    const transport = vi.fn(async (request: any) => {
      turn += 1;
      if (turn === 1) {
        expect(request.tools).toHaveLength(8);
        expect(request.toolChoice).toBe('auto');
        return nativeStream(responsesCalls());
      }
      const results = request.messages.filter((item: any) => item.type === 'function_call_output');
      expect(results).toHaveLength(4);
      expect(results.map((item: any) => JSON.parse(item.output).isError)).toEqual([false, true, false, false]);
      return nativeStream([
        { type: 'response.created', response: {} },
        { type: 'response.output_item.added', item: { type: 'function_call', id: 'complete-item', call_id: 'complete', name: 'complete_task', arguments: '' } },
        { type: 'response.function_call_arguments.done', item_id: 'complete-item', arguments: JSON.stringify({ result: '全部完成。', verificationSummary: '文件已复查。' }) },
        { type: 'response.output_item.done', item: { type: 'function_call', id: 'complete-item', call_id: 'complete', name: 'complete_task', arguments: JSON.stringify({ result: '全部完成。', verificationSummary: '文件已复查。' }) } },
        { type: 'response.completed', response: {} },
      ]);
    });
    await verifyLoop(new OpenAIResponsesClient(profile('openai-responses'), { transport, createCallId: ids() }), transport);
  });
});

async function verifyLoop(client: LlmClient, transport: ReturnType<typeof vi.fn>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'weave-protocol-loop-'));
  roots.push(root);
  await writeFile(join(root, 'input.txt'), 'hello', 'utf8');
  const registry = createCoreToolRegistry(await Workspace.create(root));
  const store = new InMemoryConversationStore();
  const manager = new ConversationManager(client, store, {
    maxTokens: 100,
    tools: { definitions: registry.listDefinitions(), scheduler: new ToolCallScheduler(registryDispatcher(registry)) },
  });
  const events = await collect(manager.submit({ mode: 'react', content: '读取、创建并复查文件' }));
  expect(events.at(-1)).toMatchObject({
    type: 'turn_complete', modelTurnCount: 2, toolCallCount: 4, toolErrorCount: 1,
  });
  expect(events.filter((event) => event.type === 'tool_call_complete')).toHaveLength(4);
  expect(await readFile(join(root, 'created.txt'), 'utf8')).toBe('created');
  expect(transport).toHaveBeenCalledTimes(2);
  expect(store.getMessages().map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
}

function commonCalls() {
  return [
    ['p1', 'read_file', { path: 'input.txt' }],
    ['p2', 'read_file', { path: 'missing.txt' }],
    ['p3', 'create_file', { path: 'created.txt', content: 'created' }],
    ['p4', 'read_file', { path: 'created.txt' }],
  ] as const;
}

function anthropicCalls(): unknown[] {
  const events: unknown[] = [{ type: 'message_start', message: { usage: { input_tokens: 1 } } }];
  events.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '开始处理。' } });
  events.push({ type: 'content_block_stop', index: 0 });
  commonCalls().forEach(([id, name, input], offset) => {
    const index = offset + 1;
    events.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } });
    const json = JSON.stringify(input);
    events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(0, 5) } });
    events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(5) } });
    events.push({ type: 'content_block_stop', index });
  });
  events.push({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } }, { type: 'message_stop' });
  return events;
}

function anthropicText(text: string): unknown[] {
  return [
    { type: 'message_start', message: { usage: { input_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ];
}

function anthropicControl(name: string, input: unknown): unknown[] {
  return [
    { type: 'message_start', message: { usage: { input_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'complete', name, input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ];
}

function chatCalls(): unknown[] {
  return [{ choices: [{ index: 0, delta: {
    content: '开始处理。',
    tool_calls: commonCalls().map(([id, name, input], index) => ({ index, id, type: 'function', function: { name, arguments: JSON.stringify(input) } })),
  }, finish_reason: 'tool_calls' }] }];
}

function responsesCalls(): unknown[] {
  const events: unknown[] = [{ type: 'response.created', response: {} }, { type: 'response.output_text.delta', delta: '开始处理。' }];
  commonCalls().forEach(([callId, name, input], index) => {
    const id = `item-${index}`;
    const args = JSON.stringify(input);
    events.push({ type: 'response.output_item.added', item: { type: 'function_call', id, call_id: callId, name, arguments: '' } });
    events.push({ type: 'response.function_call_arguments.delta', item_id: id, delta: args });
    events.push({ type: 'response.function_call_arguments.done', item_id: id, arguments: args });
    events.push({ type: 'response.output_item.done', item: { type: 'function_call', id, call_id: callId, name, arguments: args } });
  });
  events.push({ type: 'response.completed', response: {} });
  return events;
}

function profile(protocol: ResolvedProfile['protocol']): ResolvedProfile {
  return { name: protocol, protocol, model: 'test', baseUrl: 'https://provider.example/v1', apiKey: 'test', thinking: false, maxTokens: 100 };
}

function ids(): () => string { let value = 0; return () => `internal-${++value}`; }
async function collect(events: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> { const result: TurnEvent[] = []; for await (const event of events) result.push(event); return result; }
