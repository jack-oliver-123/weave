import { describe, expect, it, vi } from 'vitest';
import { AnthropicMessagesClient } from '../../../src/engine/llm/anthropic.js';
import type { ResolvedProfile } from '../../../src/config/index.js';
import { collect, request } from './helpers.js';

const profile: ResolvedProfile = {
  name: 'claude', protocol: 'anthropic-messages', model: 'claude-test',
  baseUrl: 'https://anthropic.example/v1', apiKey: 'test-key', thinking: false, maxTokens: 4096,
};
const start = { type: 'message_start', message: { usage: { input_tokens: 1 } } };
const complete = [
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
];

describe('流生命周期', () => {
  it('transport 建立本身也受首事件超时约束', async () => {
    const client = new AnthropicMessagesClient(profile, {
      timeoutMs: 10,
      transport: () => new Promise<AsyncIterable<unknown>>(() => undefined),
    });
    await expect(collect(client.stream(request()))).resolves.toEqual([{
      type: 'stream_error',
      error: { code: 'LLM_TIMEOUT', message: '等待模型响应超时。', retryable: true },
    }]);
  });

  it('首事件等待 120 秒语义由可注入计时器覆盖，并中止底层流', async () => {
    const closed = vi.fn();
    const client = new AnthropicMessagesClient(profile, {
      timeoutMs: 10,
      transport: ({ signal }) => abortAwareStream(signal, [], closed),
    });

    const result = await collect(client.stream(request()));
    expect(result).toEqual([{
      type: 'stream_error',
      error: { code: 'LLM_TIMEOUT', message: '等待模型响应超时。', retryable: true },
    }]);
    expect(closed).toHaveBeenCalledOnce();
  });

  it('每个原生事件都重置静默计时器，不限制总时长', async () => {
    const client = new AnthropicMessagesClient(profile, {
      timeoutMs: 35,
      transport: async () => delayedStream([
        start,
        { type: 'ping' },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_stop', index: 0 },
        ...complete,
      ], 15),
    });

    const result = await collect(client.stream(request()));
    expect(result.at(-1)).toMatchObject({ type: 'stream_complete', finishReason: 'stop' });
  });

  it('用户取消时静默结束，不转换为网络错误，并释放底层流', async () => {
    const controller = new AbortController();
    const closed = vi.fn();
    const client = new AnthropicMessagesClient(profile, {
      timeoutMs: 1_000,
      transport: ({ signal }) => abortAwareStream(signal, [start], closed),
    });
    const iterator = client.stream(request(controller.signal))[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { type: 'stream_start' } });

    controller.abort();
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    expect(closed).toHaveBeenCalledOnce();
  });

  it('收到终态后调用底层 iterator.return 且不接收迟到事件', async () => {
    const closed = vi.fn();
    const client = new AnthropicMessagesClient(profile, {
      transport: async () => finiteTrackedStream([...([start, ...complete] as unknown[])], closed),
    });

    const result = await collect(client.stream(request()));
    expect(result).toHaveLength(2);
    expect(result.at(-1)?.type).toBe('stream_complete');
    expect(closed).toHaveBeenCalledOnce();
  });
});

function abortAwareStream(
  signal: AbortSignal,
  initial: readonly unknown[],
  closed: () => void,
): AsyncIterable<unknown> {
  let index = 0;
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<unknown>> {
          if (index < initial.length) return { done: false, value: initial[index++] };
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
          return { done: true, value: undefined };
        },
        async return() { closed(); return { done: true, value: undefined }; },
      };
    },
  };
}

async function* delayedStream(events: readonly unknown[], delayMs: number): AsyncIterable<unknown> {
  for (const event of events) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    yield event;
  }
}

function finiteTrackedStream(events: readonly unknown[], closed: () => void): AsyncIterable<unknown> {
  let index = 0;
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (index >= events.length) return { done: true as const, value: undefined };
          return { done: false as const, value: events[index++] };
        },
        async return() { closed(); return { done: true as const, value: undefined }; },
      };
    },
  };
}
