import { randomUUID } from 'node:crypto';
import type {
  ChatMessage,
  ConversationController,
  ConversationStore,
  LlmClient,
  SafeError,
  TurnCompletionStatus,
  TurnEvent,
  UserTurn,
} from '../shared/types.js';
import { sanitizeTerminalText } from '../shared/sanitize-terminal-text.js';

export class ConversationBusyError extends Error {
  constructor() {
    super('当前已有对话正在生成。');
    this.name = 'ConversationBusyError';
  }
}

export class ConversationInputError extends Error {
  constructor() {
    super('消息不能为空。');
    this.name = 'ConversationInputError';
  }
}

export interface ConversationManagerOptions {
  readonly maxTokens: number;
  readonly createTurnId?: () => string;
  readonly now?: () => number;
}

interface ActiveTurn {
  readonly id: string;
  readonly controller: AbortController;
  readonly startedAt: number;
  cancelled: boolean;
  terminal: boolean;
}

export class ConversationManager implements ConversationController {
  private active: ActiveTurn | undefined;
  private readonly createTurnId: () => string;
  private readonly now: () => number;

  constructor(
    private readonly client: LlmClient,
    private readonly store: ConversationStore,
    private readonly options: ConversationManagerOptions,
  ) {
    if (!Number.isInteger(options.maxTokens) || options.maxTokens <= 0) {
      throw new TypeError('maxTokens must be a positive integer');
    }
    this.createTurnId = options.createTurnId ?? randomUUID;
    this.now = options.now ?? (() => performance.now());
  }

  get activeTurnId(): string | undefined {
    return this.active?.id;
  }

  submit(turn: UserTurn): AsyncIterable<TurnEvent> {
    if (this.active !== undefined) throw new ConversationBusyError();
    const userText = sanitizeTerminalText(turn.content);
    if (userText.trim().length === 0) throw new ConversationInputError();

    const active: ActiveTurn = {
      id: this.createTurnId(),
      controller: new AbortController(),
      startedAt: this.now(),
      cancelled: false,
      terminal: false,
    };
    this.active = active;
    return this.run(active, userText);
  }

  cancel(): void {
    if (this.active === undefined || this.active.terminal) return;
    this.active.cancelled = true;
    this.active.controller.abort();
  }

  private async *run(active: ActiveTurn, userText: string): AsyncGenerator<TurnEvent> {
    const userMessage: ChatMessage = { role: 'user', content: userText };
    let assistantText = '';
    try {
      yield { type: 'turn_start', turnId: active.id, userText, startedAt: active.startedAt };
      const messages = [...this.store.getMessages(), userMessage];
      const stream = this.client.stream({
        messages,
        maxTokens: this.options.maxTokens,
        signal: active.controller.signal,
      });

      for await (const event of stream) {
        if (!this.isCurrent(active) || active.cancelled || active.terminal) break;
        if (event.type === 'stream_start') continue;
        if (event.type === 'text_delta') {
          const safeDelta = sanitizeTerminalText(event.delta);
          assistantText += safeDelta;
          if (safeDelta.length > 0) {
            yield { type: 'text_delta', turnId: active.id, delta: safeDelta };
          }
          continue;
        }
        if (event.type === 'stream_error') {
          this.finish(active);
          yield this.errorEvent(active, userText, event.error);
          return;
        }
        if (event.type === 'stream_complete') {
          if (assistantText.length === 0) {
            this.finish(active);
            yield this.errorEvent(active, userText, emptyResponseError(event.finishReason));
            return;
          }
          const status = completionStatus(event.finishReason);
          this.store.commitTurn(userMessage, { role: 'assistant', content: assistantText });
          this.finish(active);
          yield {
            type: 'turn_complete',
            turnId: active.id,
            status,
            finishReason: event.finishReason,
            ...(event.usage === undefined ? {} : { usage: event.usage }),
            durationMs: this.duration(active),
          };
          return;
        }
      }

      if (active.cancelled) {
        this.finish(active);
        yield { type: 'turn_cancelled', turnId: active.id, durationMs: this.duration(active) };
        return;
      }
      if (this.isCurrent(active) && !active.terminal) {
        this.finish(active);
        yield this.errorEvent(active, userText, {
          code: 'PROTOCOL_ERROR',
          message: '模型响应未正常结束。',
          retryable: false,
        });
      }
    } catch {
      if (active.cancelled) {
        this.finish(active);
        yield { type: 'turn_cancelled', turnId: active.id, durationMs: this.duration(active) };
      } else if (!active.terminal) {
        this.finish(active);
        yield this.errorEvent(active, userText, {
          code: 'NETWORK_ERROR',
          message: '无法连接模型服务。',
          retryable: true,
        });
      }
    } finally {
      if (this.isCurrent(active)) this.finish(active);
    }
  }

  private errorEvent(active: ActiveTurn, restoreInput: string, error: SafeError): TurnEvent {
    return {
      type: 'turn_error',
      turnId: active.id,
      error,
      restoreInput,
      durationMs: this.duration(active),
    };
  }

  private isCurrent(active: ActiveTurn): boolean {
    return this.active === active;
  }

  private finish(active: ActiveTurn): void {
    active.terminal = true;
    if (this.active === active) this.active = undefined;
  }

  private duration(active: ActiveTurn): number {
    return Math.max(0, this.now() - active.startedAt);
  }
}

function completionStatus(reason: string): TurnCompletionStatus {
  if (reason === 'max_tokens') return 'truncated';
  if (reason === 'refusal' || reason === 'content_filter') return 'refused';
  return 'completed';
}

function emptyResponseError(reason: string): SafeError {
  const refused = reason === 'refusal' || reason === 'content_filter';
  return {
    code: refused ? 'EMPTY_REFUSAL' : 'EMPTY_RESPONSE',
    message: refused ? '模型拒绝了请求，但未返回说明。' : '模型未返回文本内容。',
    retryable: !refused,
  };
}
