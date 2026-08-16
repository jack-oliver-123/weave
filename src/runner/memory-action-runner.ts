import type { MemoryStore } from '../memory/authorized-memory-store.js';
import type {
  ActionRunnerParticipant,
  ActionRunnerTaskResource,
  OpenActionTaskInput,
  TaskCloseReason,
} from '../security/action-gateway.js';
import type { SecurityAuditTaskResource } from '../security/audit.js';
import { classifyText } from '../security/data-guards.js';
import type { ToolCallResult, ToolDefinition, ToolExecutionBatch, ToolExecutionHooks } from '../shared/types.js';
import { REMEMBER_TOOL } from '../tool/memory-tool.js';

export function memoryToolDefinitions(definitions: readonly ToolDefinition[]): readonly ToolDefinition[] {
  return Object.freeze([...definitions, REMEMBER_TOOL]);
}

export class MemoryActionRunnerParticipant implements ActionRunnerParticipant {
  constructor(
    private readonly delegate: ActionRunnerParticipant,
    private readonly store: MemoryStore,
    private readonly now: () => number = Date.now,
  ) {}

  async openTask(input: OpenActionTaskInput, audit?: SecurityAuditTaskResource): Promise<ActionRunnerTaskResource> {
    const delegate = await this.delegate.openTask(input, audit);
    return new MemoryActionRunnerTask(delegate, this.store, this.now);
  }
}

class MemoryActionRunnerTask implements ActionRunnerTaskResource {
  readonly securityContext;

  constructor(
    private readonly delegate: ActionRunnerTaskResource,
    private readonly store: MemoryStore,
    private readonly now: () => number,
  ) { this.securityContext = delegate.securityContext; }

  definitions(scope: 'all' | 'read_only' | 'none'): readonly ToolDefinition[] {
    if (scope === 'none') return [];
    if (scope === 'read_only') return this.delegate.definitions(scope);
    return memoryToolDefinitions(this.delegate.definitions(scope));
  }

  execute(...args: Parameters<ActionRunnerTaskResource['execute']>): ReturnType<ActionRunnerTaskResource['execute']> {
    return this.delegate.execute(...args);
  }

  async executeAuthorized(
    actions: Parameters<NonNullable<ActionRunnerTaskResource['executeAuthorized']>>[0],
    signal: AbortSignal,
    previousCalls = 0,
    hooks: ToolExecutionHooks = {},
  ): Promise<ToolExecutionBatch> {
    const results: ToolCallResult[] = [];
    for (const action of actions) {
      if (action.call.name !== 'remember') {
        if (this.delegate.executeAuthorized === undefined) throw new Error('SECURE_RUNNER_REQUIRES_CAPABILITY_TICKETS');
        const batch = await this.delegate.executeAuthorized([action], signal, previousCalls + results.length, hooks);
        results.push(...batch.results);
        continue;
      }
      hooks.onStart?.(action.call);
      action.issueTicket();
      results.push(await this.persist(action.call));
    }
    return Object.freeze({
      results: Object.freeze(results),
      totalCalls: previousCalls + results.length,
      businessToolLimitReached: previousCalls + results.length >= 100,
    });
  }

  async close(reason: TaskCloseReason): Promise<void> { await this.delegate.close(reason); }

  private async persist(
    call: Parameters<NonNullable<ActionRunnerTaskResource['executeAuthorized']>>[0][number]['call'],
  ): Promise<ToolCallResult> {
    const input = call.input as Record<string, unknown>;
    const content = typeof input.content === 'string' ? sanitizeMemory(contentLimit(input.content)) : undefined;
    const purpose = typeof input.purpose === 'string' ? input.purpose.trim() : '';
    const scope = input.scope === 'user' ? 'user' : 'project';
    if (content === undefined || purpose.length === 0) return memoryError(call, 'INVALID_MEMORY_INPUT');
    if (classifyText(content) === 'credential') return memoryError(call, 'CREDENTIAL_DATA_BLOCKED');
    await this.store.persist({ content, purpose, scope, persistedAt: this.now() });
    return {
      callId: call.callId,
      providerCallId: call.providerCallId,
      toolName: call.name,
      isError: false,
      content: { summary: `Remembered ${scope} memory for ${purpose}` },
    };
  }
}

function contentLimit(content: string): string | undefined {
  return Buffer.byteLength(content, 'utf8') <= 64 * 1024 ? content : undefined;
}

function sanitizeMemory(content: string | undefined): string | undefined {
  if (content === undefined) return undefined;
  const sanitized = content.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  return sanitized.length === 0 ? undefined : sanitized;
}

function memoryError(
  call: { readonly callId: string; readonly providerCallId: string; readonly name: string },
  code: string,
): ToolCallResult {
  return {
    callId: call.callId,
    providerCallId: call.providerCallId,
    toolName: call.name,
    isError: true,
    content: {
      summary: 'Memory was not persisted',
      error: { code, message: 'Memory was not persisted', retryable: false },
    },
  };
}
