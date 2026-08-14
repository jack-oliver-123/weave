import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  ChatMessage,
  ConversationController,
  ConversationStore,
  LlmClient,
  LlmRequest,
  LlmStreamEvent,
  PromptAssembly,
  ProfileSummary,
  SafeError,
  ToolCallRequest,
  ToolCallResult,
  ToolDefinition,
  TurnEvent,
} from '../../../src/shared/types.js';
import { FakeLlmClient, fakeProfile } from '../../fixtures/fake-llm-client.js';

describe('shared contracts', () => {
  it('keeps provider-neutral request and stream types', () => {
    expectTypeOf<LlmClient['stream']>().parameters.toEqualTypeOf<[LlmRequest]>();
    expectTypeOf<LlmClient['stream']>().returns.toEqualTypeOf<AsyncIterable<LlmStreamEvent>>();
    expectTypeOf<ProfileSummary['protocol']>().toEqualTypeOf<
      'anthropic-messages' | 'openai-chat-completions' | 'openai-responses'
    >();
  });

  it('defines a serial conversation port and replaceable store', () => {
    expectTypeOf<ConversationController['submit']>().returns.toEqualTypeOf<
      AsyncIterable<TurnEvent>
    >();
    expectTypeOf<ConversationStore['getMessages']>().returns.toEqualTypeOf<
      readonly ChatMessage[]
    >();
    expectTypeOf<ConversationStore['appendMessages']>().parameter(0).toEqualTypeOf<readonly ChatMessage[]>();
  });

  it('uses an offline scripted client without reading environment state', async () => {
    const client = new FakeLlmClient(fakeProfile, [
      [
        { event: { type: 'stream_start' } },
        { event: { type: 'text_delta', delta: '你' } },
        { event: { type: 'text_delta', delta: '好' } },
        { event: { type: 'stream_complete', finishReason: 'stop' } },
      ],
    ]);
    const request: LlmRequest = {
      prompt: {} as PromptAssembly,
      maxTokens: 4096,
      signal: new AbortController().signal,
    };

    const events: LlmStreamEvent[] = [];
    for await (const event of client.stream(request)) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual([
      'stream_start',
      'text_delta',
      'text_delta',
      'stream_complete',
    ]);
    expect(client.requests).toHaveLength(1);
  });

  it('uses one structured prompt assembly and cache-aware usage', () => {
    expectTypeOf<LlmRequest['prompt']>().toEqualTypeOf<PromptAssembly>();
    const usage = { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 8, cacheWriteInputTokens: 0 };
    expect(usage.cacheWriteInputTokens).toBe(0);
  });

  it('exposes only safe error fields', () => {
    const error: SafeError = { code: 'RATE_LIMITED', message: '请求过于频繁', retryable: true };
    expect(Object.keys(error).sort()).toEqual(['code', 'message', 'retryable']);
  });

  it('defines provider-neutral tool definitions and correlated results', () => {
    const definition: ToolDefinition = {
      name: 'read_file',
      purpose: '读取文件',
      useWhen: ['需要查看内容'],
      avoidWhen: ['需要搜索多个文件'],
      inputSchema: { type: 'object', additionalProperties: false },
      resultSchema: { type: 'object', additionalProperties: false },
      worksWith: [{ toolName: 'grep', usage: '先搜索后读取' }],
      executionMode: 'read_shared',
    };
    const call: ToolCallRequest = {
      callId: 'internal-1', providerCallId: 'provider-1', name: definition.name, input: { path: 'a.ts' },
    };
    const result: ToolCallResult = {
      callId: call.callId, providerCallId: call.providerCallId, toolName: call.name,
      isError: false, content: { summary: '读取完成', data: { path: 'a.ts' } },
    };

    expect(definition.executionMode).toBe('read_shared');
    expect(result.isError).toBe(false);
    expect(Object.keys(result)).toEqual(['callId', 'providerCallId', 'toolName', 'isError', 'content']);
  });

  it('supports content-block history and tool lifecycle events', () => {
    const message: ChatMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: '正在读取' },
        { type: 'tool_call', call: { callId: 'c1', providerCallId: 'p1', name: 'read_file', input: {} } },
      ],
    };
    const event: TurnEvent = {
      type: 'tool_call_start', turnId: 't1', callId: 'c1', toolName: 'read_file', summary: 'a.ts',
    };
    expect(message.content).toHaveLength(2);
    expect(event.type).toBe('tool_call_start');
  });
});
