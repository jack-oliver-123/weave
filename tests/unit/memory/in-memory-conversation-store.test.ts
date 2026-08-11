import { describe, expect, it } from 'vitest';
import { InMemoryConversationStore } from '../../../src/memory/conversation-store.js';
import type { ConversationStore } from '../../../src/shared/types.js';

describe('InMemoryConversationStore', () => {
  it('按 user/assistant 消息对保存并返回完整历史', () => {
    const store = new InMemoryConversationStore();
    store.commitTurn({ role: 'user', content: '一' }, { role: 'assistant', content: '答一' });
    store.commitTurn({ role: 'user', content: '二' }, { role: 'assistant', content: '答二' });
    expect(store.getMessages()).toEqual([
      { role: 'user', content: '一' }, { role: 'assistant', content: '答一' },
      { role: 'user', content: '二' }, { role: 'assistant', content: '答二' },
    ]);
  });

  it('返回副本且新进程实例从空历史开始', () => {
    const first = new InMemoryConversationStore();
    first.commitTurn({ role: 'user', content: '一' }, { role: 'assistant', content: '答一' });
    const snapshot = first.getMessages() as Array<{ role: 'user' | 'assistant'; content: string }>;
    snapshot.push({ role: 'user', content: '污染' });
    expect(first.getMessages()).toHaveLength(2);
    expect(new InMemoryConversationStore().getMessages()).toEqual([]);
  });

  it('可通过共享存储端口替换', () => {
    const replacement: ConversationStore = {
      getMessages: () => [{ role: 'user', content: '外部存储' }],
      commitTurn: () => undefined,
    };
    expect(replacement.getMessages()).toHaveLength(1);
  });
});
