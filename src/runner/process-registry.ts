export interface ManagedProcessTree {
  readonly processId: string;
  killTree(reason: string): Promise<void>;
}

export class TaskProcessRegistry {
  private readonly processes = new Map<string, ManagedProcessTree>();
  private closed = false;

  register(process: ManagedProcessTree): void {
    if (this.closed) throw new Error('TASK_PROCESS_REGISTRY_CLOSED');
    if (this.processes.has(process.processId)) throw new Error('TASK_PROCESS_ALREADY_REGISTERED');
    this.processes.set(process.processId, process);
  }

  release(processId: string): void { this.processes.delete(processId); }

  async terminateAll(reason: string): Promise<void> {
    const processes = [...this.processes.values()];
    this.processes.clear();
    const outcomes = await Promise.allSettled(processes.map((process) => process.killTree(reason)));
    const errors = outcomes.filter((item): item is PromiseRejectedResult => item.status === 'rejected').map((item) => item.reason);
    if (errors.length > 0) throw new AggregateError(errors, 'Failed to terminate Task process trees');
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.terminateAll('task_closed');
  }
}
