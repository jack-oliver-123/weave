import type { AgentStopReason, AgentTaskMode, Plan, RunOutcome, RunProgressSummary } from '../shared/types.js';
import { PlanSession } from './plan-session.js';

export type AgentTaskState = 'running' | 'awaiting_input' | 'awaiting_approval' | 'stopped' | 'cancelled' | 'completed' | 'exited';

export interface PendingQuestion { readonly questionId: string; readonly prompt: string }

export class AgentTaskSession {
  private currentState: AgentTaskState = 'running';
  private runs = 0;
  private iterations = 0;
  private question: PendingQuestion | undefined;
  private cumulativeProgress: RunProgressSummary = { completedWork: [], unfinishedWork: [], sideEffects: [] };
  readonly planSession?: PlanSession;

  constructor(readonly taskId: string, readonly mode: AgentTaskMode, planId?: string) {
    if (mode === 'plan') this.planSession = new PlanSession(planId ?? `${taskId}-plan`);
  }

  get state(): AgentTaskState { return this.currentState; }
  get runCount(): number { return this.runs; }
  get totalIterations(): number { return this.iterations; }
  get pendingQuestion(): PendingQuestion | undefined { return this.question; }
  get progress(): RunProgressSummary { return this.cumulativeProgress; }

  beginRun(): void {
    if (!['running', 'stopped', 'cancelled', 'awaiting_input', 'awaiting_approval'].includes(this.currentState)) throw invalid('INVALID_TASK_STATE');
    this.currentState = 'running';
    this.runs += 1;
  }

  applyOutcome(outcome: RunOutcome): void {
    this.iterations += outcome.iterationCount;
    this.currentState = taskStateFor(outcome.reason);
    this.question = outcome.question;
    this.cumulativeProgress = mergeProgress(this.cumulativeProgress, outcome.progress);
  }

  answer(questionId: string): void {
    if (this.currentState !== 'awaiting_input' || this.question?.questionId !== questionId) throw invalid('STALE_TASK_ANSWER');
    this.question = undefined;
    this.currentState = 'running';
  }

  awaitApproval(): void { this.require('running'); this.currentState = 'awaiting_approval'; }
  markAwaitingApproval(): void { this.currentState = 'awaiting_approval'; }
  continue(): void { this.require('stopped'); this.currentState = 'running'; }
  resume(): void { this.require('cancelled'); this.currentState = this.mode === 'plan' ? 'awaiting_approval' : 'running'; }
  exit(): void { if (this.currentState === 'completed' || this.currentState === 'exited') throw invalid('INVALID_TASK_STATE'); this.currentState = 'exited'; }
  completePlan(plan: Plan): void { if (this.planSession?.current?.planId !== plan.planId) throw invalid('STALE_PLAN_UPDATE'); this.planSession.replaceCurrent(plan); }

  private require(state: AgentTaskState): void { if (this.currentState !== state) throw invalid('INVALID_TASK_STATE'); }
}

function mergeProgress(previous: RunProgressSummary, current: RunProgressSummary): RunProgressSummary {
  return {
    completedWork: unique([...previous.completedWork, ...current.completedWork]),
    unfinishedWork: current.unfinishedWork,
    sideEffects: unique([...previous.sideEffects, ...current.sideEffects]),
    ...(current.lastError === undefined ? previous.lastError === undefined ? {} : { lastError: previous.lastError } : { lastError: current.lastError }),
  };
}

function unique(values: readonly string[]): readonly string[] { return [...new Set(values)]; }

export class TaskStateError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'TaskStateError'; }
}

function taskStateFor(reason: AgentStopReason): AgentTaskState {
  if (reason === 'completed') return 'completed';
  if (reason === 'cancelled') return 'cancelled';
  if (reason === 'awaiting_input') return 'awaiting_input';
  if (reason === 'plan_revision') return 'awaiting_approval';
  return 'stopped';
}
function invalid(code: string): TaskStateError { return new TaskStateError(code, '任务状态不允许该操作。'); }
