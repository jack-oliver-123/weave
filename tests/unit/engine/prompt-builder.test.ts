import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../../../src/engine/prompt-builder.js';
import type { Plan } from '../../../src/shared/types.js';

const plan: Plan = {
  planId: 'p1', version: 1, goal: '交付功能', successCriteria: ['全量测试通过'],
  steps: [{ id: 's1', description: '实现核心', dependencies: [], successCriteria: ['单测通过'], status: 'pending', evidence: [] }],
};

describe('buildSystemPrompt', () => {
  it('builds a minimal ReAct prompt', () => {
    const prompt = buildSystemPrompt({ mode: 'react', iterationLimit: 10 });
    expect(prompt).toContain('request_user_input');
    expect(prompt).toContain('complete_task');
    expect(prompt).toContain('ReAct');
    expect(prompt).not.toContain('submit_plan');
    expect(prompt).not.toContain('权限');
  });

  it('builds plan drafting and execution fragments separately', () => {
    const draft = buildSystemPrompt({ mode: 'plan_draft', iterationLimit: 10 });
    const execute = buildSystemPrompt({ mode: 'plan_execute', iterationLimit: 10, plan, step: plan.steps[0] });
    expect(draft).toContain('submit_plan');
    expect(draft).not.toContain('complete_step');
    expect(execute).toContain('complete_step');
    expect(execute).toContain('单测通过');
    expect(execute).toContain('request_plan_revision');
  });
});
