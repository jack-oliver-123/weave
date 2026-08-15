import { describe, expect, it } from 'vitest';
import { ActionGatewayImpl, ActionTaskClosedError } from '../../../src/security/index.js';
import type { ToolDefinition } from '../../../src/shared/types.js';
import { createSecurityHarness, FakeTaskParticipant, noToolsTask } from '../../fixtures/security-harness.js';

const readTool: ToolDefinition = {
  name: 'read_file', purpose: 'read', useWhen: ['read'], avoidWhen: ['write'],
  inputSchema: {}, resultSchema: {}, worksWith: [], executionMode: 'read_shared',
};
const writeTool: ToolDefinition = {
  name: 'edit_file', purpose: 'write', useWhen: ['write'], avoidWhen: ['read'],
  inputSchema: {}, resultSchema: {}, worksWith: [], executionMode: 'write_exclusive',
};

describe('ActionGateway task lifecycle', () => {
  it('keeps no-tools task resources isolated and makes them unusable after close', async () => {
    const harness = createSecurityHarness();
    const gateway = new ActionGatewayImpl({
      provider: harness.provider,
      runner: harness.runner,
      audit: harness.audit,
      createId: harness.ids.next,
      now: harness.clock.now,
    });

    const first = await gateway.openTask(noToolsTask('task-1'));
    const second = await gateway.openTask(noToolsTask('task-2'));

    expect(first.sessionId).toBe('test-id-1');
    expect(second.sessionId).toBe('test-id-2');
    expect(first.capabilities()).toEqual({ tools: [], openedAt: 1_700_000_000_000 });
    expect(harness.runner.resources[0]).not.toBe(harness.runner.resources[1]);
    expect(harness.provider.opened[0]).not.toBe(harness.provider.opened[1]);

    await first.close('completed');
    await first.close('completed');

    expect(harness.provider.resources[0]?.closeCount).toBe(1);
    expect(harness.runner.resources[0]?.closeCount).toBe(1);
    expect(harness.audit.resources[0]?.closeCount).toBe(1);
    expect(harness.runner.resources[1]?.closeCount).toBe(0);
    expect(() => first.capabilities()).toThrow(ActionTaskClosedError);
    expect(second.capabilities().tools).toEqual([]);
  });

  it('rejects tool-enabled tasks until a certified capability slice exists', async () => {
    const harness = createSecurityHarness();
    const gateway = new ActionGatewayImpl({
      provider: harness.provider,
      runner: harness.runner,
      audit: harness.audit,
      createId: harness.ids.next,
      now: harness.clock.now,
    });

    await expect(gateway.openTask({ ...noToolsTask('task-1'), toolsEnabled: true }))
      .rejects.toThrow('SANDBOX_UNAVAILABLE');
    expect(harness.provider.resources[0]?.closeCount).toBe(1);
    expect(harness.runner.resources[0]?.closeCount).toBe(1);
    expect(harness.audit.resources[0]).toMatchObject({ closeCount: 1, closeReason: 'failed' });
  });

  it('intersects agent scope, permission mode, and runner capability definitions', async () => {
    const harness = createSecurityHarness();
    const gateway = new ActionGatewayImpl({
      provider: harness.provider,
      runner: new FakeTaskParticipant('runner', [readTool, writeTool]),
      audit: harness.audit,
      createId: harness.ids.next,
      now: harness.clock.now,
    });

    const readOnly = await gateway.openTask({ ...noToolsTask('read-only'), toolsEnabled: true });
    expect(readOnly.capabilities().tools).toEqual(['read_file', 'edit_file']);
    expect(readOnly.definitions('all').map((tool) => tool.name)).toEqual(['read_file']);
    expect(readOnly.definitions('none')).toEqual([]);
    await readOnly.close('completed');

    const supervised = await gateway.openTask({
      ...noToolsTask('supervised'),
      permissionMode: 'supervised',
      toolsEnabled: true,
    });
    expect(supervised.definitions('read_only').map((tool) => tool.name)).toEqual(['read_file']);
    expect(supervised.definitions('all').map((tool) => tool.name)).toEqual(['read_file', 'edit_file']);
  });
});
