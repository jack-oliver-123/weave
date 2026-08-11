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
        response: { usage: { input_tokens: 12, output_tokens: 5 } },
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
        usage: { inputTokens: 12, outputTokens: 5 },
      },
    ]);
    const sent = transport.mock.calls[0]?.[0];
    expect(sent).toMatchObject({ messages: request().messages, maxTokens: 321 });
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
