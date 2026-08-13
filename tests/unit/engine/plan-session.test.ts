import { describe, expect, it } from 'vitest';
import { PlanSession } from '../../../src/engine/plan-session.js';
import { validatePlanSubmission } from '../../../src/engine/plan.js';
import { AgentTaskSession } from '../../../src/engine/task-session.js';

const submission = { goal: '交付', successCriteria: ['通过'], steps: [{ id: 's1', description: '实现', dependencies: [], successCriteria: ['单测'] }] };

describe('PlanSession', () => {
  it('validates forward-only dependencies', () => {
    expect(() => validatePlanSubmission({ ...submission, steps: [
      { id: 's1', description: '实现', dependencies: ['s2'], successCriteria: ['单测'] },
      { id: 's2', description: '验证', dependencies: [], successCriteria: ['构建'] },
    ] })).toThrowError(expect.objectContaining({ code: 'PLAN_FORWARD_OR_UNKNOWN_DEPENDENCY' }));
  });

  it('versions plans and rejects stale approvals', () => {
    const session = new PlanSession('p1');
    const first = session.submit(submission);
    expect(first.version).toBe(1);
    session.refine();
    const second = session.submit({ ...submission, goal: '新目标' });
    expect(second).toMatchObject({ planId: 'p1', version: 2, supersedesVersion: 1 });
    expect(() => session.approve('p1', 1)).toThrowError(expect.objectContaining({ code: 'STALE_PLAN_APPROVAL' }));
    expect(session.approve('p1', 2)).toBe(second);
  });

  it('returns user input to the phase that requested it', () => {
    const drafting = new PlanSession('p1');
    drafting.awaitInput();
    drafting.answerInput();
    expect(drafting.state).toBe('draft');

    const executing = new PlanSession('p2');
    const plan = executing.submit(submission);
    executing.approve(plan.planId, plan.version);
    executing.awaitInput();
    executing.answerInput();
    expect(executing.state).toBe('executing');
  });

  it('preserves valid completed evidence and invalidates changed completed steps', () => {
    const session = new PlanSession('p1');
    const first = session.submit(submission);
    session.approve(first.planId, first.version);
    session.replaceCurrent({ ...first, steps: [{ ...first.steps[0]!, status: 'completed', evidence: ['unit ok'] }] });
    session.requestRevision();
    session.beginRevision();
    const unchanged = session.submit(submission);
    expect(unchanged.steps[0]).toMatchObject({ status: 'completed', evidence: ['unit ok'] });
    session.refine();
    const changed = session.submit({ ...submission, steps: [{ ...submission.steps[0]!, description: '重写实现' }] });
    expect(changed.steps[0]).toMatchObject({ status: 'invalidated', evidence: ['unit ok'], statusReason: '计划修订使原完成结果失效。' });
  });
});

describe('AgentTaskSession', () => {
  it('tracks correlated runs and rejects stale answers', () => {
    const task = new AgentTaskSession('t1', 'react');
    task.beginRun();
    task.applyOutcome({ reason: 'awaiting_input', summary: '等待', progress: { completedWork: ['读取配置'], unfinishedWork: ['完成任务'], sideEffects: ['写入 a.ts'] }, question: { questionId: 'q1', prompt: '输入' }, iterationCount: 2, toolCallCount: 0, toolErrorCount: 0 });
    expect(task).toMatchObject({ state: 'awaiting_input', runCount: 1, totalIterations: 2 });
    expect(() => task.answer('stale')).toThrowError(expect.objectContaining({ code: 'STALE_TASK_ANSWER' }));
    task.answer('q1');
    task.beginRun();
    expect(task.runCount).toBe(2);
    expect(task.progress).toEqual({ completedWork: ['读取配置'], unfinishedWork: ['完成任务'], sideEffects: ['写入 a.ts'] });
  });

  it('resumes cancelled plans through approval', () => {
    const task = new AgentTaskSession('t1', 'plan', 'p1');
    task.applyOutcome({ reason: 'cancelled', summary: '取消', progress: { completedWork: [], unfinishedWork: ['完成任务'], sideEffects: [] }, iterationCount: 1, toolCallCount: 0, toolErrorCount: 0 });
    task.resume();
    expect(task.state).toBe('awaiting_approval');
  });

  it('prepares stopped plan execution for a new revision', () => {
    const session = new PlanSession('p1');
    const plan = session.submit(submission);
    session.approve(plan.planId, plan.version);
    session.prepareRevision();
    expect(session.state).toBe('draft');
  });
});
