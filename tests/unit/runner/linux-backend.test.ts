import { describe, expect, it } from 'vitest';
import {
  LinuxNamespaceBackend,
  REQUIRED_SANDBOX_PROBES,
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
    expect(backend.report.evidence).toHaveLength(REQUIRED_SANDBOX_PROBES.length + 7);
    expect(backend.report.evidence.every((item) => item.status === 'passed')).toBe(true);
    expect(backend.report.evidence.every((item) => item.commit === 'commit-1')).toBe(true);
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
    const transport = new FakeTransport(passedProbeOutput(), false);
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
  constructor(private readonly output: string, private readonly cleanup = true) {}
  async toSandboxPath(): Promise<string> { return '/mnt/c/workspace'; }
  async run(): Promise<NamespaceExecution> {
    return { stdout: Buffer.from(this.output), stderr: Buffer.alloc(0), exitCode: 0 };
  }
  async verifyProcessTreeCleanup(): Promise<boolean> {
    this.cleanupProbeCalls += 1;
    return this.cleanup;
  }
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
