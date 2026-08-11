import { describe, expect, it, vi } from 'vitest';
import { ConversationBusyError, ConversationManager } from '../../../src/engine/conversation-manager.js';
import { InMemoryConversationStore } from '../../../src/memory/conversation-store.js';
import type { LlmClient, LlmRequest, LlmStreamEvent, ProfileSummary, TurnEvent } from '../../../src/shared/types.js';
import { FakeLlmClient } from '../../fixtures/fake-llm-client.js';

const profile: ProfileSummary = { name: 'fake', protocol: 'anthropic-messages', model: 'fake-model' };
const start: LlmStreamEvent = { type: 'stream_start' };
const delta = (text: string): LlmStreamEvent => ({ type: 'text_delta', delta: text });
const complete = (finishReason: 'stop' | 'max_tokens' | 'refusal' | 'content_filter'): LlmStreamEvent => ({
  type: 'stream_complete', finishReason, usage: { inputTokens: 3, outputTokens: 2 },
});

describe('ConversationManager', () => {
  it('发布唯一 turn 生命周期并在第二轮发送完整历史', async () => {
    const client = new FakeLlmClient(profile, [
      [{ event: start }, { event: delta('答') }, { event: delta('一') }, { event: complete('stop') }],
      [{ event: start }, { event: delta('答二') }, { event: complete('stop') }],
    ]);
    const store = new InMemoryConversationStore();
    const manager = managerFor(client, store);

    const first = await collect(manager.submit({ content: '第一问' }));
    const second = await collect(manager.submit({ content: '第二问' }));

    expect(first.map((event) => event.type)).toEqual(['turn_start', 'text_delta', 'text_delta', 'turn_complete']);
    expect(new Set(first.map((event) => event.turnId))).toEqual(new Set(['turn-1']));
    expect(second.every((event) => event.turnId === 'turn-2')).toBe(true);
    expect(client.requests[1]?.messages).toEqual([
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '答一' },
      { role: 'user', content: '第二问' },
    ]);
    expect(second.at(-1)).toMatchObject({
      type: 'turn_complete', status: 'completed', finishReason: 'stop',
      usage: { inputTokens: 3, outputTokens: 2 }, durationMs: 5,
    });
  });

  it('活动 turn 未结束时同步拒绝并发提交且不创建请求', async () => {
    const client = new ControllableClient();
    const manager = managerFor(client, new InMemoryConversationStore());
    const first = manager.submit({ content: '第一问' });
    expect(() => manager.submit({ content: '第二问' })).toThrow(ConversationBusyError);
    expect(client.requests).toHaveLength(0);
    const collecting = collect(first);
    await client.started;
    expect(client.requests).toHaveLength(1);
    client.finish();
    await collecting;
  });

  it.each([
    ['正常完成', [start, delta('文本'), complete('stop')], 'completed', true],
    ['max_tokens 截断', [start, delta('半截'), complete('max_tokens')], 'truncated', true],
    ['有文本拒答', [start, delta('拒答'), complete('refusal')], 'refused', true],
    ['有文本内容过滤', [start, delta('过滤说明'), complete('content_filter')], 'refused', true],
    ['无文本拒答', [start, complete('refusal')], 'error', false],
    ['网络错误', [start, { type: 'stream_error', error: { code: 'NETWORK_ERROR', message: '无法连接模型服务。', retryable: true } } as LlmStreamEvent], 'error', false],
    ['协议错误', [start, delta('半截'), { type: 'stream_error', error: { code: 'PROTOCOL_ERROR', message: '协议错误。', retryable: false } } as LlmStreamEvent], 'error', false],
  ])('%s 遵守历史提交矩阵', async (_name, events, outcome, shouldCommit) => {
    const client = new FakeLlmClient(profile, [events.map((event) => ({ event }))]);
    const store = new InMemoryConversationStore();
    const result = await collect(managerFor(client, store).submit({ content: '原始输入' }));
    expect(result.at(-1)?.type).toBe(outcome === 'error' ? 'turn_error' : 'turn_complete');
    if (outcome !== 'error') expect(result.at(-1)).toMatchObject({ status: outcome });
    if (outcome === 'error') expect(result.at(-1)).toMatchObject({ restoreInput: '原始输入' });
    expect(store.getMessages()).toHaveLength(shouldCommit ? 2 : 0);
  });

  it('取消后只发布取消终态，丢弃半截与迟到事件且不提交历史', async () => {
    const client = new LateEventClient();
    const store = new InMemoryConversationStore();
    const manager = managerFor(client, store);
    const events: TurnEvent[] = [];
    const consuming = (async () => {
      for await (const event of manager.submit({ content: '取消我' })) {
        events.push(event);
        if (event.type === 'text_delta') manager.cancel();
      }
    })();
    await consuming;

    expect(events.map((event) => event.type)).toEqual(['turn_start', 'text_delta', 'turn_cancelled']);
    expect(events.some((event) => event.type === 'text_delta' && event.delta === '迟到')).toBe(false);
    expect(store.getMessages()).toEqual([]);
  });

  it('可重试错误不自动重试并恢复输入', async () => {
    const stream = vi.fn(async function* () {
      yield { type: 'stream_start' } as const;
      yield { type: 'stream_error', error: { code: 'RATE_LIMITED', message: '请求过于频繁。', retryable: true } } as const;
    });
    const client: LlmClient = { profile, stream };
    const result = await collect(managerFor(client, new InMemoryConversationStore()).submit({ content: '再试一次' }));
    expect(stream).toHaveBeenCalledOnce();
    expect(result.at(-1)).toMatchObject({
      type: 'turn_error', restoreInput: '再试一次', error: { code: 'RATE_LIMITED', retryable: true },
    });
  });
});

function managerFor(client: LlmClient, store: InMemoryConversationStore): ConversationManager {
  let id = 0;
  let now = 100;
  return new ConversationManager(client, store, {
    maxTokens: 123,
    createTurnId: () => `turn-${++id}`,
    now: () => (now += 5),
  });
}

async function collect(events: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const result: TurnEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

class ControllableClient implements LlmClient {
  readonly profile = profile;
  readonly requests: LlmRequest[] = [];
  private release!: () => void;
  private markStarted!: () => void;
  readonly started = new Promise<void>((resolve) => { this.markStarted = resolve; });
  private readonly released = new Promise<void>((resolve) => { this.release = resolve; });
  finish(): void { this.release(); }
  async *stream(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
    this.requests.push(request);
    this.markStarted();
    yield start;
    await this.released;
    yield complete('stop');
  }
}

class LateEventClient implements LlmClient {
  readonly profile = profile;
  async *stream(_request: LlmRequest): AsyncIterable<LlmStreamEvent> {
    yield start;
    yield delta('半截');
    yield delta('迟到');
    yield complete('stop');
  }
}
