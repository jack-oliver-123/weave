import { Ajv, type ValidateFunction } from 'ajv/dist/ajv.js';
import type { Plan, ToolCallRequest, ToolDefinition, ToolErrorContent } from '../shared/types.js';
import { CONTROL_DECISION_RULES } from './prompt-rules.js';

export type AgentPhase = 'react' | 'plan_draft' | 'plan_step' | 'plan_finalize';
export type ControlToolName =
  | 'submit_plan'
  | 'complete_step'
  | 'skip_step'
  | 'complete_task'
  | 'request_user_input'
  | 'request_plan_revision';

export type ControlToolResult =
  | { readonly ok: true; readonly name: ControlToolName; readonly input: Record<string, unknown> }
  | { readonly ok: false; readonly error: ToolErrorContent };

const string = { type: 'string', minLength: 1 } as const;
const strings = { type: 'array', items: string, minItems: 1 } as const;
const criterionResults = {
  type: 'array', minItems: 1, items: {
    type: 'object', additionalProperties: false, required: ['criterion', 'passed', 'evidence'],
    properties: { criterion: string, passed: { type: 'boolean' }, evidence: string },
  },
} as const;
const schemas: Record<ControlToolName, Record<string, unknown>> = {
  submit_plan: {
    type: 'object', additionalProperties: false, required: ['goal', 'successCriteria', 'steps'],
    properties: {
      goal: string, successCriteria: strings,
      steps: { type: 'array', minItems: 1, items: {
        type: 'object', additionalProperties: false, required: ['id', 'description', 'dependencies', 'successCriteria'],
        properties: { id: string, description: string, dependencies: { type: 'array', items: string }, successCriteria: strings },
      } },
    },
  },
  complete_step: {
    type: 'object', additionalProperties: false, required: ['stepId', 'criteria'],
    properties: { stepId: string, criteria: criterionResults },
  },
  skip_step: {
    type: 'object', additionalProperties: false, required: ['stepId', 'reason'], properties: { stepId: string, reason: string },
  },
  complete_task: {
    type: 'object', additionalProperties: false, required: ['result', 'verificationSummary'],
    properties: { result: string, verificationSummary: string, criteria: criterionResults },
  },
  request_user_input: {
    type: 'object', additionalProperties: false, required: ['prompt'], properties: { prompt: string },
  },
  request_plan_revision: {
    type: 'object', additionalProperties: false, required: ['reason', 'suggestion'], properties: { reason: string, suggestion: string },
  },
};

const phaseNames: Record<AgentPhase, readonly ControlToolName[]> = {
  react: ['complete_task', 'request_user_input'],
  plan_draft: ['submit_plan', 'request_user_input'],
  plan_step: ['complete_step', 'skip_step', 'request_user_input', 'request_plan_revision'],
  plan_finalize: ['complete_task', 'request_user_input', 'request_plan_revision'],
};

const purposes: Record<ControlToolName, string> = {
  submit_plan: '提交结构化计划并结束本次规划运行',
  complete_step: '提交当前计划步骤的验证结果',
  skip_step: '使用明确理由跳过当前计划步骤',
  complete_task: '终态优先工具：必要工作和相关验证完成后，下一步立即提交最终结果并结束任务',
  request_user_input: '终态优先工具：请求用户补充关键缺失信息，或在最小只读预检后明确授权高影响操作',
  request_plan_revision: '请求对目标、范围或副作用进行实质修订',
};

const useWhen: Record<ControlToolName, readonly string[]> = {
  submit_plan: ['完整计划已经准备好，需要结束规划运行时'],
  complete_step: ['当前计划步骤的成功标准已经获得验证证据时'],
  skip_step: ['当前计划步骤有明确且可记录的跳过理由时'],
  complete_task: [CONTROL_DECISION_RULES.finishWhenVerified],
  request_user_input: [
    '关键缺失信息会实质改变目标、范围、副作用或不可逆风险时',
    CONTROL_DECISION_RULES.requestHighImpactAuthorization,
  ],
  request_plan_revision: ['需要实质改变已批准计划的目标、范围或副作用时'],
};

const avoidWhen: Record<ControlToolName, readonly string[]> = {
  submit_plan: ['计划仍缺少必要调查或结构化成功标准时'],
  complete_step: ['当前步骤的验证证据不足时'],
  skip_step: ['仍可在当前范围内完成步骤时'],
  complete_task: ['必要工作尚未完成或验证证据不足时'],
  request_user_input: ['相关事实仍可通过当前只读工具查明时'],
  request_plan_revision: ['当前批准范围内可以继续执行时'],
};

export class ControlToolCatalog {
  private readonly validators: ReadonlyMap<ControlToolName, ValidateFunction>;

  constructor() {
    const ajv = new Ajv({ allErrors: true, strict: true });
    this.validators = new Map(Object.entries(schemas).map(([name, schema]) => [name as ControlToolName, ajv.compile(schema)]));
  }

  definitions(phase: AgentPhase): readonly ToolDefinition[] {
    return phaseNames[phase].map((name) => ({
      name,
      purpose: purposes[name],
      useWhen: useWhen[name],
      avoidWhen: avoidWhen[name],
      inputSchema: schemas[name]!,
      resultSchema: { type: 'object', additionalProperties: true },
      worksWith: [],
      executionMode: 'write_exclusive',
    }));
  }

  isControlTool(name: string): name is ControlToolName {
    return Object.hasOwn(schemas, name);
  }

  validate(call: ToolCallRequest, phase: AgentPhase): ControlToolResult {
    if (!this.isControlTool(call.name) || !phaseNames[phase].includes(call.name)) {
      return invalid('CONTROL_TOOL_NOT_ALLOWED', '当前运行阶段不允许该控制工具。');
    }
    const validator = this.validators.get(call.name)!;
    if (!validator(call.input) || !isRecord(call.input)) {
      return invalid('INVALID_CONTROL_INPUT', '控制工具参数不符合当前协议。');
    }
    return { ok: true, name: call.name, input: call.input };
  }
}

export interface SubmittedPlanInput {
  readonly goal: string;
  readonly successCriteria: readonly string[];
  readonly steps: readonly {
    readonly id: string;
    readonly description: string;
    readonly dependencies: readonly string[];
    readonly successCriteria: readonly string[];
  }[];
}

export function planFromSubmission(input: SubmittedPlanInput, planId: string, version: number): Plan {
  return {
    planId, version, ...(version === 1 ? {} : { supersedesVersion: version - 1 }), goal: input.goal,
    successCriteria: input.successCriteria,
    steps: input.steps.map((step) => ({ ...step, status: 'pending' as const, evidence: [] })),
  };
}

function invalid(code: string, message: string): ControlToolResult {
  return { ok: false, error: { code, message, retryable: false } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
