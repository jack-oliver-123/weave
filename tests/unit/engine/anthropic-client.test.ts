import { describe, expect, it, vi } from 'vitest';
import { AnthropicMessagesClient } from '../../../src/engine/llm/anthropic.js';
import type { ResolvedProfile } from '../../../src/config/index.js';
import { collect, nativeStream, request } from './helpers.js';

const profile: ResolvedProfile = {
  name: 'claude',
  protocol: 'anthropic-messages',
  model: 'claude-test',
  baseUrl: 'https://anthropic.example/v1',
  apiKey: 'test-key',
  thinking: false,
  maxTokens: 4096,
};

const start = {
  type: 'message_start',
  message: { usage: { input_tokens: 11 } },
};

describe('AnthropicMessagesClient', () => {
  it('按严格时序转换多个文本块、心跳、完成原因和真实 usage', async () => {
    const transport = vi.fn(async () => nativeStream([
      { type: 'message_start', message: { usage: { input_tokens: 11, cache_read_input_tokens: 6, cache_creation_input_tokens: 4 } } },
      { type: 'ping' },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'future.telemetry', value: 1 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '好' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 7 } },
      { type: 'message_stop' },
    ]));
    const client = new AnthropicMessagesClient(profile, { transport });

    await expect(collect(client.stream(request()))).resolves.toEqual([
      { type: 'stream_start' },
      { type: 'text_delta', delta: '你' },
      { type: 'text_delta', delta: '好' },
      {
        type: 'stream_complete',
        finishReason: 'max_tokens',
        usage: { inputTokens: 11, outputTokens: 7, cacheReadInputTokens: 6, cacheWriteInputTokens: 4 },
      },
    ]);
    expect(transport).toHaveBeenCalledWith(expect.objectContaining({
      model: 'claude-test',
      maxTokens: 321,
      messages: request().prompt.messages,
      thinking: { type: 'disabled' },
    }));
    expect(transport.mock.calls[0]?.[0].system).toHaveLength(2);
    expect(transport.mock.calls[0]?.[0].system[0]).not.toHaveProperty('cache_control');
  });

  it('仅向 Anthropic 官方端点的稳定系统块添加缓存断点', async () => {
    const transport = vi.fn(async () => nativeStream([
      start,
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '好' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ]));
    const client = new AnthropicMessagesClient({ ...profile, baseUrl: 'https://api.anthropic.com' }, { transport });
    await collect(client.stream(request()));
    expect(transport.mock.calls[0]?.[0].system[0]).toMatchObject({ cache_control: { type: 'ephemeral' } });
    expect(transport.mock.calls[0]?.[0].system[1]).not.toHaveProperty('cache_control');
  });

  it('在同一消息中保留文本并组装碎片化的多个 tool_use', async () => {
    let nextId = 0;
    const client = new AnthropicMessagesClient(profile, {
      createCallId: () => `internal-${++nextId}`,
      transport: async () => nativeStream([
        start,
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '先检查。' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu-1', name: 'read_file', input: {} } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"a.txt"}' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu-2', name: 'grep', input: {} } },
        { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{broken' } },
        { type: 'content_block_stop', index: 2 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } },
        { type: 'message_stop' },
      ]),
    });
    await expect(collect(client.stream(request()))).resolves.toEqual([
      { type: 'stream_start' },
      { type: 'text_delta', delta: '先检查。' },
      { type: 'tool_calls', calls: [
        { callId: 'internal-1', providerCallId: 'toolu-1', name: 'read_file', input: { path: 'a.txt' } },
        { callId: 'internal-2', providerCallId: 'toolu-2', name: 'grep', input: '{broken' },
      ] },
      { type: 'stream_complete', finishReason: 'stop', usage: { inputTokens: 11, outputTokens: 8 } },
    ]);
  });

  it.each([
    ['重复 Provider ID', [
      start,
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'dup', name: 'read_file' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'dup', name: 'grep' } },
    ]],
    ['参数超过 64 KiB', [
      start,
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu-large', name: 'read_file' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'x'.repeat(64 * 1024 + 1) } },
    ]],
    ['工具块未闭合', [
      start,
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu-open', name: 'read_file' } },
    ]],
  ])('%s 不输出工具调用并返回协议错误', async (_name, events) => {
    const result = await collect(new AnthropicMessagesClient(profile, { transport: async () => nativeStream(events) }).stream(request()));
    expect(result.some((event) => event.type === 'tool_calls')).toBe(false);
    expect(result.at(-1)).toMatchObject({ type: 'stream_error', error: { code: 'PROTOCOL_ERROR' } });
  });

  it('max_tokens 结束即使工具块完整也不得输出可执行调用', async () => {
    const result = await collect(new AnthropicMessagesClient(profile, { transport: async () => nativeStream([
      start,
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu-cut', name: 'read_file' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"a.txt"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 9 } },
      { type: 'message_stop' },
    ]) }).stream(request()));
    expect(result.some((event) => event.type === 'tool_calls')).toBe(false);
    expect(result.at(-1)).toMatchObject({ type: 'stream_error', error: { code: 'PROTOCOL_ERROR' } });
  });

  it.each([
    ['缺少 message_start', [{ type: 'message_stop' }]],
    ['事件乱序', [start, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } }]],
    ['索引不匹配', [start, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_stop', index: 1 }]],
    ['非文本块', [start, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use' } }]],
    ['异常断流', [start, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_stop', index: 0 }]],
  ])('%s 返回安全协议错误', async (_name, events) => {
    const client = new AnthropicMessagesClient(profile, {
      transport: async () => nativeStream(events),
    });

    const result = await collect(client.stream(request()));
    expect(result.at(-1)).toEqual({
      type: 'stream_error',
      error: {
        code: 'PROTOCOL_ERROR',
        message: '供应商返回了无法识别的流式响应。',
        retryable: false,
      },
    });
    expect(JSON.stringify(result)).not.toContain(profile.apiKey);
  });
});
