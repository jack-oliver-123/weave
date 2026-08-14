import { describe, expect, it, vi } from 'vitest';
import { OpenAIResponsesClient } from '../../../src/engine/llm/openai-responses.js';
import type { ResolvedProfile } from '../../../src/config/index.js';
import { collect, nativeStream, request } from './helpers.js';

const profile: ResolvedProfile = {
  name: 'responses',
  protocol: 'openai-responses',
  model: 'gpt-test',
  baseUrl: 'https://openai.example/v1',
  apiKey: 'test-key',
  thinking: false,
  maxTokens: 4096,
};

describe('OpenAIResponsesClient', () => {
  it('转换语义事件、发送完整历史且不使用 previous_response_id', async () => {
    const transport = vi.fn(async () => nativeStream([
      { type: 'response.created', response: { id: 'r1' } },
      { type: 'response.in_progress' },
      { type: 'response.output_text.delta', delta: '你' },
      { type: 'response.output_text.delta', delta: '好' },
      {
        type: 'response.completed',
        response: { usage: { input_tokens: 12, output_tokens: 5, input_tokens_details: { cached_tokens: 7, cache_write_tokens: 3 } } },
      },
    ]));
    const client = new OpenAIResponsesClient(profile, { transport });

    await expect(collect(client.stream(request()))).resolves.toEqual([
      { type: 'stream_start' },
      { type: 'text_delta', delta: '你' },
      { type: 'text_delta', delta: '好' },
      {
        type: 'stream_complete',
        finishReason: 'stop',
        usage: { inputTokens: 12, outputTokens: 5, cacheReadInputTokens: 7, cacheWriteInputTokens: 3 },
      },
    ]);
    const sent = transport.mock.calls[0]?.[0];
    expect(sent).toMatchObject({ messages: request().prompt.messages, maxTokens: 321 });
    expect(sent.instructions).toContain('<identity>');
    expect(sent.instructions).toContain('<system-reminder>');
    expect(sent).not.toHaveProperty('previousResponseId');
    expect(sent).not.toHaveProperty('thinking');
    expect(sent).not.toHaveProperty('reasoning');
  });

  it('仅向 DeepSeek 兼容端点发送 Responses 原生的禁用 reasoning 参数', async () => {
    const transport = vi.fn(async () => nativeStream([
      { type: 'response.created', response: {} },
      { type: 'response.output_text.delta', delta: '好' },
      { type: 'response.completed', response: {} },
    ]));
    const client = new OpenAIResponsesClient({
      ...profile,
      baseUrl: 'https://api.deepseek.com/v1',
    }, { transport });

    await collect(client.stream(request()));

    expect(transport).toHaveBeenCalledWith(expect.objectContaining({
      reasoning: { effort: 'none' },
    }));
    expect(transport.mock.calls[0]?.[0]).not.toHaveProperty('thinking');
  });

  it('转换有文本拒答', async () => {
    const client = new OpenAIResponsesClient(profile, {
      transport: async () => nativeStream([
        { type: 'response.created', response: {} },
        { type: 'response.refusal.delta', delta: '无法回答' },
        { type: 'response.completed', response: {} },
      ]),
    });
    await expect(collect(client.stream(request()))).resolves.toEqual([
      { type: 'stream_start' },
      { type: 'text_delta', delta: '无法回答' },
      { type: 'stream_complete', finishReason: 'refusal' },
    ]);
  });

  it('组装 function call item、参数 delta 与 call_id', async () => {
    let nextId = 0;
    const client = new OpenAIResponsesClient(profile, {
      createCallId: () => `internal-${++nextId}`,
      transport: async () => nativeStream([
        { type: 'response.created', response: {} },
        { type: 'response.output_text.delta', delta: '先检查。' },
        { type: 'response.output_item.added', item: { type: 'function_call', id: 'item-1', call_id: 'call-1', name: 'read_file', arguments: '' } },
        { type: 'response.function_call_arguments.delta', item_id: 'item-1', delta: '{"path":' },
        { type: 'response.function_call_arguments.delta', item_id: 'item-1', delta: '"a.txt"}' },
        { type: 'response.function_call_arguments.done', item_id: 'item-1', arguments: '{"path":"a.txt"}' },
        { type: 'response.output_item.done', item: { type: 'function_call', id: 'item-1', call_id: 'call-1', name: 'read_file', arguments: '{"path":"a.txt"}' } },
        { type: 'response.completed', response: {} },
      ]),
    });
    await expect(collect(client.stream(request()))).resolves.toEqual([
      { type: 'stream_start' },
      { type: 'text_delta', delta: '先检查。' },
      { type: 'tool_calls', calls: [{ callId: 'internal-1', providerCallId: 'call-1', name: 'read_file', input: { path: 'a.txt' } }] },
      { type: 'stream_complete', finishReason: 'stop' },
    ]);
  });

  it.each([
    ['重复 call_id', [
      { type: 'response.created', response: {} },
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'item-1', call_id: 'dup', name: 'read_file' } },
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'item-2', call_id: 'dup', name: 'grep' } },
    ]],
    ['参数超过 64 KiB', [
      { type: 'response.created', response: {} },
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'item-large', call_id: 'large', name: 'read_file' } },
      { type: 'response.function_call_arguments.delta', item_id: 'item-large', delta: 'x'.repeat(64 * 1024 + 1) },
    ]],
    ['item 未闭合', [
      { type: 'response.created', response: {} },
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'item-open', call_id: 'open', name: 'read_file' } },
      { type: 'response.completed', response: {} },
    ]],
  ])('%s 不输出工具调用并返回协议错误', async (_name, events) => {
    const result = await collect(new OpenAIResponsesClient(profile, { transport: async () => nativeStream(events) }).stream(request()));
    expect(result.some((event) => event.type === 'tool_calls')).toBe(false);
    expect(result.at(-1)).toMatchObject({ type: 'stream_error', error: { code: 'PROTOCOL_ERROR' } });
  });

  it.each([
    ['错误事件', [{ type: 'response.created', response: {} }, { type: 'error', code: 'server_error', message: 'secret' }], 'PROVIDER_ERROR'],
    ['失败终态', [{ type: 'response.created', response: {} }, { type: 'response.failed', response: {} }], 'PROVIDER_ERROR'],
    ['非文本输出', [{ type: 'response.created', response: {} }, { type: 'response.output_item.added', item: { type: 'function_call' } }], 'PROTOCOL_ERROR'],
    ['缺少终态', [{ type: 'response.created', response: {} }, { type: 'response.output_text.delta', delta: '半截' }], 'PROTOCOL_ERROR'],
  ])('%s 返回安全错误', async (_name, events, code) => {
    const client = new OpenAIResponsesClient(profile, {
      transport: async () => nativeStream(events),
    });
    const result = await collect(client.stream(request()));
    expect(result.at(-1)).toMatchObject({ type: 'stream_error', error: { code } });
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});
