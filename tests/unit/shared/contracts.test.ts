import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  ChatMessage,
  ConversationController,
  ConversationStore,
  LlmClient,
  LlmRequest,
  LlmStreamEvent,
  ProfileSummary,
  SafeError,
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
      messages: [{ role: 'user', content: '你好' }],
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

  it('exposes only safe error fields', () => {
    const error: SafeError = { code: 'RATE_LIMITED', message: '请求过于频繁', retryable: true };
    expect(Object.keys(error).sort()).toEqual(['code', 'message', 'retryable']);
  });
});
