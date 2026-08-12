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

  it('按阶段追加并回放中立文本、工具调用与工具结果块', () => {
    const store = new InMemoryConversationStore();
    const call = { callId: 'c1', providerCallId: 'p1', name: 'read_file', input: { path: 'a.txt' } };
    const result = {
      callId: 'c1', providerCallId: 'p1', toolName: 'read_file', isError: false,
      content: { summary: '读取完成', data: { content: 'hello' } },
    };
    store.appendMessages([{ role: 'user', content: '读取文件' }]);
    store.appendMessages([{ role: 'assistant', content: [
      { type: 'text', text: '我来读取。' }, { type: 'tool_call', call },
    ] }]);
    store.appendMessages([{ role: 'tool', content: [{ type: 'tool_result', result }] }]);
    const snapshot = store.getMessages();
    expect(snapshot).toEqual([
      { role: 'user', content: '读取文件' },
      { role: 'assistant', content: [{ type: 'text', text: '我来读取。' }, { type: 'tool_call', call }] },
      { role: 'tool', content: [{ type: 'tool_result', result }] },
    ]);
    (snapshot[1]!.content as { type: string; text?: string }[])[0]!.text = '被修改';
    expect((store.getMessages()[1]!.content as { type: string; text?: string }[])[0]).toMatchObject({ text: '我来读取。' });
  });

  it('可通过共享存储端口替换', () => {
    const replacement: ConversationStore = {
      getMessages: () => [{ role: 'user', content: '外部存储' }],
      appendMessages: () => undefined,
      commitTurn: () => undefined,
    };
    expect(replacement.getMessages()).toHaveLength(1);
  });
});
