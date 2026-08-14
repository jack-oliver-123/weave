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
      { choices: [], usage: { prompt_tokens: 9, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 2 } } },
    ]));
    const client = new OpenAIChatCompletionsClient(profile, { transport });

    await expect(collect(client.stream(request()))).resolves.toEqual([
      { type: 'stream_start' },
      { type: 'text_delta', delta: '你' },
      { type: 'text_delta', delta: '好' },
      {
        type: 'stream_complete',
        finishReason: 'max_tokens',
        usage: { inputTokens: 9, outputTokens: 4, cacheReadInputTokens: 0, cacheWriteInputTokens: 2 },
      },
    ]);
    const sent = transport.mock.calls[0]?.[0];
    expect(sent).toMatchObject({ maxTokens: 321 });
    expect(sent.messages.slice(0, 2).map((message: { role: string }) => message.role)).toEqual(['system', 'system']);
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

  it('按 profile 配置回退为单个 system 消息', async () => {
    const transport = vi.fn(async () => nativeStream([
      { choices: [{ index: 0, delta: { content: '好' }, finish_reason: 'stop' }] },
    ]));
    const client = new OpenAIChatCompletionsClient({ ...profile, chatSystemMode: 'single' }, { transport });

    await collect(client.stream(request()));

    const sent = transport.mock.calls[0]?.[0];
    expect(sent.messages.filter((message: { role: string }) => message.role === 'system')).toHaveLength(1);
    expect(sent.messages[0].content).toContain('<system-reminder>');
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

  it('按索引组装交错的多个 tool_calls 并保留同响应文本', async () => {
    let nextId = 0;
    const client = new OpenAIChatCompletionsClient(profile, {
      createCallId: () => `internal-${++nextId}`,
      transport: async () => nativeStream([
        { choices: [{ index: 0, delta: { content: '先检查。', tool_calls: [
          { index: 0, id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"pa' } },
          { index: 1, id: 'call-2', type: 'function', function: { name: 'grep', arguments: '{broken' } },
        ] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { tool_calls: [
          { index: 0, function: { arguments: 'th":"a.txt"}' } },
        ] }, finish_reason: 'tool_calls' }] },
      ]),
    });
    await expect(collect(client.stream(request()))).resolves.toEqual([
      { type: 'stream_start' },
      { type: 'text_delta', delta: '先检查。' },
      { type: 'tool_calls', calls: [
        { callId: 'internal-1', providerCallId: 'call-1', name: 'read_file', input: { path: 'a.txt' } },
        { callId: 'internal-2', providerCallId: 'call-2', name: 'grep', input: '{broken' },
      ] },
      { type: 'stream_complete', finishReason: 'stop' },
    ]);
  });

  it.each([
    ['重复 Provider ID', [
      { choices: [{ index: 0, delta: { tool_calls: [
        { index: 0, id: 'dup', function: { name: 'read_file', arguments: '{}' } },
        { index: 1, id: 'dup', function: { name: 'grep', arguments: '{}' } },
      ] }, finish_reason: 'tool_calls' }] },
    ]],
    ['参数超过 64 KiB', [
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'large', function: { name: 'read_file', arguments: 'x'.repeat(64 * 1024 + 1) } }] }, finish_reason: 'tool_calls' }] },
    ]],
    ['异常断流', [
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'open', function: { name: 'read_file', arguments: '{' } }] }, finish_reason: null }] },
    ]],
  ])('%s 不输出工具调用并返回协议错误', async (_name, chunks) => {
    const result = await collect(new OpenAIChatCompletionsClient(profile, { transport: async () => nativeStream(chunks) }).stream(request()));
    expect(result.some((event) => event.type === 'tool_calls')).toBe(false);
    expect(result.at(-1)).toMatchObject({ type: 'stream_error', error: { code: 'PROTOCOL_ERROR' } });
  });

  it('普通 stop 夹带完整 tool_calls 时拒绝执行', async () => {
    const result = await collect(new OpenAIChatCompletionsClient(profile, { transport: async () => nativeStream([
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-odd', function: { name: 'read_file', arguments: '{}' } }] }, finish_reason: 'stop' }] },
    ]) }).stream(request()));
    expect(result.some((event) => event.type === 'tool_calls')).toBe(false);
    expect(result.at(-1)).toMatchObject({ type: 'stream_error', error: { code: 'PROTOCOL_ERROR' } });
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
