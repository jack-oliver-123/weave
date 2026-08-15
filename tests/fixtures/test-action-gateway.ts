import type { LlmClient, ToolExecutor } from '../../src/shared/types.js';
import {
  type ActionRunnerParticipant,
  type ActionRunnerTaskResource,
  type SecurityAuditParticipant,
} from '../../src/security/index.js';
import { createModelActionGateway } from '../../src/engine/model-action-gateway.js';

export function createTestActionGateway(
  client: LlmClient,
  executor: ToolExecutor,
  options: { readonly createId?: () => string; readonly now?: () => number; readonly audit?: SecurityAuditParticipant } = {},
) {
  return createModelActionGateway(client, {
    runner: new TestActionRunner(executor),
    ...(options.createId === undefined ? {} : { createId: options.createId }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.audit === undefined ? {} : { audit: options.audit }),
  });
}

class TestActionRunner implements ActionRunnerParticipant {
  constructor(private readonly executor: ToolExecutor) {}
  async openTask(): Promise<ActionRunnerTaskResource> {
    return {
      definitions: (scope) => this.executor.definitions(scope),
      execute: (calls, signal, previousCalls, hooks) => this.executor.execute(calls, signal, previousCalls, hooks),
      close: async () => undefined,
    };
  }
}
