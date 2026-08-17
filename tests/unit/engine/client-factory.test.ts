import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createLlmClient } from '../../../src/engine/llm/factory.js';
import { AnthropicMessagesClient } from '../../../src/engine/llm/anthropic.js';
import { OpenAIChatCompletionsClient } from '../../../src/engine/llm/openai-chat.js';
import { OpenAIResponsesClient } from '../../../src/engine/llm/openai-responses.js';
import type { LlmProtocol } from '../../../src/shared/types.js';

const base = { name: 'test', model: 'model', baseUrl: 'https://example.test/v1', apiKey: 'key', thinking: false as const, maxTokens: 1 };

describe('LLM 客户端工厂和边界', () => {
  it.each([
    ['anthropic-messages', AnthropicMessagesClient],
    ['openai-chat-completions', OpenAIChatCompletionsClient],
    ['openai-responses', OpenAIResponsesClient],
  ] as const)('为 %s 创建对应适配器', (protocol, Constructor) => {
    expect(createLlmClient({ ...base, protocol: protocol as LlmProtocol })).toBeInstanceOf(Constructor);
  });

  it('共享契约不包含 SDK 类型、供应商事件、鉴权头或响应体', async () => {
    const source = await readFile(new URL('../../../src/shared/types.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/@anthropic-ai|from ['"]openai|['"]authorization['"]|x-api-key/i);
    expect(source).not.toMatch(/message_start|content_block_delta|chat\.completion\.chunk|response\.output_text/);
    expect(source).not.toMatch(/ResponseStreamEvent|MessageStreamEvent|ChatCompletionChunk/);
  });
});
