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
  readonly mode: AgentTaskMode;
  readonly content: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type StaticPromptModuleId =
  | 'identity'
  | 'system_constraints'
  | 'task_modes'
  | 'action_execution'
  | 'tool_usage'
  | 'tone_style'
  | 'text_output';

export interface StaticPromptModule {
  readonly id: StaticPromptModuleId;
  readonly version: string;
  readonly priority: number;
  readonly content: string;
}

export interface StableSystemPrompt {
  readonly promptVersion: string;
  readonly modules: readonly StaticPromptModule[];
  readonly text: string;
  readonly hash: string;
}

export type PromptMode = 'react' | 'plan_draft' | 'plan_execute' | 'plan_finalize';

export interface RuntimeStateContext {
  readonly type: 'agent_state';
  readonly mode: PromptMode;
  readonly iterationLimit: number;
  readonly plan?: Plan;
  readonly step?: PlanStep;
  readonly protocolCorrection?: string;
}

export interface CapabilityChangeContext {
  readonly type: 'capability_change';
  readonly serverId: string;
  readonly status: 'available' | 'unavailable';
  readonly affectedTools: readonly string[];
  readonly impact: string;
}

export type RuntimeReminderContent = RuntimeStateContext | CapabilityChangeContext;

export interface EnvironmentContext {
  readonly cwd: string;
  readonly workspaceRoots: readonly string[];
  readonly os: string;
  readonly shell: string;
  readonly currentDate: string;
  readonly timezone: string;
}

export type PromptTrust = 'trusted_runtime' | 'trusted_configuration' | 'untrusted_context';
export type SystemReminderKind =
  | 'runtime_state'
  | 'environment'
  | 'activated_skill'
  | 'project_instructions'
  | 'memory';

export type SystemReminderFragment =
  | {
      readonly kind: 'runtime_state';
      readonly source: 'weave-runtime';
      readonly trust: 'trusted_runtime';
      readonly content: RuntimeReminderContent;
    }
  | {
      readonly kind: 'environment';
      readonly source: 'weave-environment';
      readonly trust: 'trusted_runtime';
      readonly content: EnvironmentContext;
    }
  | {
      readonly kind: 'activated_skill' | 'project_instructions' | 'memory';
      readonly source: string;
      readonly trust: 'trusted_configuration' | 'untrusted_context';
      readonly content: string;
    };

export interface SystemReminder {
  readonly fragments: readonly SystemReminderFragment[];
  readonly text: string;
}

export interface PromptAudit {
  readonly promptVersion: string;
  readonly stableHash: string;
  readonly assemblyHash: string;
  readonly modules: readonly { readonly id: StaticPromptModuleId; readonly version: string; readonly characters: number }[];
  readonly fragments: readonly {
    readonly kind: SystemReminderKind;
    readonly source: string;
    readonly trust: PromptTrust;
    readonly characters: number;
  }[];
}

export interface PromptCompletionAudit extends PromptAudit {
  readonly protocol: LlmProtocol;
  readonly model: string;
  readonly usage?: TokenUsage;
}

export interface PromptAssembly {
  readonly system: {
    readonly stable: StableSystemPrompt;
    readonly reminder?: SystemReminder;
  };
  readonly tools: readonly ToolDefinition[];
  readonly messages: readonly ChatMessage[];
  readonly audit: PromptAudit;
}

export type AgentTaskMode = 'react' | 'plan';

export type PlanStepStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped' | 'invalidated';

export interface PlanStep {
  readonly id: string;
  readonly description: string;
  readonly dependencies: readonly string[];
  readonly successCriteria: readonly string[];
  readonly status: PlanStepStatus;
  readonly evidence: readonly string[];
  readonly statusReason?: string;
}

export interface Plan {
  readonly planId: string;
  readonly version: number;
  readonly supersedesVersion?: number;
  readonly goal: string;
  readonly successCriteria: readonly string[];
  readonly steps: readonly PlanStep[];
}

export type AuthorizationChoice = 'allow_once' | 'allow_for_task' | 'deny' | 'cancel';

export interface AuthorizationRequestItem {
  readonly callId: string;
  readonly actionDigest: string;
  readonly toolName: string;
  readonly summary: string;
  readonly capabilityTypes: readonly string[];
  readonly risks: readonly string[];
  readonly destination?: string;
}

export interface AuthorizationRequestView {
  readonly taskId: string;
  readonly runId: string;
  readonly authorizationRequestId: string;
  readonly authorizationEpoch: number;
  readonly items: readonly AuthorizationRequestItem[];
}

export interface AuthorizationDecisionItem {
  readonly actionDigest: string;
  readonly choice: AuthorizationChoice;
}

export type TaskAction =
  | { readonly type: 'approve_plan'; readonly taskId: string; readonly planId: string; readonly version: number }
  | { readonly type: 'refine_plan'; readonly taskId: string; readonly content?: string }
  | { readonly type: 'exit_task'; readonly taskId: string }
  | { readonly type: 'answer_question'; readonly taskId: string; readonly questionId: string; readonly content: string }
  | { readonly type: 'continue_task'; readonly taskId: string; readonly content?: string }
  | { readonly type: 'resume_task'; readonly taskId: string }
  | {
      readonly type: 'resolve_authorization';
      readonly taskId: string;
      readonly runId: string;
      readonly authorizationRequestId: string;
      readonly authorizationEpoch: number;
      readonly decisions: readonly AuthorizationDecisionItem[];
    };

export interface TokenUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
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
  readonly prompt: PromptAssembly;
  readonly maxTokens: number;
  readonly signal: AbortSignal;
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

export interface ModelExchangeInput {
  readonly destination: {
    readonly profile: string;
    readonly protocol: LlmProtocol;
    readonly model: string;
    readonly origin: string;
  };
  readonly runtime: RuntimeStateContext;
  readonly environment?: EnvironmentContext;
  readonly tools: readonly ToolDefinition[];
  readonly messages: readonly ChatMessage[];
  readonly maxTokens: number;
}

export interface ModelExchangeResponse {
  readonly text: string;
  readonly calls: readonly ToolCallRequest[];
  readonly completion: Extract<LlmStreamEvent, { type: 'stream_complete' }>;
  readonly audit: PromptCompletionAudit;
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
      readonly taskMode?: AgentTaskMode;
      readonly taskPhase?: 'react' | 'plan_draft' | 'plan_execute' | 'task_exit';
    }
  | { readonly type: 'text_delta'; readonly turnId: string; readonly delta: string }
  | {
      readonly type: 'agent_iteration';
      readonly turnId: string;
      readonly taskId: string;
      readonly runId: string;
      readonly iteration: number;
      readonly phase: 'started' | 'completed';
      readonly stepId?: string;
    }
  | {
      readonly type: 'turn_complete';
      readonly turnId: string;
      readonly status: TurnCompletionStatus;
      readonly finishReason: FinishReason;
      readonly usage?: TokenUsage;
      readonly promptAudits?: readonly PromptCompletionAudit[];
      readonly durationMs: number;
      readonly modelTurnCount?: number;
      readonly toolCallCount?: number;
      readonly toolErrorCount?: number;
    }
  | {
      readonly type: 'turn_cancelled';
      readonly turnId: string;
      readonly promptAudits?: readonly PromptCompletionAudit[];
      readonly durationMs: number;
    }
  | {
      readonly type: 'turn_error';
      readonly turnId: string;
      readonly error: SafeError;
      readonly restoreInput?: string;
      readonly promptAudits?: readonly PromptCompletionAudit[];
      readonly durationMs: number;
    }
  | {
      readonly type: 'tool_call_queued' | 'tool_call_start';
      readonly turnId: string;
      readonly taskId?: string;
      readonly runId?: string;
      readonly iteration?: number;
      readonly stepId?: string;
      readonly callId: string;
      readonly toolName: string;
      readonly summary: string;
    }
  | {
      readonly type: 'tool_call_complete' | 'tool_call_skipped';
      readonly turnId: string;
      readonly taskId?: string;
      readonly runId?: string;
      readonly iteration?: number;
      readonly stepId?: string;
      readonly callId: string;
      readonly toolName: string;
      readonly summary: string;
      readonly isError: boolean;
      readonly error?: ToolErrorContent;
    }
  | {
      readonly type: 'plan_ready';
      readonly turnId: string;
      readonly taskId: string;
      readonly runId?: string;
      readonly plan: Plan;
    }
  | {
      readonly type: 'plan_step';
      readonly turnId: string;
      readonly taskId: string;
      readonly runId?: string;
      readonly planId: string;
      readonly version: number;
      readonly stepId: string;
      readonly status: 'running' | 'completed' | 'failed' | 'skipped';
      readonly evidence?: readonly string[];
      readonly reason?: string;
    }
  | {
      readonly type: 'task_state';
      readonly turnId: string;
      readonly taskId: string;
      readonly state: 'awaiting_input' | 'awaiting_approval' | 'awaiting_authorization' | 'stopped' | 'cancelled' | 'security_integrity_failure' | 'exited';
      readonly summary: string;
      readonly effectsMayHaveOccurred?: boolean;
      readonly questionId?: string;
      readonly runCount?: number;
      readonly totalIterations?: number;
    }
  | ({ readonly type: 'authorization_requested'; readonly turnId: string } & AuthorizationRequestView)
  | {
      readonly type: 'plan_revision';
      readonly turnId: string;
      readonly taskId: string;
      readonly reason: string;
      readonly suggestion: string;
    };

export type AgentStopReason =
  | 'completed'
  | 'iteration_limit'
  | 'cancelled'
  | 'abnormal'
  | 'awaiting_input'
  | 'plan_revision'
  | 'security_integrity_failure';

export interface RunProgressSummary {
  readonly completedWork: readonly string[];
  readonly unfinishedWork: readonly string[];
  readonly sideEffects: readonly string[];
  readonly lastError?: string;
}

export interface RunOutcome {
  readonly reason: AgentStopReason;
  readonly error?: SafeError;
  readonly result?: string;
  readonly verificationSummary?: string;
  readonly summary: string;
  readonly effectsMayHaveOccurred?: boolean;
  readonly progress: RunProgressSummary;
  readonly plan?: Plan;
  readonly question?: { readonly questionId: string; readonly prompt: string };
  readonly revision?: { readonly reason: string; readonly suggestion: string };
  readonly usage?: TokenUsage;
  readonly promptAudits: readonly PromptCompletionAudit[];
  readonly iterationCount: number;
  readonly toolCallCount: number;
  readonly toolErrorCount: number;
}

interface AgentEventBase {
  readonly taskId: string;
  readonly runId: string;
}

export type AgentEvent =
  | (AgentEventBase & { readonly type: 'run_started'; readonly mode: AgentTaskMode; readonly startedAt: number })
  | (AgentEventBase & { readonly type: 'iteration_started' | 'iteration_completed'; readonly iteration: number; readonly stepId?: string })
  | (AgentEventBase & {
      readonly type: 'tool_call_queued' | 'tool_call_started';
      readonly iteration: number;
      readonly callId: string;
      readonly toolName: string;
      readonly call?: ToolCallRequest;
      readonly stepId?: string;
    })
  | (AgentEventBase & {
      readonly type: 'tool_call_completed' | 'tool_call_skipped';
      readonly iteration: number;
      readonly callId: string;
      readonly toolName: string;
      readonly result: ToolCallResult;
      readonly stepId?: string;
    })
  | (AgentEventBase & { readonly type: 'plan_submitted'; readonly plan: Plan })
  | (AgentEventBase & {
      readonly type: 'plan_step_started' | 'plan_step_completed' | 'plan_step_failed' | 'plan_step_skipped';
      readonly planId: string;
      readonly version: number;
      readonly stepId: string;
      readonly evidence?: readonly string[];
      readonly reason?: string;
    })
  | (AgentEventBase & { readonly type: 'user_input_requested'; readonly questionId: string; readonly prompt: string })
  | (AgentEventBase & { readonly type: 'plan_revision_requested'; readonly reason: string; readonly suggestion: string })
  | (AgentEventBase & { readonly type: 'authorization_requested'; readonly request: AuthorizationRequestView })
  | (AgentEventBase & { readonly type: 'run_stopped'; readonly outcome: RunOutcome });

export type ToolDefinitionScope = 'all' | 'read_only' | 'none';

export interface ToolExecutionBatch {
  readonly results: readonly ToolCallResult[];
  readonly totalCalls: number;
  readonly businessToolLimitReached: boolean;
}

export interface ToolExecutionHooks {
  readonly onStart?: (call: ToolCallRequest) => void;
}

export interface ToolExecutor {
  definitions(scope: ToolDefinitionScope): readonly ToolDefinition[];
  execute(
    calls: readonly ToolCallRequest[],
    signal: AbortSignal,
    previousCalls?: number,
    hooks?: ToolExecutionHooks,
  ): Promise<ToolExecutionBatch>;
}

export interface ConversationController {
  readonly activeTurnId: string | undefined;
  submit(turn: UserTurn): AsyncIterable<TurnEvent>;
  dispatch(action: TaskAction): AsyncIterable<TurnEvent>;
  cancel(): void;
}

export interface ContextSnapshot {
  readonly messages: readonly ChatMessage[];
  readonly system: StableSystemPrompt;
}

export interface MemoryWriteRequest {
  readonly key: string;
  readonly value: unknown;
  readonly type: 'session' | 'persistent';
}
