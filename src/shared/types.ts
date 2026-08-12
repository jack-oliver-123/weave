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

export type JsonSchema = Readonly<Record<string, unknown>>;
export type ToolExecutionMode = 'read_shared' | 'write_exclusive';

export interface ToolDefinition {
  readonly name: string;
  readonly purpose: string;
  readonly useWhen: readonly string[];
  readonly avoidWhen: readonly string[];
  readonly inputSchema: JsonSchema;
  readonly resultSchema: JsonSchema;
  readonly worksWith: readonly { readonly toolName: string; readonly usage: string }[];
  readonly executionMode: ToolExecutionMode;
}

export interface ToolCallRequest {
  readonly callId: string;
  readonly providerCallId: string;
  readonly name: string;
  readonly input: unknown;
}

export interface ToolErrorContent {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface ToolCallResult {
  readonly callId: string;
  readonly providerCallId: string;
  readonly toolName: string;
  readonly isError: boolean;
  readonly content: {
    readonly summary: string;
    readonly data?: unknown;
    readonly error?: ToolErrorContent;
  };
}

export type MessageContent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool_call'; readonly call: ToolCallRequest }
  | { readonly type: 'tool_result'; readonly result: ToolCallResult };

export interface ChatMessage {
  readonly role: 'user' | 'assistant' | 'tool';
  readonly content: string | readonly MessageContent[];
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
  readonly tools?: readonly ToolDefinition[];
  readonly systemPrompt?: string;
}

export type LlmStreamEvent =
  | { readonly type: 'stream_start' }
  | { readonly type: 'text_delta'; readonly delta: string }
  | { readonly type: 'tool_calls'; readonly calls: readonly ToolCallRequest[] }
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
  appendMessages(messages: readonly ChatMessage[]): void;
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
      readonly modelTurnCount?: number;
      readonly toolCallCount?: number;
      readonly toolErrorCount?: number;
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
    }
  | {
      readonly type: 'tool_call_queued' | 'tool_call_start';
      readonly turnId: string;
      readonly callId: string;
      readonly toolName: string;
      readonly summary: string;
    }
  | {
      readonly type: 'tool_call_complete' | 'tool_call_skipped';
      readonly turnId: string;
      readonly callId: string;
      readonly toolName: string;
      readonly summary: string;
      readonly isError: boolean;
      readonly error?: ToolErrorContent;
    };

export type AgentEvent = TurnEvent;

export interface ConversationController {
  readonly activeTurnId: string | undefined;
  submit(turn: UserTurn): AsyncIterable<TurnEvent>;
  cancel(): void;
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
