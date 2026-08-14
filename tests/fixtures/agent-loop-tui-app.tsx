import { ConversationManager } from '../../src/engine/conversation-manager.js';
import { runTui } from '../../src/interaction/weave-tui.js';
import { InMemoryConversationStore } from '../../src/memory/conversation-store.js';
import type {
  LlmClient,
  LlmRequest,
  LlmStreamEvent,
  ProfileSummary,
  ToolCallRequest,
  ToolDefinition,
  ToolExecutor,
} from '../../src/shared/types.js';

const profile: ProfileSummary = {
  name: 'agent-loop-terminal-smoke',
  protocol: 'openai-responses',
  model: 'deterministic-smoke',
};

const readDefinition: ToolDefinition = {
  name: 'read_file',
  purpose: '读取确定性验收数据',
  useWhen: ['需要推进停止条件验收时'],
  avoidWhen: ['无需工具即可完成时'],
  inputSchema: { type: 'object', additionalProperties: false, required: ['index'], properties: { index: { type: 'integer' } } },
  resultSchema: { type: 'object', additionalProperties: false, required: ['index'], properties: { index: { type: 'integer' } } },
  worksWith: [],
  executionMode: 'read_shared',
};

class SmokeToolExecutor implements ToolExecutor {
  definitions(scope: import('../../src/shared/types.js').ToolDefinitionScope): readonly ToolDefinition[] {
    return scope === 'none' ? [] : [readDefinition];
  }

  async execute(calls: readonly ToolCallRequest[], _signal: AbortSignal, previousCalls = 0): Promise<import('../../src/shared/types.js').ToolExecutionBatch> {
    return {
      results: calls.map((call) => ({
        callId: call.callId,
        providerCallId: call.providerCallId,
        toolName: call.name,
        isError: false,
        content: { summary: `读取验收项 ${String((call.input as { index?: unknown }).index)} 完成`, data: call.input },
      })),
      totalCalls: previousCalls + calls.length,
      businessToolLimitReached: false,
    };
  }
}

class AgentLoopSmokeClient implements LlmClient {
  readonly profile = profile;
  private callIndex = 0;
  private planDrafts = 0;
  private stopIterations = 0;
  private stoppedOnce = false;
  private inputRequested = false;
  private cancelledOnce = false;

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
    yield { type: 'stream_start' };
    const names = new Set(request.prompt.tools.map((tool) => tool.name));
    const userTexts = request.prompt.messages
      .filter((message) => message.role === 'user' && typeof message.content === 'string')
      .map((message) => message.content as string);
    const lastUser = userTexts.at(-1) ?? '';

    if (names.has('submit_plan')) {
      this.planDrafts += 1;
      yield toolCall('submit_plan', {
        goal: `终端 Plan 验收 v${this.planDrafts}`,
        successCriteria: ['全部终端流程通过'],
        steps: [{ id: 's1', description: `执行确定性步骤 v${this.planDrafts}`, dependencies: [], successCriteria: ['步骤验证通过'] }],
      }, this.nextCall());
      yield complete();
      return;
    }

    if (names.has('complete_step')) {
      yield toolCall('complete_step', {
        stepId: 's1',
        criteria: [{ criterion: '步骤验证通过', passed: true, evidence: '真实终端中已执行步骤' }],
      }, this.nextCall());
      yield complete();
      return;
    }

    if (names.has('complete_task') && userTexts.includes('need-input') && !this.inputRequested) {
      this.inputRequested = true;
      yield toolCall('request_user_input', { prompt: '请输入验收答案' }, this.nextCall());
      yield complete();
      return;
    }

    if (names.has('complete_task') && userTexts.includes('stop-me') && !this.stoppedOnce) {
      this.stopIterations += 1;
      if (this.stopIterations >= 10) this.stoppedOnce = true;
      yield toolCall('read_file', { index: this.stopIterations }, this.nextCall());
      yield complete();
      return;
    }

    if (names.has('complete_task') && lastUser === 'cancel-me' && !this.cancelledOnce) {
      await waitForCancellation(request.signal);
      this.cancelledOnce = true;
      return;
    }

    yield toolCall('complete_task', {
      result: completionResult(userTexts, this.planDrafts),
      verificationSummary: '真实终端确定性验收通过',
      ...(names.has('request_plan_revision') ? {
        criteria: [{ criterion: '全部终端流程通过', passed: true, evidence: 'Plan 步骤与收尾均通过' }],
      } : {}),
    }, this.nextCall());
    yield complete();
  }

  private nextCall(): number { this.callIndex += 1; return this.callIndex; }
}

function toolCall(name: string, input: unknown, index: number): LlmStreamEvent {
  return { type: 'tool_calls', calls: [{ callId: `call-${index}`, providerCallId: `provider-${index}`, name, input }] };
}

function complete(): LlmStreamEvent {
  return { type: 'stream_complete', finishReason: 'stop', usage: { inputTokens: 2, outputTokens: 3 } };
}

function completionResult(userTexts: readonly string[], planDrafts: number): string {
  const activeTask = [...userTexts]
    .reverse()
    .find((text) => ['need-input', 'stop-me', 'cancel-me'].includes(text));
  if (activeTask === 'need-input') return '输入恢复通过';
  if (activeTask === 'stop-me') return '迭代停止后继续通过';
  if (activeTask === 'cancel-me') return '取消后恢复通过';
  if (planDrafts > 0) return `Plan v${planDrafts} 执行通过`;
  return 'ReAct 默认模式通过';
}

function waitForCancellation(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}

const conversation = new ConversationManager(
  new AgentLoopSmokeClient(),
  new InMemoryConversationStore(),
  { maxTokens: 256, toolExecutor: new SmokeToolExecutor() },
);

await runTui({
  conversation,
  profile,
  version: 'agent-loop-smoke',
  cwd: process.cwd(),
});
