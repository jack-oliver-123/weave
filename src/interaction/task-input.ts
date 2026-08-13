import type { AgentTaskMode, TaskAction } from '../shared/types.js';

export type ParsedTopLevelInput =
  | { readonly ok: true; readonly mode: AgentTaskMode; readonly content: string }
  | { readonly ok: false; readonly message: string };

export type TaskDecision =
  | { readonly kind: 'plan_approval'; readonly taskId: string; readonly planId: string; readonly version: number }
  | { readonly kind: 'stopped'; readonly taskId: string }
  | { readonly kind: 'plan_revision'; readonly taskId: string }
  | { readonly kind: 'cancelled'; readonly taskId: string; readonly planId?: string; readonly version?: number };

export const PLAN_OPTIONS = ['执行计划', '继续完善', '退出任务'] as const;
export const STOPPED_OPTIONS = ['继续', '补充要求', '退出任务'] as const;
export const CANCELLED_OPTIONS = ['恢复任务', '退出任务'] as const;
export const REVISION_OPTIONS = ['重新规划', '退出任务'] as const;

export function parseTopLevelInput(value: string): ParsedTopLevelInput {
  const text = value.trim();
  if (text === '/plan') return { ok: false, message: '用法：/plan <任务>' };
  if (text.startsWith('/plan ')) {
    const content = text.slice('/plan '.length).trim();
    return content.length === 0 ? { ok: false, message: '用法：/plan <任务>' } : { ok: true, mode: 'plan', content };
  }
  return { ok: true, mode: 'react', content: value };
}

export function decisionOptions(decision: TaskDecision): readonly string[] {
  if (decision.kind === 'plan_approval') return PLAN_OPTIONS;
  if (decision.kind === 'stopped') return STOPPED_OPTIONS;
  if (decision.kind === 'plan_revision') return REVISION_OPTIONS;
  return CANCELLED_OPTIONS;
}

export function decisionAction(decision: TaskDecision, index: number, content?: string): TaskAction {
  if (decision.kind === 'plan_approval') {
    if (content !== undefined) return { type: 'refine_plan', taskId: decision.taskId, content };
    if (index === 0) return { type: 'approve_plan', taskId: decision.taskId, planId: decision.planId, version: decision.version };
    if (index === 1) return { type: 'refine_plan', taskId: decision.taskId };
    return { type: 'exit_task', taskId: decision.taskId };
  }
  if (decision.kind === 'stopped') {
    if (content !== undefined) return { type: 'continue_task', taskId: decision.taskId, content };
    if (index < 2) return { type: 'continue_task', taskId: decision.taskId };
    return { type: 'exit_task', taskId: decision.taskId };
  }
  if (decision.kind === 'plan_revision') return index === 0 ? { type: 'refine_plan', taskId: decision.taskId } : { type: 'exit_task', taskId: decision.taskId };
  return index === 0 ? { type: 'resume_task', taskId: decision.taskId } : { type: 'exit_task', taskId: decision.taskId };
}
