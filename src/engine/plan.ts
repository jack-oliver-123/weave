import type { Plan, PlanStep } from '../shared/types.js';
import type { SubmittedPlanInput } from './control-tools.js';

export class PlanValidationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'PlanValidationError';
  }
}

export function validatePlanSubmission(input: SubmittedPlanInput): void {
  if (input.goal.trim().length === 0) throw invalid('PLAN_GOAL_REQUIRED', '计划目标不能为空。');
  if (!hasNonEmptyStrings(input.successCriteria)) throw invalid('PLAN_SUCCESS_CRITERIA_REQUIRED', '任务级成功标准不能为空。');
  if (input.steps.length === 0) throw invalid('PLAN_STEPS_REQUIRED', '计划至少需要一个步骤。');
  const seen = new Set<string>();
  for (const step of input.steps) {
    if (step.id.trim().length === 0 || seen.has(step.id)) throw invalid('PLAN_STEP_ID_INVALID', '步骤 ID 必须非空且唯一。');
    if (step.description.trim().length === 0) throw invalid('PLAN_STEP_DESCRIPTION_REQUIRED', '步骤说明不能为空。');
    if (!hasNonEmptyStrings(step.successCriteria)) throw invalid('PLAN_STEP_CRITERIA_REQUIRED', '每个步骤都需要成功标准。');
    const dependencies = new Set<string>();
    for (const dependency of step.dependencies) {
      if (dependency === step.id) throw invalid('PLAN_SELF_DEPENDENCY', '步骤不能依赖自身。');
      if (dependencies.has(dependency)) throw invalid('PLAN_DUPLICATE_DEPENDENCY', '步骤依赖不能重复。');
      if (!seen.has(dependency)) throw invalid('PLAN_FORWARD_OR_UNKNOWN_DEPENDENCY', '步骤只能依赖数组中更早的已知步骤。');
      dependencies.add(dependency);
    }
    seen.add(step.id);
  }
}

export function updateStep(plan: Plan, stepId: string, update: Partial<PlanStep>): Plan {
  const index = plan.steps.findIndex((step) => step.id === stepId);
  if (index < 0) throw invalid('PLAN_STEP_NOT_FOUND', '计划步骤不存在。');
  return { ...plan, steps: plan.steps.map((step, current) => current === index ? { ...step, ...update } : step) };
}

export function nextExecutableStep(plan: Plan): PlanStep | undefined {
  return plan.steps.find((step) => step.status === 'pending' || step.status === 'failed' || step.status === 'invalidated');
}

export function blockedDependency(plan: Plan, step: PlanStep): PlanStep | undefined {
  return step.dependencies
    .map((id) => plan.steps.find((candidate) => candidate.id === id))
    .find((candidate) => candidate === undefined || candidate.status !== 'completed');
}

export function validateCriteria(
  expected: readonly string[],
  actual: unknown,
): readonly string[] {
  if (!Array.isArray(actual) || actual.length !== expected.length) {
    throw invalid('CRITERIA_MISMATCH', '验证结果必须逐项覆盖全部成功标准。');
  }
  const evidence: string[] = [];
  for (let index = 0; index < expected.length; index += 1) {
    const item = actual[index];
    if (!isRecord(item) || item.criterion !== expected[index] || item.passed !== true || typeof item.evidence !== 'string' || item.evidence.trim().length === 0) {
      throw invalid('CRITERIA_NOT_SATISFIED', '成功标准尚未全部通过并提供证据。');
    }
    evidence.push(item.evidence);
  }
  return evidence;
}

export function validatePlanCompletion(plan: Plan, criteria: unknown): readonly string[] {
  for (const step of plan.steps) {
    if (step.status === 'completed') {
      if (step.evidence.length === 0) throw invalid('STEP_EVIDENCE_REQUIRED', '完成步骤缺少验证证据。');
      continue;
    }
    if (step.status === 'skipped' && (step.statusReason?.trim().length ?? 0) > 0) continue;
    throw invalid('PLAN_STEPS_INCOMPLETE', '计划仍有未完成或无理由跳过的步骤。');
  }
  return validateCriteria(plan.successCriteria, criteria);
}

export function reconcilePlan(previous: Plan, next: Plan): Plan {
  const previousById = new Map(previous.steps.map((step) => [step.id, step]));
  return { ...next, steps: next.steps.map((step) => reconcileStep(previousById.get(step.id), step)) };
}

function reconcileStep(previous: PlanStep | undefined, next: PlanStep): PlanStep {
  if (previous === undefined || previous.status !== 'completed') return next;
  const unchanged = previous.description === next.description
    && JSON.stringify(previous.dependencies) === JSON.stringify(next.dependencies)
    && JSON.stringify(previous.successCriteria) === JSON.stringify(next.successCriteria);
  return unchanged ? previous : { ...next, status: 'invalidated', evidence: previous.evidence, statusReason: '计划修订使原完成结果失效。' };
}

function hasNonEmptyStrings(values: readonly string[]): boolean {
  return values.length > 0 && values.every((value) => value.trim().length > 0);
}

function invalid(code: string, message: string): PlanValidationError { return new PlanValidationError(code, message); }
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
