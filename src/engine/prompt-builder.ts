import type { Plan, PlanStep, PromptMode, RuntimeStateContext } from '../shared/types.js';

export { assemblePrompt, buildStableSystemPrompt, buildSystemReminder } from './prompt-assembly.js';
export type { PromptMode } from '../shared/types.js';

export interface PromptContext {
  readonly mode: PromptMode;
  readonly iterationLimit: number;
  readonly plan?: Plan;
  readonly step?: PlanStep;
  readonly protocolCorrection?: string;
}

export function buildRuntimeState(context: PromptContext): RuntimeStateContext {
  if (context.mode === 'plan_execute' && (context.plan === undefined || context.step === undefined)) {
    throw new TypeError('Plan 执行动态上下文需要 plan 和 step。');
  }
  return Object.freeze({
    type: 'agent_state',
    mode: context.mode,
    iterationLimit: context.iterationLimit,
    ...(context.plan === undefined ? {} : { plan: context.plan }),
    ...(context.step === undefined ? {} : { step: context.step }),
    ...(context.protocolCorrection === undefined ? {} : { protocolCorrection: context.protocolCorrection }),
  });
}
