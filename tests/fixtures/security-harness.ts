import type {
  ModelProviderTaskResource,
  OpenActionTaskInput,
  TaskLifecycleParticipant,
} from '../../src/security/index.js';
import type { ModelExchangeInput, ModelExchangeResponse } from '../../src/shared/types.js';
import type { ToolDefinition, ToolDefinitionScope } from '../../src/shared/types.js';

export class DeterministicClock {
  constructor(private value: number) {}

  now = (): number => this.value;

  advance(milliseconds: number): void {
    this.value += milliseconds;
  }
}

export class DeterministicIds {
  private nextValue = 1;

  next = (): string => `test-id-${this.nextValue++}`;
}

export class FakeTaskParticipant implements TaskLifecycleParticipant {
  readonly opened: OpenActionTaskInput[] = [];
  readonly resources: FakeTaskResource[] = [];

  constructor(
    readonly name: 'provider' | 'runner' | 'audit',
    private readonly toolDefinitions: readonly ToolDefinition[] = [],
  ) {}

  async openTask(input: OpenActionTaskInput): Promise<FakeTaskResource> {
    this.opened.push(input);
    const resource = new FakeTaskResource(this.name, input.taskId, this.toolDefinitions);
    this.resources.push(resource);
    return resource;
  }
}

export class FakeTaskResource implements ModelProviderTaskResource {
  closeCount = 0;
  closeReason: string | undefined;
  readonly executionCalls: import('../../src/shared/types.js').ToolCallRequest[][] = [];
  readonly auditRecords: import('../../src/security/index.js').SecurityAuditRecord[][] = [];

  constructor(
    readonly participant: string,
    readonly taskId: string,
    private readonly toolDefinitions: readonly ToolDefinition[] = [],
  ) {}

  async close(reason: string): Promise<void> {
    this.closeCount += 1;
    this.closeReason = reason;
  }

  async exchange(input: ModelExchangeInput): Promise<ModelExchangeResponse> {
    return {
      text: '',
      calls: [],
      completion: { type: 'stream_complete', finishReason: 'stop' },
      audit: {
        promptVersion: 'fake', stableHash: 'fake', assemblyHash: 'fake', modules: [], fragments: [],
        protocol: input.destination.protocol, model: input.destination.model,
      },
    };
  }

  async append(records: readonly import('../../src/security/index.js').SecurityAuditRecord[]): Promise<void> {
    this.auditRecords.push(structuredClone(records));
  }

  definitions(_scope: ToolDefinitionScope) { return this.toolDefinitions; }

  async execute(calls: readonly import('../../src/shared/types.js').ToolCallRequest[], _signal: AbortSignal, previousCalls = 0) {
    this.executionCalls.push(structuredClone(calls));
    return { results: [], totalCalls: previousCalls, businessToolLimitReached: false };
  }
}

export function createSecurityHarness(now = 1_700_000_000_000) {
  return {
    clock: new DeterministicClock(now),
    ids: new DeterministicIds(),
    provider: new FakeTaskParticipant('provider'),
    runner: new FakeTaskParticipant('runner'),
    audit: new FakeTaskParticipant('audit'),
  };
}

export function noToolsTask(taskId: string): OpenActionTaskInput {
  return {
    schemaVersion: 1,
    taskId,
    policySnapshotId: 'policy-1',
    permissionMode: 'read_only',
    modelDestination: {
      profile: 'fake',
      protocol: 'anthropic-messages',
      model: 'fake-model',
      origin: 'https://provider.invalid',
      credentialRef: 'credential:test',
    },
    pathBoundary: { readRoots: ['.'], writeRoots: [] },
    authorizationEpoch: 1,
    toolsEnabled: false,
  };
}
