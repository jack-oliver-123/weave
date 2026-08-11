// Cross-layer contract types only. This module must not import layer or SDK code.

export type LlmProtocol =
  | 'anthropic-messages'
  | 'openai-chat-completions'
  | 'openai-responses';

export interface ProfileSummary {
  readonly name: string;
  readonly protocol: LlmProtocol;
  readonly model: string;
}

export interface ChatMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface UserTurn {
  readonly content: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface TokenUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export type FinishReason =
  | 'stop'
  | 'max_tokens'
  | 'refusal'
  | 'content_filter'
  | 'unknown';

export interface SafeError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface LlmRequest {
  readonly messages: readonly ChatMessage[];
  readonly maxTokens: number;
  readonly signal: AbortSignal;
}

export type LlmStreamEvent =
  | { readonly type: 'stream_start' }
  | { readonly type: 'text_delta'; readonly delta: string }
  | {
      readonly type: 'stream_complete';
      readonly finishReason: FinishReason;
      readonly usage?: TokenUsage;
    }
  | { readonly type: 'stream_error'; readonly error: SafeError };

export interface LlmClient {
  readonly profile: ProfileSummary;
  stream(request: LlmRequest): AsyncIterable<LlmStreamEvent>;
}

export interface ConversationStore {
  getMessages(): readonly ChatMessage[];
  commitTurn(user: ChatMessage, assistant: ChatMessage): void;
}

export type TurnCompletionStatus = 'completed' | 'truncated' | 'refused';

export type TurnEvent =
  | {
      readonly type: 'turn_start';
      readonly turnId: string;
      readonly userText: string;
      readonly startedAt: number;
    }
  | { readonly type: 'text_delta'; readonly turnId: string; readonly delta: string }
  | {
      readonly type: 'turn_complete';
      readonly turnId: string;
      readonly status: TurnCompletionStatus;
      readonly finishReason: FinishReason;
      readonly usage?: TokenUsage;
      readonly durationMs: number;
    }
  | {
      readonly type: 'turn_cancelled';
      readonly turnId: string;
      readonly durationMs: number;
    }
  | {
      readonly type: 'turn_error';
      readonly turnId: string;
      readonly error: SafeError;
      readonly restoreInput: string;
      readonly durationMs: number;
    };

export type AgentEvent = TurnEvent;

export interface ConversationController {
  readonly activeTurnId: string | undefined;
  submit(turn: UserTurn): AsyncIterable<TurnEvent>;
  cancel(): void;
}

// Reserved skeleton contracts for later tool, memory and security changes.
export interface ToolCallRequest {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

export interface ToolCallResult {
  readonly id: string;
  readonly content: string;
  readonly isError?: boolean;
}

export interface ContextSnapshot {
  readonly messages: readonly ChatMessage[];
  readonly systemPrompt: string;
}

export interface MemoryWriteRequest {
  readonly key: string;
  readonly value: unknown;
  readonly type: 'session' | 'persistent';
}

export interface PermissionRequest {
  readonly action: string;
  readonly resource: string;
  readonly context?: Readonly<Record<string, unknown>>;
}

export type Decision =
  | { readonly verdict: 'allow' }
  | { readonly verdict: 'deny'; readonly reason: string }
  | { readonly verdict: 'ask'; readonly reason: string };
