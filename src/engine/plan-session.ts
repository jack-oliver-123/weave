import type { Plan, PlanStep } from '../shared/types.js';
import type { SubmittedPlanInput } from './control-tools.js';
import { planFromSubmission } from './control-tools.js';
import { reconcilePlan, updateStep, validatePlanSubmission } from './plan.js';

export type PlanSessionState =
  | 'draft'
  | 'awaiting_approval'
  | 'executing'
  | 'awaiting_input'
  | 'awaiting_revision'
  | 'cancelled'
  | 'completed';

export class PlanSession {
  private readonly plans: Plan[] = [];
  private currentState: PlanSessionState = 'draft';
  private stateBeforeInput: 'draft' | 'executing' | undefined;

  constructor(private readonly planId: string) {}

  get id(): string { return this.planId; }
  get state(): PlanSessionState { return this.currentState; }
  get versions(): readonly Plan[] { return this.plans; }
  get current(): Plan | undefined { return this.plans.at(-1); }

  submit(input: SubmittedPlanInput): Plan {
    this.requireState('draft', 'awaiting_revision');
    validatePlanSubmission(input);
    const previous = this.current;
    const next = planFromSubmission(input, this.planId, (previous?.version ?? 0) + 1);
    const merged = previous === undefined ? next : reconcilePlan(previous, next);
    this.plans.push(merged);
    this.currentState = 'awaiting_approval';
    return merged;
  }

  adopt(plan: Plan): void {
    this.requireState('draft', 'awaiting_revision');
    if (plan.planId !== this.planId || plan.version !== (this.current?.version ?? 0) + 1) {
      throw new PlanStateError('INVALID_PLAN_VERSION', '生成计划的标识或版本无效。');
    }
    const previous = this.current;
    this.plans.push(previous === undefined ? plan : reconcilePlan(previous, plan));
    this.currentState = 'awaiting_approval';
  }

  refine(): void { this.requireState('awaiting_approval'); this.currentState = 'draft'; }

  approve(planId: string, version: number): Plan {
    this.requireState('awaiting_approval');
    const current = this.current;
    if (current === undefined || current.planId !== planId || current.version !== version) {
      throw new PlanStateError('STALE_PLAN_APPROVAL', '计划审批版本已过期。');
    }
    this.currentState = 'executing';
    return current;
  }

  replaceCurrent(plan: Plan): void {
    this.requireState('executing', 'awaiting_input');
    if (this.current?.planId !== plan.planId || this.current.version !== plan.version) throw new PlanStateError('STALE_PLAN_UPDATE', '计划更新版本已过期。');
    this.plans[this.plans.length - 1] = plan;
  }

  awaitInput(): void {
    this.requireState('draft', 'executing');
    this.stateBeforeInput = this.currentState as 'draft' | 'executing';
    this.currentState = 'awaiting_input';
  }
  answerInput(): void {
    this.requireState('awaiting_input');
    this.currentState = this.stateBeforeInput ?? 'executing';
    this.stateBeforeInput = undefined;
  }
  requestRevision(): void { this.requireState('executing'); this.currentState = 'awaiting_revision'; }
  beginRevision(): void { this.requireState('awaiting_revision'); this.currentState = 'draft'; }
  prepareRevision(): void {
    if (this.currentState === 'executing') this.requestRevision();
    if (this.currentState === 'awaiting_revision') this.beginRevision();
    else if (this.currentState === 'awaiting_approval') this.refine();
    else this.requireState('draft');
  }
  cancel(): void { this.requireState('draft', 'awaiting_approval', 'executing', 'awaiting_input', 'awaiting_revision'); this.currentState = 'cancelled'; }
  resume(): void { this.requireState('cancelled'); this.currentState = this.current === undefined ? 'draft' : 'awaiting_approval'; }
  complete(): void { this.requireState('executing'); this.currentState = 'completed'; }

  private requireState(...allowed: PlanSessionState[]): void {
    if (!allowed.includes(this.currentState)) throw new PlanStateError('INVALID_PLAN_STATE', `计划状态 ${this.currentState} 不允许该操作。`);
  }
}

export class PlanStateError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'PlanStateError'; }
}
