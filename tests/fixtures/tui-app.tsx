import React from 'react';
import { ConversationManager } from '../../src/engine/conversation-manager.js';
import { runTui } from '../../src/interaction/weave-tui.js';
import { InMemoryConversationStore } from '../../src/memory/conversation-store.js';
import type { LlmClient, LlmRequest, LlmStreamEvent, ProfileSummary } from '../../src/shared/types.js';

const profile: ProfileSummary = {
  name: 'deterministic-fixture',
  protocol: 'openai-responses',
  model: 'fixture-model',
};

class TuiFixtureClient implements LlmClient {
  readonly profile = profile;
  private requestCount = 0;

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
    this.requestCount += 1;
    yield { type: 'stream_start' };

    if (this.requestCount === 1) {
      await delay(250, request.signal);
      yield { type: 'text_delta', delta: '### first-chunk' };
      await delay(8_000, request.signal);
      yield { type: 'text_delta', delta: '\n\n**second-chunk**' };
      yield { type: 'stream_complete', finishReason: 'stop', usage: { inputTokens: 2, outputTokens: 6 } };
      return;
    }

    if (this.requestCount === 2) {
      const queueIsMerged = request.messages.length === 3
        && request.messages[0]?.content === 'first-question'
        && request.messages[1]?.content === '### first-chunk\n\n**second-chunk**'
        && request.messages[2]?.content === 'queued-one\n\nqueued-two';
      yield { type: 'text_delta', delta: queueIsMerged ? '### queue-ok\n\n' : '### queue-missing\n\n' };
      yield { type: 'text_delta', delta: '| 名称 | 说明 |\n| --- | --- |\n| Weave | 终端助手 |\n\n```ts\nconst longName = "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz";\n```\n' };
      yield { type: 'stream_complete', finishReason: 'stop', usage: { inputTokens: 9, outputTokens: 24 } };
      return;
    }

    if (this.requestCount === 3) {
      const historyIsComplete = request.messages.length === 5
        && request.messages[4]?.content === 'line-one\nline-two';
      yield { type: 'text_delta', delta: historyIsComplete ? 'history-ok\n' : 'history-missing\n' };
      await delay(700, request.signal);
      yield { type: 'text_delta', delta: `${Array.from({ length: 32 }, (_, index) => `long-line-${String(index + 1).padStart(2, '0')}`).join('\n')}\n${historyIsComplete ? 'history-ok-tail' : 'history-missing-tail'}` };
      yield { type: 'stream_complete', finishReason: 'stop', usage: { inputTokens: 9, outputTokens: 40 } };
      return;
    }

    if (this.requestCount === 4) {
      yield { type: 'text_delta', delta: 'cancel-partial' };
      try {
        await delay(30_000, request.signal);
      } catch {
        return;
      }
      yield { type: 'text_delta', delta: 'late-event-must-not-render' };
      yield { type: 'stream_complete', finishReason: 'stop' };
      return;
    }

    if (this.requestCount === 5) {
      const resumed = request.messages.at(-1)?.content === 'after-cancel';
      yield { type: 'text_delta', delta: resumed ? 'resume-ok' : 'resume-missing' };
      yield { type: 'stream_complete', finishReason: 'stop' };
      return;
    }

    yield {
      type: 'stream_error',
      error: { code: 'FIXTURE_ERROR', message: 'deterministic fixture error', retryable: false },
    };
  }
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

const client = new TuiFixtureClient();
const conversation = new ConversationManager(client, new InMemoryConversationStore(), { maxTokens: 256 });

await runTui({
  conversation,
  profile,
  version: 'e2e',
  cwd: process.cwd(),
});
