import { randomUUID } from 'node:crypto';
import type {
  AgentEvent, AgentTaskMode, Plan, PromptMode, RunOutcome,
  PromptCompletionAudit, RunProgressSummary, SafeError, TokenUsage, ToolCallRequest, ToolCallResult,
} from '../shared/types.js';
import type { ActionModelExchangeResponse, ActionTask, SafeProposalAction } from '../security/index.js';
import { PermissionCancelledError, SecurityIntegrityFailureError } from '../security/index.js';
import { ControlToolCatalog, planFromSubmission, type AgentPhase, type SubmittedPlanInput } from './control-tools.js';
import { blockedDependency, nextExecutableStep, reconcilePlan, updateStep, validateCriteria, validatePlanCompletion, validatePlanSubmission, PlanValidationError } from './plan.js';
import { buildRuntimeState } from './prompt-builder.js';
import { CONTROL_DECISION_CHECKPOINT } from './prompt-rules.js';

const REACT_LIMIT = 10;
const DRAFT_LIMIT = 10;
const STEP_LIMIT = 10;
const PLAN_LIMIT = 50;

export type AgentRunKind = 'react' | 'plan_draft' | 'plan_execute';

export interface AgentRunInput {
  readonly taskId: string;
  readonly runId?: string;
  readonly kind: AgentRunKind;
  readonly task: string;
  readonly signal: AbortSignal;
  readonly plan?: Plan;
  readonly progress?: RunProgressSummary;
  readonly createRunId?: () => string;
  readonly createQuestionId?: () => string;
  readonly createPlanId?: () => string;
  readonly now?: () => number;
}

interface Stats {
  iterations: number;
  toolCalls: number;
  toolErrors: number;
  usage?: TokenUsage;
  promptAudits: PromptCompletionAudit[];
  completedWork: string[];
  unfinishedWork: string[];
  sideEffects: string[];
  lastError?: string;
}

export class AgentLoop {
  private readonly controls = new ControlToolCatalog();

  constructor(private readonly actionTask: ActionTask) {}

  async *run(input: AgentRunInput): AsyncGenerator<AgentEvent> {
    const runId = input.runId ?? input.createRunId?.() ?? randomUUID();
    const questionId = input.createQuestionId ?? randomUUID;
    const planId = input.createPlanId ?? randomUUID;
    const stats: Stats = {
      iterations: 0, toolCalls: 0, toolErrors: 0,
      promptAudits: [],
      completedWork: [...(input.progress?.completedWork ?? [])],
      unfinishedWork: [...(input.progress?.unfinishedWork ?? [input.task])],
      sideEffects: [...(input.progress?.sideEffects ?? [])],
      ...(input.progress?.lastError === undefined ? {} : { lastError: input.progress.lastError }),
    };
    let plan = input.plan;
    let lastFingerprint: string | undefined;
    let repeats = 0;
    let protocolCorrection: string | undefined;
    const stepIterations = new Map<string, number>();
    const mode: AgentTaskMode = input.kind === 'react' ? 'react' : 'plan';
    const outcome = (reason: RunOutcome['reason'], summary: string, taskCompleted = reason === 'completed' && input.kind !== 'plan_draft'): RunOutcome =>
      result(reason, stats, summary, plan, input.task, taskCompleted);
    const failActiveStep = (reason: string): AgentEvent | undefined => {
      if (plan === undefined) return undefined;
      const current = plan.steps.find((item) => item.status === 'in_progress');
      if (current === undefined) return undefined;
      plan = updateStep(plan, current.id, { status: 'failed', statusReason: reason });
      return { type: 'plan_step_failed', taskId: input.taskId, runId, planId: plan.planId, version: plan.version, stepId: current.id, reason };
    };
    yield { type: 'run_started', taskId: input.taskId, runId, mode, startedAt: input.now?.() ?? performance.now() };

    try {
      while (true) {
        if (input.signal.aborted) {
          yield stop(input.taskId, runId, outcome('cancelled', '用户取消了当前运行。')); return;
        }
        const activeStep = plan?.steps.find((step) => step.status === 'in_progress');
        const pendingStep = input.kind === 'plan_execute' && activeStep === undefined ? nextExecutableStep(plan!) : undefined;
        if (pendingStep !== undefined) {
          if (blockedDependency(plan!, pendingStep) !== undefined) {
            stats.lastError = `步骤 ${pendingStep.id} 的依赖未完成。`;
            yield stop(input.taskId, runId, outcome('abnormal', stats.lastError)); return;
          }
          plan = updateStep(plan!, pendingStep.id, { status: 'in_progress' });
          yield { type: 'plan_step_started', taskId: input.taskId, runId, planId: plan.planId, version: plan.version, stepId: pendingStep.id };
        }
        const step = plan?.steps.find((item) => item.status === 'in_progress');
        const limit = limitMessage(input.kind, stats.iterations, step?.id, step === undefined ? 0 : (stepIterations.get(step.id) ?? 0));
        if (limit !== undefined) {
          if (plan !== undefined && step !== undefined) {
            plan = updateStep(plan, step.id, { status: 'failed', statusReason: limit });
            yield { type: 'plan_step_failed', taskId: input.taskId, runId, planId: plan.planId, version: plan.version, stepId: step.id, reason: limit };
          }
          yield stop(input.taskId, runId, outcome('iteration_limit', limit)); return;
        }

        stats.iterations += 1;
        if (step !== undefined) stepIterations.set(step.id, (stepIterations.get(step.id) ?? 0) + 1);
        const iteration = stats.iterations;
        yield { type: 'iteration_started', taskId: input.taskId, runId, iteration, ...(step === undefined ? {} : { stepId: step.id }) };
        const phase = phaseFor(input.kind, plan);
        const scope = input.kind === 'plan_draft' ? 'read_only' : stats.toolCalls >= 100 || phase === 'plan_finalize' ? 'none' : 'all';
        const promptMode: PromptMode = input.kind === 'react' ? 'react' : input.kind === 'plan_draft' ? 'plan_draft' : phase === 'plan_finalize' ? 'plan_finalize' : 'plan_execute';
        const businessDefinitions = this.actionTask.definitions(scope);
        const definitions = [...businessDefinitions, ...this.controls.definitions(phase)];
        const response = await this.collect(runId, iteration, buildRuntimeState({
          mode: promptMode,
          iterationLimit: input.kind === 'plan_execute' ? STEP_LIMIT : REACT_LIMIT,
          ...(plan === undefined ? {} : { plan }),
          ...(step === undefined ? {} : { step }),
          ...(protocolCorrection === undefined ? {} : { protocolCorrection }),
        }), definitions, input.signal);
        stats.usage = addUsage(stats.usage, response.completion.usage);
        stats.promptAudits.push(response.audit);

        if (response.proposalBatch === undefined) {
          const code = 'CONTROL_TOOL_REQUIRED';
          stats.lastError = '模型未使用控制工具推进任务。';
          protocolCorrection = '普通文本不能结束任务，请调用当前阶段允许的控制工具。';
          ({ lastFingerprint, repeats } = repeat(lastFingerprint, repeats, fingerprint(['control', code])));
          yield iterationDone(input.taskId, runId, iteration, step?.id);
          if (repeats >= 3) {
            const reason = '模型连续三次未使用控制工具推进任务。'; stats.lastError = reason;
            const failed = failActiveStep(reason); if (failed !== undefined) yield failed;
            yield stop(input.taskId, runId, outcome('abnormal', reason)); return;
          }
          continue;
        }
        protocolCorrection = undefined;

        const proposal = response.proposalBatch;
        const actionRequest = this.actionTask.prepareActionBatch(runId, proposal.proposalBatchRef);
        const businessActions = proposal.actions.filter((action) => action.kind === 'business');
        const controlActions = proposal.actions.filter((action) => action.kind === 'control');
        if (businessActions.length > 0) {
          for (const action of businessActions) yield { type: 'tool_call_queued', taskId: input.taskId, runId, iteration, callId: action.callId, toolName: action.toolName, ...(step === undefined ? {} : { stepId: step.id }) };
          const started: Pick<SafeProposalAction, 'callId' | 'toolName'>[] = [];
          const authorizationRequests: import('../shared/types.js').AuthorizationRequestView[] = [];
          let wake: (() => void) | undefined;
          let executionComplete = false;
          const outcomePromise = this.actionTask.performActionBatch(actionRequest, input.signal, stats.toolCalls, { onStart: (action) => {
            started.push(action);
            wake?.();
            wake = undefined;
          }, onAuthorizationRequested: (request) => {
            authorizationRequests.push(request);
            wake?.();
            wake = undefined;
          } }).finally(() => {
            executionComplete = true;
            wake?.();
            wake = undefined;
          });
          while (!executionComplete || started.length > 0 || authorizationRequests.length > 0) {
            while (authorizationRequests.length > 0) {
              const request = authorizationRequests.shift()!;
              yield { type: 'authorization_requested', taskId: input.taskId, runId, request };
            }
            while (started.length > 0) {
              const action = started.shift()!;
              yield { type: 'tool_call_started', taskId: input.taskId, runId, iteration, callId: action.callId, toolName: action.toolName, ...(step === undefined ? {} : { stepId: step.id }) };
            }
            if (!executionComplete) await new Promise<void>((resolve) => { wake = resolve; });
          }
          const actionOutcome = await outcomePromise;
          if (actionOutcome.kind === 'invalid') {
            stats.toolErrors += actionOutcome.results.length;
            stats.lastError = actionOutcome.results.at(-1)?.content.summary;
            ({ lastFingerprint, repeats } = repeat(lastFingerprint, repeats, fingerprint(['invalid', actionOutcome.results.map(stableResult)])));
            yield iterationDone(input.taskId, runId, iteration, step?.id);
            if (repeats >= 3) {
              const reason = '模型连续三次提交无效工具批次。';
              yield stop(input.taskId, runId, outcome('abnormal', reason)); return;
            }
            continue;
          }
          if (actionOutcome.kind !== 'business') throw new Error('ACTION_BATCH_KIND_MISMATCH');
          const batch = actionOutcome.batch;
          stats.toolCalls = batch.totalCalls; stats.toolErrors += batch.results.filter((item) => item.isError).length;
          const executionModes = new Map(businessDefinitions.map((definition) => [definition.name, definition.executionMode]));
          for (const item of batch.results) {
            if (item.isError) stats.lastError = item.content.summary;
            else {
              const work = `${item.toolName}: ${item.content.summary}`;
              appendUnique(stats.completedWork, work);
              if (executionModes.get(item.toolName) === 'write_exclusive') appendUnique(stats.sideEffects, work);
            }
            const skipped = ['PRIOR_WRITE_FAILED', 'TURN_CANCELLED', 'TOOL_CALL_LIMIT_REACHED'].includes(item.content.error?.code ?? '');
            yield { type: skipped ? 'tool_call_skipped' : 'tool_call_completed', taskId: input.taskId, runId, iteration, callId: item.callId, toolName: item.toolName, result: item, ...(step === undefined ? {} : { stepId: step.id }) };
          }
          protocolCorrection = CONTROL_DECISION_CHECKPOINT;
          ({ lastFingerprint, repeats } = repeat(lastFingerprint, repeats, fingerprint(['business', businessActions.map((action) => action.actionDigest), batch.results.map(stableResult)])));
          yield iterationDone(input.taskId, runId, iteration, step?.id);
          if (repeats >= 3) {
            const reason = '连续三次执行相同工具批次并得到等价结果。'; stats.lastError = reason;
            const failed = failActiveStep(reason); if (failed !== undefined) yield failed;
            yield stop(input.taskId, runId, outcome('abnormal', reason)); return;
          }
          continue;
        }

        const actionOutcome = await this.actionTask.performActionBatch(actionRequest, input.signal, stats.toolCalls);
        if (actionOutcome.kind === 'invalid') {
          stats.toolErrors += actionOutcome.results.length;
          stats.lastError = actionOutcome.results.at(-1)?.content.summary;
          ({ lastFingerprint, repeats } = repeat(lastFingerprint, repeats, fingerprint(['invalid', actionOutcome.results.map(stableResult)])));
          yield iterationDone(input.taskId, runId, iteration, step?.id);
          continue;
        }
        if (actionOutcome.kind !== 'control' || controlActions.length !== 1 || actionOutcome.calls.length !== 1) throw new Error('ACTION_BATCH_KIND_MISMATCH');
        const call = actionOutcome.calls[0]!;
        const validated = this.controls.validate(call, phase);
        if (!validated.ok) {
          stats.lastError = validated.error.message;
          const error = errorResult(call, validated.error.code, validated.error.message);
          await this.actionTask.appendResults([error], runId, {}, input.signal);
          ({ lastFingerprint, repeats } = repeat(lastFingerprint, repeats, fingerprint(['control', stableCall(call), validated.error.code])));
          yield iterationDone(input.taskId, runId, iteration, step?.id);
          if (repeats >= 3) {
            const reason = '控制工具连续三次返回相同校验错误。'; stats.lastError = reason;
            const failed = failActiveStep(reason); if (failed !== undefined) yield failed;
            yield stop(input.taskId, runId, outcome('abnormal', reason)); return;
          }
          continue;
        }
        const control = validated.input;

        if (validated.name === 'request_user_input') {
          const id = questionId(); const prompt = control.prompt as string;
          yield { type: 'user_input_requested', taskId: input.taskId, runId, questionId: id, prompt };
          yield iterationDone(input.taskId, runId, iteration, step?.id);
          yield stop(input.taskId, runId, { ...outcome('awaiting_input', '等待用户补充信息。'), question: { questionId: id, prompt } }); return;
        }
        if (validated.name === 'request_plan_revision') {
          const reason = control.reason as string; const suggestion = control.suggestion as string;
          yield { type: 'plan_revision_requested', taskId: input.taskId, runId, reason, suggestion };
          yield iterationDone(input.taskId, runId, iteration, step?.id);
          yield stop(input.taskId, runId, { ...outcome('plan_revision', reason), revision: { reason, suggestion } }); return;
        }
        if (validated.name === 'submit_plan') {
          try {
            const submitted = control as unknown as SubmittedPlanInput; validatePlanSubmission(submitted);
            const next = planFromSubmission(submitted, input.plan?.planId ?? planId(), (input.plan?.version ?? 0) + 1);
            plan = input.plan === undefined ? next : reconcilePlan(input.plan, next);
            yield { type: 'plan_submitted', taskId: input.taskId, runId, plan };
            yield iterationDone(input.taskId, runId, iteration);
            yield stop(input.taskId, runId, outcome('completed', '计划已生成，等待用户确认。')); return;
          } catch (error) { stats.lastError = safeMessage(error); ({ lastFingerprint, repeats } = await this.feedback(call, error, lastFingerprint, repeats, runId, input.signal)); yield iterationDone(input.taskId, runId, iteration); continue; }
        }
        if (validated.name === 'complete_step') {
          try {
            if (plan === undefined || step === undefined || control.stepId !== step.id) throw new PlanValidationError('STALE_PLAN_STEP', '只能完成当前步骤。');
            const evidence = validateCriteria(step.successCriteria, control.criteria);
            plan = updateStep(plan, step.id, { status: 'completed', evidence, statusReason: undefined });
            await this.actionTask.appendResults([controlSuccess(call, `步骤 ${step.id} 已完成。`)], runId, {}, input.signal);
            yield { type: 'plan_step_completed', taskId: input.taskId, runId, planId: plan.planId, version: plan.version, stepId: step.id, evidence };
            lastFingerprint = undefined; repeats = 0; yield iterationDone(input.taskId, runId, iteration, step.id); continue;
          } catch (error) { stats.lastError = safeMessage(error); ({ lastFingerprint, repeats } = await this.feedback(call, error, lastFingerprint, repeats, runId, input.signal)); yield iterationDone(input.taskId, runId, iteration, step?.id); continue; }
        }
        if (validated.name === 'skip_step') {
          if (plan === undefined || step === undefined || control.stepId !== step.id) { ({ lastFingerprint, repeats } = await this.feedback(call, new PlanValidationError('STALE_PLAN_STEP', '只能跳过当前步骤。'), lastFingerprint, repeats, runId, input.signal)); yield iterationDone(input.taskId, runId, iteration, step?.id); continue; }
          const reason = control.reason as string; plan = updateStep(plan, step.id, { status: 'skipped', statusReason: reason });
          await this.actionTask.appendResults([controlSuccess(call, `步骤 ${step.id} 已跳过。`)], runId, {}, input.signal);
          yield { type: 'plan_step_skipped', taskId: input.taskId, runId, planId: plan.planId, version: plan.version, stepId: step.id, reason };
          yield iterationDone(input.taskId, runId, iteration, step.id); continue;
        }
        if (validated.name === 'complete_task') {
          try {
            if (input.kind === 'plan_execute') validatePlanCompletion(plan!, control.criteria);
            yield iterationDone(input.taskId, runId, iteration, step?.id);
            yield stop(input.taskId, runId, { ...outcome('completed', '任务已完成。'), result: control.result as string, verificationSummary: control.verificationSummary as string }); return;
          } catch (error) { stats.lastError = safeMessage(error); ({ lastFingerprint, repeats } = await this.feedback(call, error, lastFingerprint, repeats, runId, input.signal)); yield iterationDone(input.taskId, runId, iteration, step?.id); }
        }
        if (repeats >= 3) {
          const reason = '控制工具连续三次返回相同校验错误。'; stats.lastError = reason;
          const failed = failActiveStep(reason); if (failed !== undefined) yield failed;
          yield stop(input.taskId, runId, outcome('abnormal', reason)); return;
        }
      }
    } catch (error) {
      const cancelled = input.signal.aborted || error instanceof PermissionCancelledError;
      const message = cancelled ? '用户取消了当前运行。' : safeMessage(error);
      if (!cancelled) stats.lastError = message;
      const failed = cancelled ? undefined : failActiveStep(message);
      if (failed !== undefined) yield failed;
      const integrityFailure = error instanceof SecurityIntegrityFailureError;
      const baseStopped = outcome(cancelled ? 'cancelled' : integrityFailure ? 'security_integrity_failure' : 'abnormal', message);
      const stopped = integrityFailure
        ? { ...baseStopped, effectsMayHaveOccurred: error.effectsMayHaveOccurred }
        : baseStopped;
      const safeError = modelExchangeSafeError(error);
      const integrityError = integrityFailure ? { code: error.code, message: error.message, retryable: false } : undefined;
      yield stop(input.taskId, runId, cancelled || (safeError === undefined && integrityError === undefined)
        ? stopped
        : { ...stopped, error: integrityError ?? safeError });
    }
  }

  private async feedback(
    call: ToolCallRequest,
    error: unknown,
    previous: string | undefined,
    count: number,
    runId: string,
    signal: AbortSignal,
  ) {
    const failure = error instanceof PlanValidationError ? error : new PlanValidationError('INVALID_CONTROL_INPUT', '控制工具输入无效。');
    await this.actionTask.appendResults([errorResult(call, failure.code, failure.message)], runId, {}, signal);
    return repeat(previous, count, fingerprint(['control', stableCall(call), failure.code]));
  }

  private collect(
    runId: string,
    iteration: number,
    runtime: import('../shared/types.js').RuntimeStateContext,
    tools: readonly import('../shared/types.js').ToolDefinition[],
    signal: AbortSignal,
  ): Promise<ActionModelExchangeResponse> {
    const businessNames = new Set(this.actionTask.definitions('all').map((tool) => tool.name));
    const request = this.actionTask.prepareModelExchange({
      runId,
      iteration,
      runtime,
      businessTools: tools.filter((tool) => businessNames.has(tool.name)),
      controlTools: tools.filter((tool) => !businessNames.has(tool.name)),
    });
    return this.actionTask.performModelExchange(request, signal);
  }
}

function phaseFor(kind: AgentRunKind, plan: Plan | undefined): AgentPhase {
  if (kind === 'react') return 'react'; if (kind === 'plan_draft') return 'plan_draft';
  return nextExecutableStep(plan!) === undefined && plan?.steps.every((step) => step.status !== 'in_progress') ? 'plan_finalize' : 'plan_step';
}
function limitMessage(kind: AgentRunKind, iterations: number, stepId: string | undefined, stepIterations: number): string | undefined {
  const max = kind === 'react' ? REACT_LIMIT : kind === 'plan_draft' ? DRAFT_LIMIT : PLAN_LIMIT;
  if (iterations >= max) return `AgentLoop 已达到 ${max} 次迭代上限。`;
  if (kind === 'plan_execute' && stepId !== undefined && stepIterations >= STEP_LIMIT) return `计划步骤 ${stepId} 已达到 ${STEP_LIMIT} 次迭代上限。`;
  return undefined;
}
function result(reason: RunOutcome['reason'], stats: Stats, summary: string, plan: Plan | undefined, task: string, taskCompleted: boolean): RunOutcome {
  const completedSteps = plan?.steps.filter((step) => step.status === 'completed').map((step) => `${step.id}: ${step.description}`) ?? [];
  const unfinishedWork = taskCompleted ? [] : plan === undefined
    ? stats.unfinishedWork.length > 0 ? stats.unfinishedWork : [task]
    : plan.steps.filter((step) => !['completed', 'skipped'].includes(step.status)).map((step) => `${step.id}: ${step.description}`);
  const progress = {
    completedWork: unique([...stats.completedWork, ...completedSteps]),
    unfinishedWork,
    sideEffects: unique(stats.sideEffects),
    ...(stats.lastError === undefined ? {} : { lastError: stats.lastError }),
  };
  const detailedSummary = reason === 'iteration_limit' || reason === 'abnormal' ? formatProgress(summary, progress) : summary;
  return { reason, summary: detailedSummary, progress, ...(plan === undefined ? {} : { plan }), ...(stats.usage === undefined ? {} : { usage: stats.usage }),
    promptAudits: Object.freeze([...stats.promptAudits]), iterationCount: stats.iterations, toolCallCount: stats.toolCalls, toolErrorCount: stats.toolErrors };
}
function stop(taskId: string, runId: string, outcome: RunOutcome): AgentEvent { return { type: 'run_stopped', taskId, runId, outcome }; }
function iterationDone(taskId: string, runId: string, iteration: number, stepId?: string): AgentEvent { return { type: 'iteration_completed', taskId, runId, iteration, ...(stepId === undefined ? {} : { stepId }) }; }
function errorResult(call: ToolCallRequest | undefined, code: string, message: string): ToolCallResult { return { callId: call?.callId ?? `control-${code}`, providerCallId: call?.providerCallId ?? `control-${code}`, toolName: call?.name ?? 'agent_control', isError: true, content: { summary: message, error: { code, message, retryable: false } } }; }
function controlSuccess(call: ToolCallRequest, summary: string): ToolCallResult { return { callId: call.callId, providerCallId: call.providerCallId, toolName: call.name, isError: false, content: { summary } }; }
function repeat(previous: string | undefined, count: number, current: string) { return { lastFingerprint: current, repeats: previous === current ? count + 1 : 1 }; }
function stableCall(call: ToolCallRequest) { return { name: call.name, input: stable(call.input) }; }
function stableResult(item: ToolCallResult) { return { toolName: item.toolName, isError: item.isError, content: stable(item.content) }; }
function fingerprint(value: unknown): string { return JSON.stringify(stable(value)); }
function stable(value: unknown): unknown { if (Array.isArray(value)) return value.map(stable); if (!isRecord(value)) return value; return Object.fromEntries(Object.entries(value).filter(([key]) => !['durationMs', 'timestamp', 'startedAt', 'finishedAt'].includes(key)).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stable(child)])); }
function appendUnique(values: string[], value: string): void { if (!values.includes(value)) values.push(value); }
function unique(values: readonly string[]): readonly string[] { return [...new Set(values)]; }
function formatProgress(summary: string, progress: RunOutcome['progress']): string {
  return `${summary} 已完成：${progress.completedWork.join('、') || '无'}；未完成：${progress.unfinishedWork.join('、') || '无'}；副作用：${progress.sideEffects.join('、') || '无'}；最后异常：${progress.lastError ?? '无'}。`;
}
function addUsage(current: TokenUsage | undefined, next: TokenUsage | undefined): TokenUsage | undefined {
  if (current === undefined && next === undefined) return undefined;
  return {
    ...(current?.inputTokens === undefined && next?.inputTokens === undefined ? {} : { inputTokens: (current?.inputTokens ?? 0) + (next?.inputTokens ?? 0) }),
    ...(current?.outputTokens === undefined && next?.outputTokens === undefined ? {} : { outputTokens: (current?.outputTokens ?? 0) + (next?.outputTokens ?? 0) }),
    ...(current?.cacheReadInputTokens === undefined && next?.cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens: (current?.cacheReadInputTokens ?? 0) + (next?.cacheReadInputTokens ?? 0) }),
    ...(current?.cacheWriteInputTokens === undefined && next?.cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens: (current?.cacheWriteInputTokens ?? 0) + (next?.cacheWriteInputTokens ?? 0) }),
  };
}
function safeMessage(error: unknown): string { return error instanceof Error ? error.message : 'AgentLoop 运行时发生内部错误。'; }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function modelExchangeSafeError(error: unknown): SafeError | undefined {
  if (typeof error !== 'object' || error === null || !('safeError' in error)) return undefined;
  const value = (error as { safeError?: unknown }).safeError;
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Partial<SafeError>;
  return typeof candidate.code === 'string' && typeof candidate.message === 'string' && typeof candidate.retryable === 'boolean'
    ? { code: candidate.code, message: candidate.message, retryable: candidate.retryable }
    : undefined;
}
