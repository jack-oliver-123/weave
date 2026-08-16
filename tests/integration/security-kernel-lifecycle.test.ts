import { describe, expect, it } from 'vitest';
import {
  ActionGatewayImpl,
  type OpenActionTaskInput,
  type TaskLifecycleParticipant,
  type TaskLifecycleResource,
} from '../../src/security/index.js';
import { createSecurityHarness, noToolsTask } from '../fixtures/security-harness.js';

describe('security kernel lifecycle integration', () => {
  it('rolls back partial task resources and permits a clean retry after initialization fails', async () => {
    const harness = createSecurityHarness();
    const runner = new FailOnceParticipant(harness.runner);
    const gateway = new ActionGatewayImpl({
      provider: harness.provider,
      runner,
      audit: harness.audit,
      createId: harness.ids.next,
      now: harness.clock.now,
    });

    await expect(gateway.openTask(noToolsTask('task-1'))).rejects.toThrow('runner unavailable');
    expect(harness.provider.resources[0]).toMatchObject({ closeCount: 1, closeReason: 'failed' });
    expect(harness.audit.resources[0]).toMatchObject({ closeCount: 1, closeReason: 'failed' });

    const task = await gateway.openTask(noToolsTask('task-1'));
    expect(task.capabilities().tools).toEqual([]);
    await task.close('completed');
    expect(harness.provider.resources[1]).toMatchObject({ closeCount: 1, closeReason: 'completed' });
    expect(harness.runner.resources[0]).toMatchObject({ closeCount: 1, closeReason: 'completed' });
    expect(harness.audit.resources[1]).toMatchObject({ closeCount: 1, closeReason: 'completed' });
  });
});

class FailOnceParticipant implements TaskLifecycleParticipant {
  private failed = false;

  constructor(private readonly delegate: TaskLifecycleParticipant) {}

  async openTask(input: OpenActionTaskInput): Promise<TaskLifecycleResource> {
    if (!this.failed) {
      this.failed = true;
      throw new Error('runner unavailable');
    }
    return this.delegate.openTask(input);
  }
}
