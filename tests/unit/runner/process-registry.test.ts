import { describe, expect, it, vi } from 'vitest';
import { TaskProcessRegistry } from '../../../src/runner/index.js';

describe('Task process registry', () => {
  it('kills every registered process tree when the Task closes', async () => {
    const first = vi.fn(async () => undefined);
    const second = vi.fn(async () => undefined);
    const registry = new TaskProcessRegistry();
    registry.register({ processId: 'p1', killTree: first });
    registry.register({ processId: 'p2', killTree: second });
    await registry.close();
    expect(first).toHaveBeenCalledWith('task_closed');
    expect(second).toHaveBeenCalledWith('task_closed');
    expect(() => registry.register({ processId: 'p3', killTree: async () => undefined })).toThrow('REGISTRY_CLOSED');
  });

  it('does not kill an explicitly released action process twice', async () => {
    const kill = vi.fn(async () => undefined);
    const registry = new TaskProcessRegistry();
    registry.register({ processId: 'p1', killTree: kill });
    registry.release('p1');
    await registry.close();
    expect(kill).not.toHaveBeenCalled();
  });
});
