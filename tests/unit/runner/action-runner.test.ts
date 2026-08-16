import { describe, expect, it, vi } from 'vitest';
import {
  defaultResourceBudget,
  SupervisorActionRunnerParticipant,
  type RunnerSupervisorControl,
} from '../../../src/runner/index.js';
import type { ToolCallRequest, ToolDefinition } from '../../../src/shared/types.js';

const writeTool: ToolDefinition = {
  name: 'edit_file', purpose: 'write', useWhen: ['write'], avoidWhen: ['read'],
  inputSchema: {}, resultSchema: {}, worksWith: [], executionMode: 'write_exclusive',
};
const readTool: ToolDefinition = {
  name: 'read_file', purpose: 'read', useWhen: ['read'], avoidWhen: ['write'],
  inputSchema: {}, resultSchema: {}, worksWith: [], executionMode: 'read_shared',
};

describe('Supervisor action runner scheduling', () => {
  it('does not issue tickets or start actions after a write failure', async () => {
    const execute = vi.fn(async ({ call }: { call: ToolCallRequest }) => ({
      callId: call.callId,
      providerCallId: call.providerCallId,
      toolName: call.name,
      isError: true,
      content: { summary: 'write failed', error: { code: 'WRITE_FAILED', message: 'write failed', retryable: false } },
    }));
    const control: RunnerSupervisorControl = {
      runnerId: 'runner-1',
      openTask: async () => ({ execute, close: async () => undefined }),
    };
    const participant = new SupervisorActionRunnerParticipant(
      control,
      [writeTool],
      defaultResourceBudget({ cpuCores: 8, memoryBytes: 16 * 1024 ** 3 }),
      () => 'sandbox-1',
      ['FilesystemWrite'],
    );
    const task = await participant.openTask({
      schemaVersion: 1,
      taskId: 'task-1',
      policySnapshotId: 'policy-1',
      permissionMode: 'autonomous',
      modelDestination: {
        profile: 'test', protocol: 'anthropic-messages', model: 'test',
        origin: 'https://example.invalid', credentialRef: 'credential:test',
      },
      pathBoundary: { readRoots: ['.'], writeRoots: ['.'] },
      ticketVerificationKey: 'key',
      authorizationEpoch: 1,
      toolsEnabled: true,
    }, { append: async () => undefined, close: async () => undefined });
    const issueFirst = vi.fn(() => ({}) as never);
    const issueSecond = vi.fn(() => ({}) as never);
    const result = await task.executeAuthorized!([
      { call: editCall('call-1'), issueTicket: issueFirst },
      { call: editCall('call-2'), issueTicket: issueSecond },
    ], new AbortController().signal);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(issueFirst).toHaveBeenCalledTimes(1);
    expect(issueSecond).not.toHaveBeenCalled();
    expect(result.results[1]).toMatchObject({ isError: true, content: { error: { code: 'PRIOR_WRITE_FAILED' } } });
  });

  it('runs consecutive reads with a fixed concurrency of eight and preserves result order', async () => {
    let active = 0;
    let peak = 0;
    const execute = vi.fn(async ({ call }: { call: ToolCallRequest }) => {
      active += 1;
      peak = Math.max(peak, active);
      const index = Number(call.callId.slice('call-'.length));
      await new Promise((resolve) => setTimeout(resolve, 20 - index));
      active -= 1;
      return {
        callId: call.callId,
        providerCallId: call.providerCallId,
        toolName: call.name,
        isError: false,
        content: { summary: `read ${index}` },
      };
    });
    const control: RunnerSupervisorControl = {
      runnerId: 'runner-1',
      openTask: async () => ({ execute, close: async () => undefined }),
    };
    const participant = new SupervisorActionRunnerParticipant(
      control,
      [readTool],
      defaultResourceBudget({ cpuCores: 8, memoryBytes: 16 * 1024 ** 3 }),
      () => 'sandbox-1',
      ['FilesystemRead'],
    );
    const task = await participant.openTask(taskInput(), { append: async () => undefined, close: async () => undefined });
    const actions = Array.from({ length: 10 }, (_, index) => ({
      call: readCall(index),
      issueTicket: () => ({}) as never,
    }));
    const result = await task.executeAuthorized!(actions, new AbortController().signal);

    expect(peak).toBe(8);
    expect(result.results.map((item) => item.callId)).toEqual(actions.map((item) => item.call.callId));
  });
});

function editCall(callId: string): ToolCallRequest {
  return { callId, providerCallId: `provider-${callId}`, name: 'edit_file', input: { path: `${callId}.txt`, edits: [] } };
}

function readCall(index: number): ToolCallRequest {
  return { callId: `call-${index}`, providerCallId: `provider-${index}`, name: 'read_file', input: { path: `${index}.txt` } };
}

function taskInput() {
  return {
    schemaVersion: 1 as const,
    taskId: 'task-1',
    policySnapshotId: 'policy-1',
    permissionMode: 'autonomous' as const,
    modelDestination: {
      profile: 'test', protocol: 'anthropic-messages' as const, model: 'test',
      origin: 'https://example.invalid', credentialRef: 'credential:test',
    },
    pathBoundary: { readRoots: ['.'], writeRoots: ['.'] },
    ticketVerificationKey: 'key',
    authorizationEpoch: 1,
    toolsEnabled: true,
  };
}
