import type {
  ToolCallRequest,
  ToolDefinition,
  ToolDefinitionScope,
  ToolExecutionBatch,
  ToolExecutionHooks,
  ToolExecutor,
} from '../shared/types.js';
import { ToolCallScheduler } from './scheduler.js';

const READ_ONLY_NAMES = new Set(['read_file', 'glob', 'grep']);

export class SchedulerToolExecutor implements ToolExecutor {
  constructor(
    private readonly allDefinitions: readonly ToolDefinition[],
    private readonly scheduler: ToolCallScheduler,
  ) {}

  definitions(scope: ToolDefinitionScope): readonly ToolDefinition[] {
    if (scope === 'none') return [];
    if (scope === 'read_only') return this.allDefinitions.filter((definition) => READ_ONLY_NAMES.has(definition.name));
    return this.allDefinitions;
  }

  async execute(
    calls: readonly ToolCallRequest[],
    signal: AbortSignal,
    previousCalls = 0,
    hooks: ToolExecutionHooks = {},
  ): Promise<ToolExecutionBatch> {
    const result = await this.scheduler.execute(calls, signal, previousCalls, hooks);
    return {
      results: result.results,
      totalCalls: result.totalCalls,
      businessToolLimitReached: result.finalTextOnly,
    };
  }
}
