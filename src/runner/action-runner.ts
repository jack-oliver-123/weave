import type {
  ActionRunnerParticipant,
  ActionRunnerTaskResource,
  OpenActionTaskInput,
  SecurityAuditTaskResource,
} from '../security/index.js';
import type { CapabilityPrimitive } from '../security/domain.js';
import type { ToolCallRequest, ToolCallResult, ToolDefinition, ToolExecutionBatch, ToolExecutionHooks } from '../shared/types.js';
import type { ResourceBudget } from './resources.js';
import type { AuthorizedActionRequest, SupervisorTaskInput } from './supervisor.js';

export interface SupervisorTaskControl {
  execute(request: AuthorizedActionRequest, signal: AbortSignal, onWorkerStart?: () => void): Promise<ToolCallResult>;
  close(reason: string): Promise<void>;
}

export interface RunnerSupervisorControl {
  readonly runnerId: string;
  openTask(input: SupervisorTaskInput): Promise<SupervisorTaskControl>;
}

export class SupervisorActionRunnerParticipant implements ActionRunnerParticipant {
  private readonly availableDefinitions: readonly ToolDefinition[];

  constructor(
    private readonly supervisor: RunnerSupervisorControl,
    definitions: readonly ToolDefinition[],
    private readonly budget: ResourceBudget,
    private readonly createSandboxId: () => string,
    certifiedCapabilities: readonly CapabilityPrimitive[],
  ) {
    const certified = new Set(certifiedCapabilities);
    this.availableDefinitions = Object.freeze(definitions.filter((definition) => {
      const capability = toolCapability(definition.name);
      return capability !== undefined && certified.has(capability);
    }).map((definition) => Object.freeze(structuredClone(definition))));
  }

  async openTask(input: OpenActionTaskInput, audit?: SecurityAuditTaskResource): Promise<ActionRunnerTaskResource> {
    if (input.ticketVerificationKey === undefined) throw new Error('TICKET_VERIFICATION_KEY_MISSING');
    if (audit === undefined) throw new Error('SUPERVISOR_AUDIT_RESOURCE_MISSING');
    const sandboxId = this.createSandboxId();
    const task = await this.supervisor.openTask({
      taskId: input.taskId,
      sandboxId,
      policyVersion: input.policySnapshotId,
      authorizationEpoch: input.authorizationEpoch,
      revocationVersion: 0,
      ticketPublicKey: input.ticketVerificationKey,
      budget: this.budget,
      audit,
    });
    return new SupervisorActionRunnerTaskResource(
      task,
      { runnerId: this.supervisor.runnerId, sandboxId },
      this.availableDefinitions,
    );
  }

}

class SupervisorActionRunnerTaskResource implements ActionRunnerTaskResource {
  constructor(
    private readonly task: SupervisorTaskControl,
    readonly securityContext: { readonly runnerId: string; readonly sandboxId: string },
    private readonly availableDefinitions: readonly ToolDefinition[],
  ) {}

  definitions(scope: 'all' | 'read_only' | 'none'): readonly ToolDefinition[] {
    if (scope === 'none') return [];
    const definitions = scope === 'read_only'
      ? this.availableDefinitions.filter((definition) => definition.executionMode === 'read_shared')
      : this.availableDefinitions;
    return structuredClone(definitions);
  }

  async execute(): Promise<ToolExecutionBatch> {
    throw new Error('SECURE_RUNNER_REQUIRES_CAPABILITY_TICKETS');
  }

  async executeAuthorized(
    actions: Parameters<NonNullable<ActionRunnerTaskResource['executeAuthorized']>>[0],
    signal: AbortSignal,
    previousCalls = 0,
    hooks: ToolExecutionHooks = {},
  ): Promise<ToolExecutionBatch> {
    const definitions = new Map(this.availableDefinitions.map((definition) => [definition.name, definition]));
    const results: ToolCallResult[] = [];
    let writeFailed = false;
    let index = 0;
    while (index < actions.length) {
      const action = actions[index]!;
      if (writeFailed) {
        results.push(actionError(action.call, 'PRIOR_WRITE_FAILED', '前序写入调用失败，本调用未执行。'));
        index += 1;
        continue;
      }
      const definition = definitions.get(action.call.name);
      if (definition === undefined) {
        results.push(actionError(action.call, 'UNKNOWN_TOOL', '请求的工具不存在。'));
        writeFailed = true;
        index += 1;
        continue;
      }
      if (definition.executionMode === 'read_shared') {
        const start = index;
        while (index < actions.length && definitions.get(actions[index]!.call.name)?.executionMode === 'read_shared') {
          index += 1;
        }
        results.push(...await runPool(actions.slice(start, index), 8, async (readAction) => this.task.execute(
          { ticket: readAction.issueTicket(), call: readAction.call },
          signal,
          () => hooks.onStart?.(readAction.call),
        )));
        continue;
      }
      const result = await this.task.execute(
        { ticket: action.issueTicket(), call: action.call }, signal, () => hooks.onStart?.(action.call),
      );
      results.push(result);
      if (result.isError) writeFailed = true;
      index += 1;
    }
    return Object.freeze({
      results: Object.freeze(results),
      totalCalls: previousCalls + results.length,
      businessToolLimitReached: previousCalls + results.length >= 100,
    });
  }

  async close(reason: string): Promise<void> { await this.task.close(reason); }
}

async function runPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const current = next++;
      if (current >= items.length) return;
      results[current] = await worker(items[current]!);
    }
  }));
  return results;
}

function actionError(call: ToolCallRequest, code: string, message: string): ToolCallResult {
  return {
    callId: call.callId,
    providerCallId: call.providerCallId,
    toolName: call.name,
    isError: true,
    content: { summary: message, error: { code, message, retryable: false } },
  };
}

function toolCapability(name: string): CapabilityPrimitive | undefined {
  if (name === 'read_file' || name === 'glob' || name === 'grep') return 'FilesystemRead';
  if (name === 'create_file' || name === 'edit_file') return 'FilesystemWrite';
  if (name === 'bash') return 'ProcessSpawn';
  return undefined;
}
