import type {
  ChatMessage,
  LlmClient,
  LlmRequest,
  LlmStreamEvent,
  ProfileSummary,
  SafeError,
  ToolExecutor,
} from '../../src/shared/types.js';
import type { ActionTask } from '../../src/security/index.js';
import { createModelActionGateway } from '../../src/engine/model-action-gateway.js';
import { createTestActionGateway } from './test-action-gateway.js';

export interface FakeStreamStep {
  readonly event?: LlmStreamEvent;
  readonly delayMs?: number;
  readonly error?: SafeError;
}

export class FakeLlmClient implements LlmClient {
  readonly requests: LlmRequest[] = [];

  constructor(
    readonly profile: ProfileSummary,
    private readonly scripts: readonly (readonly FakeStreamStep[])[],
  ) {}

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
    this.requests.push(request);
    const script = this.scripts[this.requests.length - 1] ?? [];

    for (const step of script) {
      if (step.delayMs !== undefined) {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(resolve, step.delayMs);
          request.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timeout);
              reject(request.signal.reason);
            },
            { once: true },
          );
        });
      }
      if (request.signal.aborted) {
        return;
      }
      if (step.error !== undefined) {
        yield { type: 'stream_error', error: step.error };
        return;
      }
      if (step.event !== undefined) {
        yield step.event;
      }
    }
  }
}

export const fakeProfile: ProfileSummary = {
  name: 'fake',
  protocol: 'anthropic-messages',
  model: 'fake-model',
};

export async function openFakeActionTask(
  client: LlmClient,
  options: {
    readonly taskId?: string;
    readonly messages?: readonly ChatMessage[];
    readonly maxTokens?: number;
    readonly toolExecutor?: ToolExecutor;
  } = {},
): Promise<ActionTask> {
  let nextId = 1;
  const gatewayOptions = { createId: () => `fake-gateway-${nextId++}`, now: () => 0 };
  const gateway = options.toolExecutor === undefined
    ? createModelActionGateway(client, gatewayOptions)
    : createTestActionGateway(client, options.toolExecutor, gatewayOptions);
  const toolsEnabled = options.toolExecutor !== undefined
    && options.toolExecutor.definitions('all').length > 0;
  return gateway.openTask({
    schemaVersion: 1,
    taskId: options.taskId ?? 'task-1',
    policySnapshotId: 'fake-policy',
    permissionMode: toolsEnabled ? 'autonomous' : 'read_only',
    modelDestination: {
      profile: client.profile.name,
      protocol: client.profile.protocol,
      model: client.profile.model,
      origin: 'https://provider.invalid',
      credentialRef: 'credential:fake',
    },
    pathBoundary: { readRoots: ['.'], writeRoots: toolsEnabled ? ['.'] : [] },
    authorizationEpoch: 1,
    toolsEnabled,
    modelContext: {
      messages: options.messages ?? [{ role: 'user', content: '任务' }],
      maxTokens: options.maxTokens ?? 100,
    },
  });
}
