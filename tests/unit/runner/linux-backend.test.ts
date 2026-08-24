import { describe, expect, it } from 'vitest';
import {
  LinuxNamespaceBackend,
  REQUIRED_SANDBOX_PROBES,
  createLinuxSandboxUnavailableError,
  linuxReadToolDefinitions,
  type NamespaceExecution,
  type NamespaceTransport,
} from '../../../src/runner/index.js';

describe('Linux namespace backend certification', () => {
  it('publishes read capability only after Linux and WSL2 probes pass', async () => {
    const backend = await LinuxNamespaceBackend.create({
      workspaceRoot: 'C:\\workspace',
      transport: new FakeTransport(passedProbeOutput()),
      transactionRecovery: async () => true,
      commit: 'commit-1',
    });

    expect(backend.report.capabilities).toEqual(['FilesystemRead', 'FilesystemWrite', 'ProcessSpawn']);
    expect(backend.report.evidence).toHaveLength(REQUIRED_SANDBOX_PROBES.length + 8);
    expect(backend.report.evidence.every((item) => item.status === 'passed')).toBe(true);
    expect(backend.report.evidence.every((item) => item.commit === 'commit-1')).toBe(true);
    expect(backend.report.backendVersion).toBe('linux-userns-v2');
    expect(backend.report.evidence.find((item) => item.probeId === 'namespace_bootstrap')).toMatchObject({
      status: 'passed', probeVersion: '2', backendVersion: 'linux-userns-v2',
    });
  });

  it.each([
    { name: 'non-zero bootstrap', execution: execution(passedProbeOutput(), 1) },
    { name: 'incomplete probe output', execution: execution('process_identity=passed\n') },
  ])('fails closed without running cleanup for $name', async ({ execution }) => {
    const transport = new FakeTransport(execution);
    const backend = await LinuxNamespaceBackend.create({
      workspaceRoot: 'C:\\workspace', transport, transactionRecovery: async () => true,
    });

    expect(transport.cleanupProbeCalls).toBe(0);
    expect(backend.report.capabilities).toEqual([]);
    expect(backend.report.evidence.find((item) => item.probeId === 'namespace_bootstrap')?.status).toBe('failed');
    expect(createLinuxSandboxUnavailableError(backend.report).message).toBe('SANDBOX_UNAVAILABLE: namespace_bootstrap');
    await expect(backend.openTask({ taskId: 'task', sandboxId: 'sandbox', budget: budget() }))
      .rejects.toThrow('SANDBOX_UNCERTIFIED: namespace_bootstrap');
  });

  it('fails closed when a required or WSL2 escape probe is missing', async () => {
    const requiredMissing = await LinuxNamespaceBackend.create({
      workspaceRoot: 'C:\\workspace',
      transport: new FakeTransport(passedProbeOutput().replace('raw_network_blocked=passed\n', '')),
      transactionRecovery: async () => true,
    });
    const wslMissing = await LinuxNamespaceBackend.create({
      workspaceRoot: 'C:\\workspace',
      transport: new FakeTransport(passedProbeOutput().replace('wsl_interop_hidden=passed\n', '')),
      transactionRecovery: async () => true,
    });

    expect(requiredMissing.report.capabilities).toEqual([]);
    expect(wslMissing.report.capabilities).toEqual([]);
    await expect(requiredMissing.openTask({ taskId: 'task', sandboxId: 'sandbox', budget: budget() }))
      .rejects.toThrow('SANDBOX_UNCERTIFIED');
  });

  it('treats the host-observed long-lived child cleanup result as authoritative', async () => {
    const transport = new FakeTransport(execution(passedProbeOutput()), false);
    const backend = await LinuxNamespaceBackend.create({
      workspaceRoot: 'C:\\workspace', transport, transactionRecovery: async () => true,
    });
    expect(transport.cleanupProbeCalls).toBe(1);
    expect(backend.report.evidence.find((item) => item.probeId === 'process_tree_cleanup')?.status).toBe('failed');
    expect(backend.report.capabilities).toEqual([]);
  });

  it('removes only write capability when startup recovery has a conflict', async () => {
    const backend = await LinuxNamespaceBackend.create({
      workspaceRoot: 'C:\\workspace',
      transport: new FakeTransport(passedProbeOutput()),
      transactionRecovery: async () => false,
    });
    expect(backend.report.capabilities).toEqual(['FilesystemRead']);
  });

  it('exposes only the certified read tool surface', () => {
    expect(linuxReadToolDefinitions().map((tool) => tool.name)).toEqual(['read_file', 'glob', 'grep', 'create_file', 'edit_file', 'bash']);
  });
});

class FakeTransport implements NamespaceTransport {
  readonly platform = 'wsl2' as const;
  readonly osDescription = '6.6.0-microsoft-standard-WSL2';
  cleanupProbeCalls = 0;
  private readonly execution: NamespaceExecution;
  constructor(executionOrOutput: NamespaceExecution | string, private readonly cleanup = true) {
    this.execution = typeof executionOrOutput === 'string' ? execution(executionOrOutput) : executionOrOutput;
  }
  async toSandboxPath(): Promise<string> { return '/mnt/c/workspace'; }
  async run(): Promise<NamespaceExecution> {
    return this.execution;
  }
  async verifyProcessTreeCleanup(): Promise<boolean> {
    this.cleanupProbeCalls += 1;
    return this.cleanup;
  }
}

function execution(stdout: string, exitCode = 0): NamespaceExecution {
  return { stdout: Buffer.from(stdout), stderr: Buffer.from('sensitive host diagnostic'), exitCode };
}

function passedProbeOutput(): string {
  return [
    ...REQUIRED_SANDBOX_PROBES,
    'wsl_windows_mount_hidden',
    'wsl_interop_hidden',
    'wsl_windows_path_hidden',
    'write_worker_runtime',
    'atomic_replace',
    'bash_runtime',
    'timeout_runtime',
  ].map((probe) => `${probe}=passed\n`).join('');
}

function budget() {
  return {
    cpuCores: 1, memoryBytes: 1024, pids: 1, actionTimeoutMs: 1,
    taskProcessTimeoutMs: 1, diskBytes: 1, stdoutBytes: 1, stderrBytes: 1,
    batchOutputBytes: 1, networkBytes: 1,
  };
}
