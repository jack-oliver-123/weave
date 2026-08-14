import React from 'react';
import { ConversationManager } from '../../src/engine/conversation-manager.js';
import { runTui } from '../../src/interaction/weave-tui.js';
import { InMemoryConversationStore } from '../../src/memory/conversation-store.js';
import type { ConversationController, LlmClient, LlmRequest, LlmStreamEvent, ProfileSummary, TurnEvent, UserTurn } from '../../src/shared/types.js';

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
      const queueIsMerged = request.prompt.messages.length === 3
        && request.prompt.messages[0]?.content === 'first-question'
        && request.prompt.messages[1]?.content === '### first-chunk\n\n**second-chunk**'
        && request.prompt.messages[2]?.content === 'queued-one\n\nqueued-two';
      yield { type: 'text_delta', delta: queueIsMerged ? '### queue-ok\n\n' : '### queue-missing\n\n' };
      yield { type: 'text_delta', delta: '| 名称 | 说明 |\n| --- | --- |\n| Weave | 终端助手 |\n\n```ts\nconst longName = "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz";\n```\n' };
      yield { type: 'stream_complete', finishReason: 'stop', usage: { inputTokens: 9, outputTokens: 24 } };
      return;
    }

    if (this.requestCount === 3) {
      const historyIsComplete = request.prompt.messages.length === 5
        && request.prompt.messages[4]?.content === 'line-one\nline-two';
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
      const resumed = request.prompt.messages.at(-1)?.content === 'after-cancel';
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

class ToolStatusFixtureController implements ConversationController {
  private fixtureTurnId: string | undefined;
  private fixtureAbort: AbortController | undefined;
  constructor(private readonly delegate: ConversationController) {}
  get activeTurnId(): string | undefined { return this.fixtureTurnId ?? this.delegate.activeTurnId; }
  submit(turn: UserTurn): AsyncIterable<TurnEvent> {
    if (!isFixtureInput(turn.content)) return this.delegate.submit(turn);
    if (this.activeTurnId !== undefined) throw new Error('fixture busy');
    this.fixtureTurnId = `fixture-${turn.content}`;
    this.fixtureAbort = new AbortController();
    return this.events(turn.content, this.fixtureAbort.signal);
  }
  dispatch(action: import('../../src/shared/types.js').TaskAction): AsyncIterable<TurnEvent> { return this.delegate.dispatch(action); }
  cancel(): void {
    if (this.fixtureTurnId !== undefined) this.fixtureAbort?.abort();
    else this.delegate.cancel();
  }
  private async *events(content: string, signal: AbortSignal): AsyncGenerator<TurnEvent> {
    const turnId = this.fixtureTurnId!;
    yield { type: 'turn_start', turnId, userText: content, startedAt: performance.now() };
    if (content === 'first-question') {
      yield { type: 'text_delta', turnId, delta: '### first-chunk' };
      await delay(8_000, signal);
      yield { type: 'text_delta', turnId, delta: '\n\n**second-chunk**' };
    } else if (content === 'queued-one\n\nqueued-two') {
      yield { type: 'text_delta', turnId, delta: '### queue-ok\n\n| 名称 | 说明 |\n| --- | --- |\n| Weave | 终端助手 |\n\n```ts\nconst longName = "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz";\n```\n' };
    } else if (content === 'line-one\nline-two') {
      yield { type: 'text_delta', turnId, delta: `history-ok\n${Array.from({ length: 32 }, (_, index) => `long-line-${String(index + 1).padStart(2, '0')}`).join('\n')}\nhistory-ok-tail` };
    } else if (content === 'cancel-me') {
      yield { type: 'text_delta', turnId, delta: 'cancel-partial' };
      try { await delay(30_000, signal); } catch {
        this.fixtureTurnId = undefined; this.fixtureAbort = undefined;
        yield { type: 'turn_cancelled', turnId, durationMs: 1 };
        return;
      }
      yield { type: 'text_delta', turnId, delta: 'late-event-must-not-render' };
    } else if (content === 'after-cancel') {
      yield { type: 'text_delta', turnId, delta: 'resume-ok' };
    } else {
      yield* this.toolEvents(turnId);
    }
    this.fixtureTurnId = undefined; this.fixtureAbort = undefined;
    yield { type: 'turn_complete', turnId, status: 'completed', finishReason: 'stop', durationMs: 200,
      ...(content === 'tool-status' ? { modelTurnCount: 2, toolCallCount: 2, toolErrorCount: 1 } : {}) };
  }
  private async *toolEvents(turnId: string): AsyncGenerator<TurnEvent> {
    yield { type: 'text_delta', turnId, delta: '检查工具状态。' };
    yield { type: 'tool_call_queued', turnId, callId: 'c1', toolName: 'read_file', summary: '等待读取 input.txt' };
    yield { type: 'tool_call_queued', turnId, callId: 'c2', toolName: 'edit_file', summary: '等待编辑 output.txt' };
    yield { type: 'tool_call_start', turnId, callId: 'c1', toolName: 'read_file', summary: '正在读取 input.txt' };
    await delay(150, new AbortController().signal);
    yield { type: 'tool_call_complete', turnId, callId: 'c1', toolName: 'read_file', summary: '读取 input.txt 完成', isError: false };
    yield { type: 'tool_call_skipped', turnId, callId: 'c2', toolName: 'edit_file', summary: '前序写入失败，未执行', isError: true,
      error: { code: 'PRIOR_WRITE_FAILED', message: '未执行', retryable: false } };
    yield { type: 'text_delta', turnId, delta: '工具状态完成。' };
  }
}

function isFixtureInput(content: string): boolean {
  return ['first-question', 'queued-one\n\nqueued-two', 'line-one\nline-two', 'tool-status', 'cancel-me', 'after-cancel'].includes(content);
}

const client = new TuiFixtureClient();
const conversation = new ConversationManager(client, new InMemoryConversationStore(), { maxTokens: 256 });
const controller = new ToolStatusFixtureController(conversation);

await runTui({
  conversation: controller,
  profile,
  version: 'e2e',
  cwd: process.cwd(),
});
