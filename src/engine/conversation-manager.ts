import { randomUUID } from 'node:crypto';
import type {
  AgentEvent,
  ConversationController,
  ConversationStore,
  EnvironmentContext,
  LlmClient,
  Plan,
  SafeError,
  TaskAction,
  TurnEvent,
  UserTurn,
} from '../shared/types.js';
import { sanitizeTerminalText } from '../shared/sanitize-terminal-text.js';
import { classifyText, CredentialDataBlockedError, type ActionGateway, type ActionTask } from '../security/index.js';
import { AgentLoop, type AgentRunInput } from './agent-loop.js';
import { createModelActionGateway } from './model-action-gateway.js';
import { AgentTaskSession } from './task-session.js';

export class ConversationBusyError extends Error {
  constructor() { super('当前已有对话正在生成。'); this.name = 'ConversationBusyError'; }
}
export class ConversationInputError extends Error {
  constructor() { super('消息不能为空。'); this.name = 'ConversationInputError'; }
}
export class ConversationTaskError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'ConversationTaskError'; }
}

export interface ConversationManagerOptions {
  readonly maxTokens: number;
  readonly availableTools?: readonly import('../shared/types.js').ToolDefinition[];
  readonly createTurnId?: () => string;
  readonly createTaskId?: () => string;
  readonly createRunId?: () => string;
  readonly createQuestionId?: () => string;
  readonly createPlanId?: () => string;
  readonly now?: () => number;
  readonly environment?: EnvironmentContext;
  readonly modelOrigin?: string;
  readonly credentialRef?: string;
  readonly actionGateway?: ActionGateway;
  readonly createGatewayId?: () => string;
  readonly permissionMode?: import('../security/index.js').PermissionMode;
  readonly policySnapshotId?: string;
  readonly permissionRules?: readonly import('../security/index.js').PermissionRule[];
  readonly workspaceRoot?: string;
  readonly audit?: import('../security/index.js').SecurityAuditParticipant;
  readonly securityInternalRoots?: readonly string[];
}

interface ActiveRun {
  readonly turnId: string;
  readonly userText: string;
  readonly task: AgentTaskSession;
  readonly controller: AbortController;
  readonly startedAt: number;
  readonly kind: AgentRunInput['kind'];
  readonly appendUser: boolean;
  cancelled: boolean;
}

export class ConversationManager implements ConversationController {
  private active: ActiveRun | undefined;
  private task: AgentTaskSession | undefined;
  private actionTask: ActionTask | undefined;
  private readonly gateway: ActionGateway;
  private readonly createTurnId: () => string;
  private readonly createTaskId: () => string;
  private readonly createRunId: () => string;
  private readonly createQuestionId: () => string;
  private readonly createPlanId: () => string;
  private readonly now: () => number;

  constructor(private readonly client: LlmClient, private readonly store: ConversationStore, private readonly options: ConversationManagerOptions) {
    if (!Number.isInteger(options.maxTokens) || options.maxTokens <= 0) throw new TypeError('maxTokens must be a positive integer');
    this.gateway = options.actionGateway ?? createModelActionGateway(client, {
      ...(options.createGatewayId === undefined ? {} : { createId: options.createGatewayId }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.audit === undefined ? {} : { audit: options.audit }),
    });
    this.createTurnId = options.createTurnId ?? randomUUID;
    this.createTaskId = options.createTaskId ?? randomUUID;
    this.createRunId = options.createRunId ?? randomUUID;
    this.createQuestionId = options.createQuestionId ?? randomUUID;
    this.createPlanId = options.createPlanId ?? randomUUID;
    this.now = options.now ?? (() => performance.now());
  }

  get activeTurnId(): string | undefined { return this.active?.turnId; }

  submit(turn: UserTurn): AsyncIterable<TurnEvent> {
    if (this.active !== undefined) throw new ConversationBusyError();
    const text = sanitizeTerminalText(turn.content);
    if (text.trim().length === 0) throw new ConversationInputError();
    if (this.task !== undefined && !['completed', 'exited'].includes(this.task.state)) {
      if (turn.mode === 'plan') throw new ConversationTaskError('TASK_ACTIVE', '当前已有未结束任务，不能创建新的 Plan。');
      if (this.task.state === 'awaiting_input') {
        const pending = this.task.pendingQuestion;
        if (pending === undefined) throw new ConversationTaskError('QUESTION_MISSING', '待回答问题不存在。');
        return this.dispatch({ type: 'answer_question', taskId: this.task.taskId, questionId: pending.questionId, content: text });
      }
      if (this.task.mode === 'plan' && this.task.state === 'awaiting_approval') {
        return this.dispatch({ type: 'refine_plan', taskId: this.task.taskId, content: text });
      }
      throw new ConversationTaskError('TASK_ACTIVE', '当前已有未结束任务。');
    }
    const task = new AgentTaskSession(this.createTaskId(), turn.mode, turn.mode === 'plan' ? this.createPlanId() : undefined);
    this.task = task;
    return this.startRun(task, turn.mode === 'react' ? 'react' : 'plan_draft', text, undefined, true);
  }

  dispatch(action: TaskAction): AsyncIterable<TurnEvent> {
    if (action.type === 'resolve_authorization') {
      const task = this.task;
      if (task === undefined || task.taskId !== action.taskId || this.actionTask === undefined) {
        throw new ConversationTaskError('STALE_AUTHORIZATION_REQUEST', '授权请求已过期。');
      }
      try {
        this.actionTask.resolveAuthorization(action);
      } catch (error) {
        throw new ConversationTaskError(
          error instanceof Error && error.message.includes('AUTHORIZATION_DECISIONS_INCOMPLETE')
            ? 'AUTHORIZATION_DECISIONS_INCOMPLETE'
            : 'STALE_AUTHORIZATION_REQUEST',
          error instanceof Error ? error.message : '授权请求无效。',
        );
      }
      return emptyTurnEvents();
    }
    if (this.active !== undefined) throw new ConversationBusyError();
    const task = this.task;
    if (task === undefined || task.taskId !== action.taskId) throw new ConversationTaskError('STALE_TASK_ACTION', '任务操作已过期。');
    if (action.type === 'exit_task') return this.exitTask(task);
    if (action.type === 'approve_plan') {
      const plan = task.planSession?.approve(action.planId, action.version);
      if (plan === undefined) throw new ConversationTaskError('PLAN_MISSING', '当前任务没有可执行计划。');
      return this.startRun(task, 'plan_execute', plan.goal, plan);
    }
    if (action.type === 'refine_plan') {
      const plan = task.planSession?.current;
      if (plan === undefined) throw new ConversationTaskError('PLAN_MISSING', '当前任务没有可完善计划。');
      if (task.planSession!.state === 'awaiting_revision') task.planSession!.beginRevision();
      else task.planSession!.refine();
      return this.startRun(task, 'plan_draft', action.content?.trim() || `继续完善当前计划：${plan.goal}`, plan, action.content !== undefined);
    }
    if (action.type === 'answer_question') {
      task.answer(action.questionId);
      task.planSession?.answerInput();
      const plan = task.planSession?.current;
      const kind: AgentRunInput['kind'] = task.mode === 'react' ? 'react' : task.planSession?.state === 'draft' ? 'plan_draft' : 'plan_execute';
      return this.startRun(task, kind, action.content, plan, true);
    }
    if (action.type === 'continue_task') {
      task.continue();
      const plan = task.planSession?.current;
      if (task.mode === 'react') return this.startRun(task, 'react', action.content?.trim() || '继续当前任务。', undefined, action.content !== undefined);
      const content = action.content?.trim();
      if (content !== undefined && content.length > 0) task.planSession?.prepareRevision();
      const draft = plan === undefined || task.planSession?.state === 'draft';
      return this.startRun(task, draft ? 'plan_draft' : 'plan_execute', content || '继续当前任务。', plan, content !== undefined);
    }
    task.resume();
    task.planSession?.resume();
    const plan = task.planSession?.current;
    if (task.mode === 'plan' && plan !== undefined) return this.planReadyStream(task, plan, '计划已恢复，请重新确认。');
    return this.startRun(task, task.mode === 'plan' ? 'plan_draft' : 'react', '恢复并继续当前任务。');
  }

  cancel(): void {
    if (this.active === undefined) return;
    this.active.cancelled = true;
    this.active.controller.abort();
  }

  private startRun(task: AgentTaskSession, kind: AgentRunInput['kind'], text: string, plan?: Plan, appendUser = false): AsyncIterable<TurnEvent> {
    const active: ActiveRun = {
      turnId: this.createTurnId(), userText: text, task, controller: new AbortController(), startedAt: this.now(), kind, appendUser, cancelled: false,
    };
    this.active = active;
    task.beginRun();
    return this.run(active, plan);
  }

  private async *run(active: ActiveRun, plan?: Plan): AsyncGenerator<TurnEvent> {
    let outcome: import('../shared/types.js').RunOutcome | undefined;
    const publicHistoryAuthorized = classifyText(active.userText) === 'ordinary';
    try {
      const actionTask = await this.openActionTask(active.task, active.userText);
      if (active.appendUser && publicHistoryAuthorized) {
        this.store.appendMessages([{ role: 'user', content: active.userText }]);
      }
      yield {
        type: 'turn_start', turnId: active.turnId, userText: active.userText, startedAt: active.startedAt,
        taskMode: active.task.mode, taskPhase: active.kind,
      };
      const loop = new AgentLoop(actionTask);
      for await (const event of loop.run({
        taskId: active.task.taskId, runId: this.createRunId(), kind: active.kind, task: active.userText,
        signal: active.controller.signal, progress: active.task.progress, ...(plan === undefined ? {} : { plan }),
        createQuestionId: this.createQuestionId, createPlanId: () => active.task.planSession?.id ?? this.createPlanId(), now: this.now,
      })) {
        if (event.type === 'run_stopped') outcome = event.outcome;
        for (const mapped of this.mapEvent(active, event)) yield mapped;
      }
      if (outcome === undefined) throw new ConversationTaskError('RUN_OUTCOME_MISSING', 'AgentLoop 未返回终态。');
      active.task.applyOutcome(outcome);
      this.applyPlanOutcome(active.task, active.kind, outcome);
      if (publicHistoryAuthorized) this.commitPublicHistory(active, outcome);
      const durationMs = this.duration(active);
      if (outcome.reason === 'completed' && active.kind === 'plan_draft' && outcome.plan !== undefined) {
        active.task.markAwaitingApproval();
        yield { type: 'task_state', turnId: active.turnId, taskId: active.task.taskId, state: 'awaiting_approval', summary: outcome.summary, runCount: active.task.runCount, totalIterations: active.task.totalIterations };
        yield completeEvent(active.turnId, durationMs, outcome);
        return;
      }
      if (outcome.reason === 'completed') {
        await this.closeActionTask('completed');
        const finalText = formatCompletion(outcome);
        if (finalText !== '') yield { type: 'text_delta', turnId: active.turnId, delta: finalText };
        yield completeEvent(active.turnId, durationMs, outcome);
        return;
      }
      if (outcome.reason === 'security_integrity_failure') {
        await this.closeActionTask('security_integrity_failure');
        yield {
          type: 'task_state', turnId: active.turnId, taskId: active.task.taskId,
          state: 'security_integrity_failure', summary: outcome.summary,
          effectsMayHaveOccurred: outcome.effectsMayHaveOccurred,
        };
        yield {
          type: 'turn_error', turnId: active.turnId,
          error: outcome.error ?? { code: 'SECURITY_INTEGRITY_FAILURE', message: outcome.summary, retryable: false },
          promptAudits: outcome.promptAudits, durationMs,
        };
        return;
      }
      if (outcome.reason === 'cancelled') {
        yield { type: 'task_state', turnId: active.turnId, taskId: active.task.taskId, state: 'cancelled', summary: outcome.summary };
        yield { type: 'turn_cancelled', turnId: active.turnId, promptAudits: outcome.promptAudits, durationMs };
        return;
      }
      if (outcome.reason === 'awaiting_input') {
        yield { type: 'task_state', turnId: active.turnId, taskId: active.task.taskId, state: 'awaiting_input', summary: outcome.question?.prompt ?? outcome.summary, questionId: outcome.question?.questionId };
        yield completeEvent(active.turnId, durationMs, outcome);
        return;
      }
      if (outcome.reason === 'plan_revision') {
        yield { type: 'task_state', turnId: active.turnId, taskId: active.task.taskId, state: 'awaiting_approval', summary: outcome.summary };
        yield completeEvent(active.turnId, durationMs, outcome);
        return;
      }
      yield { type: 'task_state', turnId: active.turnId, taskId: active.task.taskId, state: 'stopped', summary: outcome.summary, runCount: active.task.runCount, totalIterations: active.task.totalIterations };
      yield { type: 'turn_error', turnId: active.turnId, error: outcome.error ?? stopError(outcome.reason, outcome.summary), restoreInput: active.userText,
        promptAudits: outcome.promptAudits, durationMs };
    } catch (error) {
      const durationMs = this.duration(active);
      if (active.cancelled) yield { type: 'turn_cancelled', turnId: active.turnId, durationMs };
      else yield {
        type: 'turn_error', turnId: active.turnId, error: safeError(error), durationMs,
        ...(error instanceof CredentialDataBlockedError ? {} : { restoreInput: active.userText }),
      };
    } finally {
      if (this.active === active) this.active = undefined;
    }
  }

  private mapEvent(active: ActiveRun, event: AgentEvent): readonly TurnEvent[] {
    if (event.type === 'iteration_started' || event.type === 'iteration_completed') {
      return [{ type: 'agent_iteration', turnId: active.turnId, taskId: event.taskId, runId: event.runId, iteration: event.iteration,
        phase: event.type === 'iteration_started' ? 'started' : 'completed', ...(event.stepId === undefined ? {} : { stepId: event.stepId }) }];
    }
    if (event.type === 'tool_call_queued' || event.type === 'tool_call_started') {
      return [{ type: event.type === 'tool_call_queued' ? 'tool_call_queued' : 'tool_call_start', turnId: active.turnId, taskId: event.taskId, runId: event.runId, iteration: event.iteration,
        ...(event.stepId === undefined ? {} : { stepId: event.stepId }), callId: event.callId, toolName: event.toolName, summary: event.type === 'tool_call_queued' ? `等待执行 ${event.toolName}` : `正在执行 ${event.toolName}` }];
    }
    if (event.type === 'tool_call_completed' || event.type === 'tool_call_skipped') {
      return [{ type: event.type === 'tool_call_skipped' ? 'tool_call_skipped' : 'tool_call_complete', turnId: active.turnId, taskId: event.taskId, runId: event.runId, iteration: event.iteration,
        ...(event.stepId === undefined ? {} : { stepId: event.stepId }), callId: event.callId, toolName: event.toolName, summary: sanitizeTerminalText(event.result.content.summary), isError: event.result.isError, ...(event.result.content.error === undefined ? {} : { error: event.result.content.error }) }];
    }
    if (event.type === 'authorization_requested') {
      return [
        { type: 'authorization_requested', turnId: active.turnId, ...event.request },
        {
          type: 'task_state', turnId: active.turnId, taskId: active.task.taskId,
          state: 'awaiting_authorization', summary: '等待用户逐项确认动作授权。',
        },
      ];
    }
    if (event.type === 'plan_submitted') return [{ type: 'plan_ready', turnId: active.turnId, taskId: active.task.taskId, runId: event.runId, plan: event.plan }];
    if (event.type === 'plan_revision_requested') return [{ type: 'plan_revision', turnId: active.turnId, taskId: active.task.taskId, reason: event.reason, suggestion: event.suggestion }];
    if (
      event.type === 'plan_step_started'
      || event.type === 'plan_step_completed'
      || event.type === 'plan_step_failed'
      || event.type === 'plan_step_skipped'
    ) {
      const status = event.type === 'plan_step_started' ? 'running' : event.type === 'plan_step_completed' ? 'completed' : event.type === 'plan_step_skipped' ? 'skipped' : 'failed';
      return [{ type: 'plan_step', turnId: active.turnId, taskId: active.task.taskId, runId: event.runId, planId: event.planId, version: event.version, stepId: event.stepId, status, ...(event.evidence === undefined ? {} : { evidence: event.evidence }), ...(event.reason === undefined ? {} : { reason: event.reason }) }];
    }
    return [];
  }

  private applyPlanOutcome(task: AgentTaskSession, kind: AgentRunInput['kind'], outcome: import('../shared/types.js').RunOutcome): void {
    const session = task.planSession;
    if (session === undefined) return;
    if (kind === 'plan_draft' && outcome.reason === 'completed' && outcome.plan !== undefined) session.adopt(outcome.plan);
    else if (kind === 'plan_draft' && outcome.reason === 'awaiting_input') session.awaitInput();
    else if (kind === 'plan_draft' && outcome.reason === 'cancelled') session.cancel();
    else if (kind === 'plan_execute' && outcome.plan !== undefined) {
      session.replaceCurrent(outcome.plan);
      if (outcome.reason === 'completed') session.complete();
      else if (outcome.reason === 'awaiting_input') session.awaitInput();
      else if (outcome.reason === 'plan_revision') session.requestRevision();
      else if (outcome.reason === 'cancelled') session.cancel();
    }
  }

  private commitPublicHistory(active: ActiveRun, outcome: import('../shared/types.js').RunOutcome): void {
    if (outcome.reason === 'completed' && active.kind === 'plan_draft' && outcome.plan !== undefined) {
      this.store.appendMessages([{ role: 'assistant', content: formatPlanSnapshot(outcome.plan) }]);
    } else if (outcome.reason === 'completed' && outcome.result !== undefined) {
      this.store.appendMessages([{ role: 'assistant', content: formatCompletion(outcome) }]);
    } else if (outcome.reason === 'awaiting_input' && outcome.question !== undefined) {
      this.store.appendMessages([{ role: 'assistant', content: `需要用户输入：${outcome.question.prompt}` }]);
    } else if (outcome.reason !== 'completed') {
      this.store.appendMessages([{ role: 'assistant', content: `任务状态：${outcome.summary}` }]);
    }
  }

  private async *exitTask(task: AgentTaskSession): AsyncGenerator<TurnEvent> {
    const turnId = this.createTurnId(); const startedAt = this.now(); task.exit();
    await this.closeActionTask('completed');
    const plan = task.planSession?.current;
    const completed = plan?.steps.filter((step) => step.status === 'completed').map((step) => step.description) ?? [];
    const remaining = plan?.steps.filter((step) => !['completed', 'skipped'].includes(step.status)).map((step) => step.description) ?? [];
    const progress = task.progress;
    const allCompleted = [...new Set([...progress.completedWork, ...completed])];
    const allRemaining = remaining.length > 0 ? remaining : progress.unfinishedWork;
    const summary = `已退出任务；累计 ${task.runCount} 次运行、${task.totalIterations} 次迭代。已完成：${allCompleted.join('、') || '无'}；未完成：${allRemaining.join('、') || '无'}；副作用：${progress.sideEffects.join('、') || '无'}。已产生的副作用不会回滚。`;
    this.store.appendMessages([{ role: 'assistant', content: summary }]);
    yield { type: 'turn_start', turnId, userText: '退出任务', startedAt, taskMode: task.mode, taskPhase: 'task_exit' };
    yield { type: 'task_state', turnId, taskId: task.taskId, state: 'exited', summary };
    yield { type: 'text_delta', turnId, delta: summary };
    yield { type: 'turn_complete', turnId, status: 'completed', finishReason: 'stop', durationMs: Math.max(0, this.now() - startedAt) };
  }

  private async *planReadyStream(task: AgentTaskSession, plan: Plan, summary: string): AsyncGenerator<TurnEvent> {
    const turnId = this.createTurnId(); const startedAt = this.now();
    yield { type: 'turn_start', turnId, userText: '恢复计划', startedAt, taskMode: 'plan', taskPhase: 'plan_draft' };
    yield { type: 'plan_ready', turnId, taskId: task.taskId, plan };
    yield { type: 'task_state', turnId, taskId: task.taskId, state: 'awaiting_approval', summary };
    yield { type: 'turn_complete', turnId, status: 'completed', finishReason: 'stop', durationMs: Math.max(0, this.now() - startedAt) };
  }

  private duration(active: ActiveRun): number { return Math.max(0, this.now() - active.startedAt); }

  private async openActionTask(task: AgentTaskSession, currentUserInput: string): Promise<ActionTask> {
    if (this.actionTask !== undefined) {
      if (this.actionTask.taskId !== task.taskId) throw new ConversationTaskError('ACTION_TASK_MISMATCH', '安全任务上下文与当前任务不匹配。');
      this.actionTask.appendUserInput(currentUserInput);
      return this.actionTask;
    }
    const origin = normalizeOrigin(this.options.modelOrigin ?? 'https://provider.invalid');
    const toolsEnabled = (this.options.availableTools ?? []).length > 0;
    this.actionTask = await this.gateway.openTask({
      schemaVersion: 1,
      taskId: task.taskId,
      policySnapshotId: this.options.policySnapshotId ?? 'compatibility-policy-v1',
      permissionMode: this.options.permissionMode ?? (toolsEnabled ? 'autonomous' : 'read_only'),
      ...(this.options.permissionRules === undefined ? {} : { permissionRules: this.options.permissionRules }),
      modelDestination: {
        profile: this.client.profile.name,
        protocol: this.client.profile.protocol,
        model: this.client.profile.model,
        origin,
        credentialRef: this.options.credentialRef ?? 'legacy-provider-credential',
      },
      pathBoundary: { readRoots: ['.'], writeRoots: toolsEnabled ? ['.'] : [] },
      ...(this.options.workspaceRoot === undefined ? {} : { workspaceRoot: this.options.workspaceRoot }),
      ...(this.options.securityInternalRoots === undefined ? {} : { securityInternalRoots: this.options.securityInternalRoots }),
      authorizationEpoch: 1,
      toolsEnabled,
      modelContext: {
        messages: this.store.getMessages(),
        currentUserInput,
        maxTokens: this.options.maxTokens,
        ...(this.options.environment === undefined ? {} : { environment: this.options.environment }),
      },
    });
    return this.actionTask;
  }

  private async closeActionTask(reason: 'completed' | 'cancelled' | 'failed' | 'security_integrity_failure'): Promise<void> {
    const task = this.actionTask;
    this.actionTask = undefined;
    if (task !== undefined) await task.close(reason);
  }
}

async function* emptyTurnEvents(): AsyncGenerator<TurnEvent> {}

function formatCompletion(outcome: import('../shared/types.js').RunOutcome): string {
  if (outcome.result === undefined) return '';
  return outcome.verificationSummary === undefined ? outcome.result : `${outcome.result}\n\n验证：${outcome.verificationSummary}`;
}
function stopError(reason: 'iteration_limit' | 'abnormal', message: string): SafeError { return { code: reason === 'iteration_limit' ? 'AGENT_LOOP_LIMIT_REACHED' : 'AGENT_LOOP_ABNORMAL', message, retryable: false }; }
function completeEvent(turnId: string, durationMs: number, outcome: import('../shared/types.js').RunOutcome): Extract<TurnEvent, { type: 'turn_complete' }> {
  return { type: 'turn_complete', turnId, status: 'completed', finishReason: 'stop', durationMs,
    ...(outcome.usage === undefined ? {} : { usage: outcome.usage }), modelTurnCount: outcome.iterationCount,
    promptAudits: outcome.promptAudits,
    toolCallCount: outcome.toolCallCount, toolErrorCount: outcome.toolErrorCount };
}
function safeError(error: unknown): SafeError { return {
  code: error instanceof ConversationTaskError ? error.code : error instanceof CredentialDataBlockedError ? 'CREDENTIAL_DATA_BLOCKED' : 'INTERNAL_ERROR',
  message: error instanceof Error ? error.message : '处理当前请求时发生内部错误。',
  retryable: false,
}; }

function formatPlanSnapshot(plan: Plan): string {
  return [`计划 v${plan.version}：${plan.goal}`, `成功标准：${plan.successCriteria.join('；')}`,
    ...plan.steps.map((step, index) => `${index + 1}. [${step.status}] ${step.description}（依赖：${step.dependencies.join(', ') || '无'}；标准：${step.successCriteria.join('；')}）`)].join('\n');
}

function normalizeOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    throw new TypeError('modelOrigin 必须是有效的绝对 URL。');
  }
}
