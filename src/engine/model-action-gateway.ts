import { randomUUID } from 'node:crypto';
import type {
  LlmClient,
  LlmStreamEvent,
  ModelExchangeInput,
  ModelExchangeResponse,
  SafeError,
} from '../shared/types.js';
import {
  type ActionRunnerTaskResource,
  type ActionRunnerParticipant,
  ActionGatewayImpl,
  FinalInputGuard,
  type ActionGateway,
  type ModelExchangeAuthorization,
  type ModelProviderTaskResource,
  type OpenActionTaskInput,
  type TaskLifecycleParticipant,
  type TaskLifecycleResource,
  type SecurityAuditRecord,
  type SecurityAuditParticipant,
} from '../security/index.js';
import { bindAuthorizedSensitiveInput } from './llm/final-input-guard.js';
import { assemblePrompt, buildPromptCompletionAudit } from './prompt-assembly.js';

export interface ModelActionGatewayOptions {
  readonly createId?: () => string;
  readonly now?: () => number;
  readonly audit?: SecurityAuditParticipant;
  readonly runner?: ActionRunnerParticipant;
}

export function createModelActionGateway(
  client: LlmClient,
  options: ModelActionGatewayOptions = {},
): ActionGateway {
  const noOp = new NoOpTaskParticipant();
  return new ActionGatewayImpl({
    provider: new LlmModelProvider(client),
    runner: options.runner ?? new NoToolsActionRunner(),
    audit: options.audit ?? noOp,
    createId: options.createId ?? randomUUID,
    now: options.now ?? Date.now,
  });
}

class LlmModelProvider {
  constructor(private readonly client: LlmClient) {}

  async openTask(input: OpenActionTaskInput): Promise<ModelProviderTaskResource> {
    const fixed = input.modelDestination;
    if (
      this.client.profile.name !== fixed.profile
      || this.client.profile.protocol !== fixed.protocol
      || this.client.profile.model !== fixed.model
    ) {
      throw new Error('MODEL_DESTINATION_MISMATCH: Provider 与 Task 固定目标不匹配');
    }
    return new LlmModelResource(this.client, input.taskId, {
      profile: fixed.profile,
      protocol: fixed.protocol,
      model: fixed.model,
      origin: fixed.origin,
    });
  }
}

class LlmModelResource implements ModelProviderTaskResource {
  private closed = false;
  private readonly finalInputGuard = new FinalInputGuard();

  constructor(private readonly client: LlmClient, private readonly taskId: string, private readonly fixedDestination: ModelExchangeInput['destination']) {}

  async exchange(
    input: ModelExchangeInput,
    signal: AbortSignal,
    authorization?: ModelExchangeAuthorization,
  ): Promise<ModelExchangeResponse> {
    if (this.closed) throw new Error(`MODEL_EXCHANGE_CLOSED: ${this.taskId}`);
    if (
      input.destination.profile !== this.client.profile.name
      || input.destination.protocol !== this.client.profile.protocol
      || input.destination.model !== this.client.profile.model
    ) {
      throw new Error('MODEL_DESTINATION_MISMATCH: 模型交换目标发生变化');
    }
    if (
      authorization !== undefined
      && (authorization.taskId !== this.taskId || !sameModelDestination(authorization.destination, input.destination))
    ) {
      throw new Error('MODEL_DISCLOSURE_AUTHORIZATION_INVALID: Sensitive disclosure proof does not match this exchange');
    }
    const authorizedSensitiveValues = authorization?.sensitiveValues ?? [];
    const prompt = assemblePrompt({
      runtime: input.runtime,
      ...(input.environment === undefined ? {} : { environment: input.environment }),
      tools: input.tools,
      messages: input.messages,
    });
    this.finalInputGuard.assertAllowed({
      expectedDestination: this.fixedDestination,
      actualDestination: input.destination,
      headers: {},
      body: new TextEncoder().encode(JSON.stringify({ system: prompt.system, tools: prompt.tools, messages: prompt.messages })),
      authorizedSensitiveValues,
    });
    let text = '';
    let calls: ModelExchangeResponse['calls'] = [];
    let completion: Extract<LlmStreamEvent, { type: 'stream_complete' }> | undefined;
    const request = bindAuthorizedSensitiveInput({ prompt, maxTokens: input.maxTokens, signal }, authorizedSensitiveValues);
    for await (const event of this.client.stream(request)) {
      if (event.type === 'text_delta') text += event.delta;
      else if (event.type === 'tool_calls') {
        if (calls.length > 0) throw new Error('模型重复提交工具调用集合。');
        calls = event.calls;
      } else if (event.type === 'stream_error') {
        throw new ModelExchangeError(event.error);
      } else if (event.type === 'stream_complete') {
        completion = event;
      }
    }
    if (completion === undefined) throw new Error('模型响应未正常结束。');
    return {
      text,
      calls,
      completion,
      audit: buildPromptCompletionAudit(prompt.audit, this.client.profile, completion.usage),
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function sameModelDestination(
  left: ModelExchangeInput['destination'],
  right: ModelExchangeInput['destination'],
): boolean {
  return left.profile === right.profile
    && left.protocol === right.protocol
    && left.model === right.model
    && normalizeOrigin(left.origin) === normalizeOrigin(right.origin);
}

function normalizeOrigin(value: string): string {
  try { return new URL(value).origin; } catch { return ''; }
}

class NoOpTaskParticipant implements TaskLifecycleParticipant {
  async openTask(): Promise<TaskLifecycleResource & { append(records: readonly SecurityAuditRecord[]): Promise<void> }> {
    return { append: async () => undefined, close: async () => undefined };
  }
}

class NoToolsActionRunner {
  async openTask(): Promise<ActionRunnerTaskResource> {
    return {
      definitions: () => [],
      execute: async (calls, _signal, previousCalls) => ({
        results: calls.map((call) => ({
          callId: call.callId,
          providerCallId: call.providerCallId,
          toolName: call.name,
          isError: true,
          content: {
            summary: '当前 Task 没有可用的 Runner。',
            error: { code: 'SANDBOX_UNAVAILABLE', message: '当前 Task 没有可用的 Runner。', retryable: false },
          },
        })),
        totalCalls: previousCalls ?? 0,
        businessToolLimitReached: false,
      }),
      close: async () => undefined,
    };
  }
}

class ModelExchangeError extends Error {
  constructor(readonly safeError: SafeError) {
    super(safeError.message);
    this.name = 'ModelExchangeError';
  }
}
