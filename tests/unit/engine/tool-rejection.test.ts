import { describe, expect, it, vi } from 'vitest';
import type { LlmClient, ToolDefinition } from '../../../src/shared/types.js';
import type { ResolvedProfile } from '../../../src/config/index.js';
import { AnthropicMessagesClient } from '../../../src/engine/llm/anthropic.js';
import { OpenAIChatCompletionsClient } from '../../../src/engine/llm/openai-chat.js';
import { OpenAIResponsesClient } from '../../../src/engine/llm/openai-responses.js';
import { collect, request } from './helpers.js';

const tool: ToolDefinition = {
  name: 'read_file', purpose: '读取文件', useWhen: ['需要读取'], avoidWhen: ['需要写入'],
  inputSchema: { type: 'object', additionalProperties: false },
  resultSchema: { type: 'object', additionalProperties: false }, worksWith: [], executionMode: 'read_shared',
};

const protocols = [
  ['anthropic-messages', (profile: ResolvedProfile, transport: ReturnType<typeof vi.fn>) => new AnthropicMessagesClient(profile, { transport })],
  ['openai-chat-completions', (profile: ResolvedProfile, transport: ReturnType<typeof vi.fn>) => new OpenAIChatCompletionsClient(profile, { transport })],
  ['openai-responses', (profile: ResolvedProfile, transport: ReturnType<typeof vi.fn>) => new OpenAIResponsesClient(profile, { transport })],
] as const;

describe('provider tool rejection', () => {
  it.each(protocols)('%s 拒绝工具字段时报告模型服务错误且不重试', async (protocol, createClient) => {
    const transport = vi.fn(async () => { throw Object.assign(new Error('unsupported tools: secret'), { status: 400 }); });
    const profile: ResolvedProfile = {
      name: protocol, protocol, model: 'test', baseUrl: 'https://provider.example/v1', apiKey: 'secret-key',
      thinking: false, maxTokens: 100,
    };
    const client: LlmClient = createClient(profile, transport);
    const result = await collect(client.stream({ ...request(), tools: [tool], systemPrompt: '工具原则' }));
    expect(result).toEqual([{ type: 'stream_error', error: {
      code: 'PROVIDER_ERROR', message: '模型服务拒绝了请求。', retryable: false,
    } }]);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('非法工具结果在发送前终止为内部错误', async () => {
    const transport = vi.fn(async () => { throw new Error('must not call'); });
    const profile: ResolvedProfile = {
      name: 'chat', protocol: 'openai-chat-completions', model: 'test', baseUrl: 'https://provider.example/v1',
      apiKey: 'secret-key', thinking: false, maxTokens: 100,
    };
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const client = new OpenAIChatCompletionsClient(profile, { transport });
    const result = await collect(client.stream({ ...request(), messages: [{ role: 'tool', content: [{ type: 'tool_result', result: {
      callId: 'c1', providerCallId: 'p1', toolName: 'read_file', isError: false,
      content: { summary: 'x', data: cyclic },
    } }] }] }));
    expect(result).toEqual([{ type: 'stream_error', error: {
      code: 'INTERNAL_ERROR', message: '模型协议边界处理失败。', retryable: false,
    } }]);
    expect(transport).not.toHaveBeenCalled();
  });
});
