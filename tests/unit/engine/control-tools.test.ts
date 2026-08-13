import { describe, expect, it } from 'vitest';
import { ControlToolCatalog } from '../../../src/engine/control-tools.js';
import type { ToolCallRequest } from '../../../src/shared/types.js';

const call = (name: string, input: unknown): ToolCallRequest => ({ callId: 'c1', providerCallId: 'p1', name, input });

describe('ControlToolCatalog', () => {
  it('exposes only tools allowed by the current phase', () => {
    const catalog = new ControlToolCatalog();
    expect(catalog.definitions('react').map((item) => item.name)).toEqual(['complete_task', 'request_user_input']);
    expect(catalog.definitions('plan_draft').map((item) => item.name)).toEqual(['submit_plan', 'request_user_input']);
    expect(catalog.definitions('plan_step').map((item) => item.name)).toEqual([
      'complete_step', 'skip_step', 'request_user_input', 'request_plan_revision',
    ]);
  });

  it('validates structured input and rejects phase mismatches', () => {
    const catalog = new ControlToolCatalog();
    expect(catalog.validate(call('complete_task', { result: '完成', verificationSummary: '测试通过' }), 'react')).toMatchObject({ ok: true });
    expect(catalog.validate(call('complete_task', { result: '' }), 'react')).toMatchObject({ ok: false, error: { code: 'INVALID_CONTROL_INPUT' } });
    expect(catalog.validate(call('submit_plan', {}), 'react')).toMatchObject({ ok: false, error: { code: 'CONTROL_TOOL_NOT_ALLOWED' } });
  });
});
