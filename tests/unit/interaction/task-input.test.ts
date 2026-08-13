import { describe, expect, it } from 'vitest';
import { decisionAction, decisionOptions, parseTopLevelInput } from '../../../src/interaction/task-input.js';

describe('任务输入路由', () => {
  it('普通输入显式进入 ReAct，/plan 去掉前缀后进入 Plan', () => {
    expect(parseTopLevelInput('检查项目')).toEqual({ ok: true, mode: 'react', content: '检查项目' });
    expect(parseTopLevelInput('/plan  完成交付 ')).toEqual({ ok: true, mode: 'plan', content: '完成交付' });
    expect(parseTopLevelInput('/plan')).toEqual({ ok: false, message: '用法：/plan <任务>' });
  });

  it('Plan 决策携带当前 planId 与 version，自由输入走修订', () => {
    const decision = { kind: 'plan_approval' as const, taskId: 't1', planId: 'p1', version: 2 };
    expect(decisionOptions(decision)).toEqual(['执行计划', '继续完善', '退出任务']);
    expect(decisionAction(decision, 0)).toEqual({ type: 'approve_plan', taskId: 't1', planId: 'p1', version: 2 });
    expect(decisionAction(decision, 1)).toEqual({ type: 'refine_plan', taskId: 't1' });
    expect(decisionAction(decision, 0, '增加验收')).toEqual({ type: 'refine_plan', taskId: 't1', content: '增加验收' });
  });

  it('停止与取消提供恢复和退出动作', () => {
    expect(decisionOptions({ kind: 'stopped', taskId: 't1' })).toEqual(['继续', '补充要求', '退出任务']);
    expect(decisionAction({ kind: 'stopped', taskId: 't1' }, 2)).toEqual({ type: 'exit_task', taskId: 't1' });
    expect(decisionOptions({ kind: 'cancelled', taskId: 't1' })).toEqual(['恢复任务', '退出任务']);
    expect(decisionAction({ kind: 'cancelled', taskId: 't1' }, 0)).toEqual({ type: 'resume_task', taskId: 't1' });
    expect(decisionOptions({ kind: 'plan_revision', taskId: 't1' })).toEqual(['重新规划', '退出任务']);
    expect(decisionAction({ kind: 'plan_revision', taskId: 't1' }, 0)).toEqual({ type: 'refine_plan', taskId: 't1' });
  });
});
