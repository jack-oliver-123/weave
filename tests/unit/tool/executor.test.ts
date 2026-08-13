import { describe, expect, it } from 'vitest';
import { SchedulerToolExecutor } from '../../../src/tool/executor.js';
import { ToolCallScheduler } from '../../../src/tool/scheduler.js';
import type { ToolCallRequest, ToolCallResult, ToolDefinition } from '../../../src/shared/types.js';

const schema = { type: 'object', additionalProperties: false } as const;
const definition = (name: string, executionMode: 'read_shared' | 'write_exclusive'): ToolDefinition => ({
  name, purpose: name, useWhen: ['x'], avoidWhen: ['y'], inputSchema: schema, resultSchema: schema, worksWith: [], executionMode,
});
const definitions = [definition('read_file', 'read_shared'), definition('glob', 'read_shared'), definition('grep', 'read_shared'), definition('edit_file', 'write_exclusive'), definition('bash', 'write_exclusive')];
const call = (name: string): ToolCallRequest => ({ callId: name, providerCallId: `p-${name}`, name, input: {} });
const success = (request: ToolCallRequest): ToolCallResult => ({
  callId: request.callId, providerCallId: request.providerCallId, toolName: request.name, isError: false, content: { summary: 'ok', data: {} },
});

describe('SchedulerToolExecutor', () => {
  it('filters read-only definitions without changing the registry', () => {
    const executor = createExecutor();
    expect(executor.definitions('read_only').map((item) => item.name)).toEqual(['read_file', 'glob', 'grep']);
    expect(executor.definitions('all')).toHaveLength(5);
    expect(executor.definitions('none')).toEqual([]);
  });

  it('returns ordered results and forwards shared cancellation and hooks', async () => {
    const starts: string[] = [];
    const executor = createExecutor();
    const output = await executor.execute([call('read_file'), call('glob')], new AbortController().signal, 0, { onStart: (item) => starts.push(item.name) });
    expect(starts).toEqual(['read_file', 'glob']);
    expect(output.results.map((item) => item.toolName)).toEqual(['read_file', 'glob']);
    expect(output.businessToolLimitReached).toBe(false);
  });
});

function createExecutor() {
  const scheduler = new ToolCallScheduler({ definitions, dispatch: async (request) => success(request) });
  return new SchedulerToolExecutor(definitions, scheduler);
}
