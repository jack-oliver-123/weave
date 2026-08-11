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
      start,
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
        usage: { inputTokens: 11, outputTokens: 7 },
      },
    ]);
    expect(transport).toHaveBeenCalledWith(expect.objectContaining({
      model: 'claude-test',
      maxTokens: 321,
      messages: request().messages,
      thinking: { type: 'disabled' },
    }));
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
