import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  AgentEvent,
  ConversationController,
  Plan,
  RunOutcome,
  TaskAction,
  ToolExecutor,
  UserTurn,
} from '../../../src/shared/types.js';

describe('Agent task contracts', () => {
  it('requires explicit modes and structured actions', () => {
    const turn: UserTurn = { mode: 'react', content: '检查项目' };
    const action: TaskAction = { type: 'approve_plan', taskId: 'task-1', planId: 'plan-1', version: 2 };
    expect(turn.mode).toBe('react');
    expect(action).toMatchObject({ planId: 'plan-1', version: 2 });
    expectTypeOf<ConversationController['dispatch']>().returns.toEqualTypeOf<AsyncIterable<import('../../../src/shared/types.js').TurnEvent>>();
  });

  it('correlates plan, run and terminal events without presentation text', () => {
    const plan: Plan = {
      planId: 'plan-1', version: 1, goal: '完成任务', successCriteria: ['测试通过'],
      steps: [{ id: 's1', description: '实现', dependencies: [], successCriteria: ['实现完成'], status: 'pending', evidence: [] }],
    };
    const outcome: RunOutcome = {
      reason: 'completed', result: '完成', verificationSummary: '测试通过', summary: '完成',
      progress: { completedWork: ['实现'], unfinishedWork: [], sideEffects: [] },
      iterationCount: 1, toolCallCount: 0, toolErrorCount: 0, plan,
    };
    const event: AgentEvent = { type: 'run_stopped', taskId: 'task-1', runId: 'run-1', outcome };
    expect(event.runId).toBe('run-1');
    expect(event.outcome.plan?.steps[0]?.id).toBe('s1');
    expect(event).not.toHaveProperty('message');
  });

  it('exposes a narrow tool executor interface', () => {
    expectTypeOf<ToolExecutor['definitions']>().returns.toMatchTypeOf<readonly import('../../../src/shared/types.js').ToolDefinition[]>();
    expectTypeOf<ToolExecutor['execute']>().returns.toEqualTypeOf<Promise<import('../../../src/shared/types.js').ToolExecutionBatch>>();
  });
});
