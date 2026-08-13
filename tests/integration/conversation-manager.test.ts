import { describe, expect, it, vi } from 'vitest';
import { ConversationManager } from '../../src/engine/conversation-manager.js';
import { InMemoryConversationStore } from '../../src/memory/conversation-store.js';
import type { LlmClient, LlmRequest, LlmStreamEvent, ProfileSummary, TurnEvent } from '../../src/shared/types.js';

const profile: ProfileSummary = { name: 'fake', protocol: 'openai-responses', model: 'fake-model' };

describe('对话端口集成', () => {
  it.each([
    ['CONTEXT_LENGTH_EXCEEDED', false],
    ['RATE_LIMITED', true],
  ])('%s 不修改既有历史且不自动重试', async (code, retryable) => {
    const store = new InMemoryConversationStore();
    store.commitTurn({ role: 'user', content: '旧问题' }, { role: 'assistant', content: '旧回答' });
    const before = store.getMessages();
    const stream = vi.fn(async function* (_request: LlmRequest): AsyncIterable<LlmStreamEvent> {
      yield { type: 'stream_start' };
      yield { type: 'stream_error', error: { code, message: '安全错误', retryable } };
    });
    const client: LlmClient = { profile, stream };
    const manager = new ConversationManager(client, store, { maxTokens: 99, createTurnId: () => 'turn' });

    const events: TurnEvent[] = [];
    for await (const event of manager.submit({ mode: 'react', content: '新问题' })) events.push(event);

    expect(stream).toHaveBeenCalledOnce();
    expect(stream.mock.calls[0]?.[0].messages).toEqual([...before, { role: 'user', content: '新问题' }]);
    expect(store.getMessages()).toEqual([
      ...before,
      { role: 'user', content: '新问题' },
      { role: 'assistant', content: '任务状态：安全错误 已完成：无；未完成：新问题；副作用：无；最后异常：安全错误。' },
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'turn_error', restoreInput: '新问题', error: { code, retryable } });
  });
});
