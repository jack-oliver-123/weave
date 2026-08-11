import { describe, expect, it, vi } from 'vitest';
import { OpenAIChatCompletionsClient } from '../../../src/engine/llm/openai-chat.js';
import type { ResolvedProfile } from '../../../src/config/index.js';
import { collect, nativeStream, request } from './helpers.js';

const profile: ResolvedProfile = {
  name: 'chat',
  protocol: 'openai-chat-completions',
  model: 'gpt-test',
  baseUrl: 'https://openai.example/v1',
  apiKey: 'test-key',
  thinking: false,
  maxTokens: 4096,
};

describe('OpenAIChatCompletionsClient', () => {
  it('转换文本、空 delta、完成原因与 usage，并映射输出上限', async () => {
    const transport = vi.fn(async () => nativeStream([
      { choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: '你' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: '好' }, finish_reason: 'length' }] },
      { choices: [], usage: { prompt_tokens: 9, completion_tokens: 4 } },
    ]));
    const client = new OpenAIChatCompletionsClient(profile, { transport });

    await expect(collect(client.stream(request()))).resolves.toEqual([
      { type: 'stream_start' },
      { type: 'text_delta', delta: '你' },
      { type: 'text_delta', delta: '好' },
      {
        type: 'stream_complete',
        finishReason: 'max_tokens',
        usage: { inputTokens: 9, outputTokens: 4 },
      },
    ]);
    const sent = transport.mock.calls[0]?.[0];
    expect(sent).toMatchObject({ maxTokens: 321 });
    expect(sent).not.toHaveProperty('thinking');
  });

  it('仅向 DeepSeek 兼容端点发送禁用 thinking 扩展', async () => {
    const transport = vi.fn(async () => nativeStream([
      { choices: [{ index: 0, delta: { content: '好' }, finish_reason: 'stop' }] },
    ]));
    const client = new OpenAIChatCompletionsClient({
      ...profile,
      baseUrl: 'https://api.deepseek.com',
    }, { transport });

    await collect(client.stream(request()));

    expect(transport).toHaveBeenCalledWith(expect.objectContaining({
      thinking: { type: 'disabled' },
    }));
  });

  it('保留有文本拒答并映射为 refusal', async () => {
    const client = new OpenAIChatCompletionsClient(profile, {
      transport: async () => nativeStream([
        { choices: [{ index: 0, delta: { refusal: '无法回答' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ]),
    });

    await expect(collect(client.stream(request()))).resolves.toEqual([
      { type: 'stream_start' },
      { type: 'text_delta', delta: '无法回答' },
      { type: 'stream_complete', finishReason: 'refusal' },
    ]);
  });

  it.each([
    ['没有终态', [{ choices: [{ index: 0, delta: { content: '半截' }, finish_reason: null }] }]],
    ['多 choice', [{ choices: [{ index: 0, delta: {}, finish_reason: null }, { index: 1, delta: {}, finish_reason: null }] }]],
    ['工具调用', [{ choices: [{ index: 0, delta: { tool_calls: [{}] }, finish_reason: 'tool_calls' }] }]],
  ])('%s 返回安全协议错误', async (_name, chunks) => {
    const client = new OpenAIChatCompletionsClient(profile, {
      transport: async () => nativeStream(chunks),
    });
    expect((await collect(client.stream(request()))).at(-1)).toMatchObject({
      type: 'stream_error',
      error: { code: 'PROTOCOL_ERROR', retryable: false },
    });
  });
});
