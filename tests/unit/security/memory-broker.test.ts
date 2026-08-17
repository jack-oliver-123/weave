import { describe, expect, it, vi } from 'vitest';
import {
  AuthorizationEvaluator,
  normalizeToolCall,
  permissionModeEffect,
  type ActionRunnerParticipant,
  type OpenActionTaskInput,
} from '../../../src/security/index.js';
import { MemoryActionRunnerParticipant } from '../../../src/runner/index.js';
import { InMemoryAuthorizedMemoryStore } from '../../../src/memory/index.js';
import { REMEMBER_TOOL } from '../../../src/tool/index.js';
import type { ToolCallRequest } from '../../../src/shared/types.js';

describe('MemoryPersist broker', () => {
  it('derives a MemoryPersist manifest whose mode is deny/ask/ask', () => {
    const call = rememberCall('ordinary fact');
    const action = normalizeToolCall(call, 'action-digest');
    expect(action?.manifest.requirements[0]).toMatchObject({ type: 'MemoryPersist', purpose: 'project fact', scope: 'project' });
    const requirement = action!.manifest.requirements[0]!;
    expect(['read_only', 'supervised', 'autonomous'].map((mode) => permissionModeEffect(mode as never, requirement)))
      .toEqual(['deny', 'ask', 'ask']);
    expect(new AuthorizationEvaluator().evaluate({ action: action!, mode: 'read_only' }).effect).toBe('deny');
  });

  it('persists only after authorized execution, survives Task closure, and blocks credential content', async () => {
    const store = new InMemoryAuthorizedMemoryStore();
    const issueTicket = vi.fn(() => ({}) as never);
    const runner = new MemoryActionRunnerParticipant(fakeRunner(), store, () => 10);
    const first = await runner.openTask(taskInput('task-1'));
    expect(first.definitions('all').map((item) => item.name)).toContain(REMEMBER_TOOL.name);
    await first.executeAuthorized!([{ call: rememberCall('ordinary\u0000 fact'), issueTicket }], new AbortController().signal);
    await first.close('completed');
    const second = await runner.openTask(taskInput('task-2'));
    expect(await store.list()).toEqual([{ content: 'ordinary fact', purpose: 'project fact', scope: 'project', persistedAt: 10 }]);
    const blocked = await second.executeAuthorized!([{
      call: rememberCall('api_key=abcdefghijklmnop'), issueTicket,
    }], new AbortController().signal);
    expect(blocked.results[0]).toMatchObject({ isError: true, content: { error: { code: 'CREDENTIAL_DATA_BLOCKED' } } });
    expect(await store.list()).toHaveLength(1);
    expect(issueTicket).toHaveBeenCalledTimes(2);
  });
});

function rememberCall(content: string): ToolCallRequest {
  return { callId: `call-${content.length}`, providerCallId: 'provider-call', name: 'remember', input: { content, purpose: 'project fact', scope: 'project' } };
}

function fakeRunner(): ActionRunnerParticipant {
  return {
    async openTask() {
      return {
        securityContext: { runnerId: 'runner', sandboxId: 'sandbox' },
        definitions: () => [],
        execute: async (_calls, _signal, previousCalls = 0) => ({ results: [], totalCalls: previousCalls, businessToolLimitReached: false }),
        executeAuthorized: async (_actions, _signal, previousCalls = 0) => ({ results: [], totalCalls: previousCalls, businessToolLimitReached: false }),
        close: async () => undefined,
      };
    },
  };
}

function taskInput(taskId: string): OpenActionTaskInput {
  return {
    schemaVersion: 1, taskId, policySnapshotId: 'policy', permissionMode: 'supervised',
    modelDestination: { profile: 'test', protocol: 'anthropic-messages', model: 'test', origin: 'https://example.com', credentialRef: 'provider:test' },
    pathBoundary: { readRoots: ['.'], writeRoots: ['.'] }, authorizationEpoch: 1, toolsEnabled: true,
  };
}
