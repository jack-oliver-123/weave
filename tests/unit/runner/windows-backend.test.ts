import { describe, expect, it, vi } from 'vitest';
import {
  deriveWindowsWorkerPolicy,
  probeWindowsSandbox,
  WINDOWS_JOB_SUPERVISOR_SOURCE,
  WindowsSandboxBackend,
  WindowsSandboxTaskVm,
  windowsSandboxCliCapturesOutput,
  windowsPlatformProbeScript,
  windowsSandboxConfiguration,
  type ProbeEvidence,
  type WindowsSandboxCli,
} from '../../../src/runner/index.js';
import { REQUIRED_SANDBOX_PROBES } from '../../../src/runner/capability-report.js';

const budget = {
  cpuCores: 2, memoryBytes: 2 * 1024 ** 3, pids: 32, actionTimeoutMs: 20_000,
  taskProcessTimeoutMs: 60_000, diskBytes: 1024, stdoutBytes: 1024, stderrBytes: 1024,
  batchOutputBytes: 4096, networkBytes: 4096,
};

describe('Windows Sandbox backend', () => {
  it('does not pipe connect output into the long-lived remote session', () => {
    expect(windowsSandboxCliCapturesOutput(['connect', '--raw', '--id', 'sandbox'])).toBe(false);
    expect(windowsSandboxCliCapturesOutput(['start', '--raw', '--id', 'sandbox'])).toBe(true);
  });

  it('detects the Store package using its current MicrosoftWindows identity', () => {
    expect(windowsPlatformProbeScript()).toContain("Get-AppxPackage -Name '*WindowsSandbox*'");
    expect(windowsPlatformProbeScript()).toContain('Select-Object -First 1');
  });

  it('fails closed for unsupported Windows, missing CLI, and incomplete probes', async () => {
    const run = vi.fn(async () => ({ status: 0, stdout: '1.0.0', stderr: '' }));
    const unsupported = await WindowsSandboxBackend.create({
      facts: { platform: 'win32', productName: 'Windows 10', build: 26200, featureState: 'enabled' }, cli: { run },
    });
    expect(unsupported.report.capabilities).toEqual([]);
    expect(run).not.toHaveBeenCalled();

    const missing = await WindowsSandboxBackend.create({
      facts: { platform: 'win32', productName: 'Windows 11 Pro', build: 26100, featureState: 'enabled' },
      cli: { run: async () => { throw new Error('ENOENT'); } },
    });
    expect(missing.report.evidence.find((item) => item.probeId === 'windows_sandbox_cli')?.status).toBe('not_run');
    expect(missing.report.capabilities).toEqual([]);

    const incomplete = await WindowsSandboxBackend.create({
      facts: { platform: 'win32', productName: 'Windows 11 Pro', build: 26100, featureState: 'enabled' }, cli: { run },
      certificationEvidence: [...requiredEvidence('passed'), evidence('windows_read_tools', 'passed')],
      openCertifiedTask: async () => { throw new Error('unused'); },
    });
    expect(incomplete.report.capabilities).toEqual(['FilesystemRead']);
    const unknown = await WindowsSandboxBackend.create({
      facts: { platform: 'win32', productName: 'Windows 11 Pro', build: 26100, featureState: 'enabled' }, cli: { run },
      certificationEvidence: [...requiredEvidence('passed').map((item, index) => index === 3 ? { ...item, status: 'unknown' as const } : item), evidence('windows_read_tools', 'passed')],
      openCertifiedTask: async () => { throw new Error('unused'); },
    });
    expect(unknown.report.capabilities).toEqual([]);
  });

  it('creates a network-disabled VM with only baseline and CoW mappings', () => {
    const config = windowsSandboxConfiguration({
      taskId: 'task', sandboxId: 'sandbox', budget,
      baselinePath: 'C:\\Repo & Base', cowPath: 'C:\\Task Cow',
    });
    expect(config).toContain('<Networking>Disable</Networking>');
    expect(config).toContain('<ProtectedClient>Enable</ProtectedClient>');
    expect(config).toContain('C:\\Repo &amp; Base');
    expect(config).toContain('<ReadOnly>true</ReadOnly>');
    expect(config).toContain('<ReadOnly>false</ReadOnly>');
    expect(config).not.toContain('NamedPipe');
  });

  it('binds start/exec/stop to one Task VM identity', async () => {
    const calls: readonly string[][] = [];
    const cli: WindowsSandboxCli = {
      async run(args) {
        (calls as string[][]).push([...args]);
        return { status: 0, stdout: args[0] === 'start' ? '{"id":"sandbox-1"}' : '{}', stderr: '' };
      },
    };
    const vm = await WindowsSandboxTaskVm.start(cli, {
      taskId: 'task', sandboxId: 'sandbox-1', budget, baselinePath: 'C:\\base', cowPath: 'C:\\cow',
    });
    await vm.execWorker('worker.exe');
    await vm.stop();
    await vm.stop();
    expect(calls.map((item) => item[0])).toEqual(['start', 'connect', 'exec', 'exec', 'stop']);
    expect(calls[2]).toContain('ExistingLogin');
    expect(calls[3]).toContain('ExistingLogin');
  });

  it('waits for the connected sandbox login to accept commands', async () => {
    let loginAttempts = 0;
    const cli: WindowsSandboxCli = {
      async run(args) {
        if (args[0] === 'start') return { status: 0, stdout: '{"Id":"sandbox-1"}', stderr: '' };
        if (args[0] === 'exec') {
          loginAttempts++;
          return { status: loginAttempts === 1 ? 1 : 0, stdout: '', stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    };
    const vm = await WindowsSandboxTaskVm.start(cli, {
      taskId: 'task', sandboxId: 'sandbox-1', budget, baselinePath: 'C:\\base', cowPath: 'C:\\cow',
    });
    await vm.stop();
    expect(loginAttempts).toBe(2);
  });

  it('stops the Task VM when establishing the sandbox login fails', async () => {
    const calls: string[][] = [];
    const cli: WindowsSandboxCli = {
      async run(args) {
        calls.push([...args]);
        return {
          status: args[0] === 'connect' ? 1 : 0,
          stdout: args[0] === 'start' ? '{"Id":"sandbox-1"}' : '',
          stderr: '',
        };
      },
    };
    await expect(WindowsSandboxTaskVm.start(cli, {
      taskId: 'task', sandboxId: 'sandbox-1', budget, baselinePath: 'C:\\base', cowPath: 'C:\\cow',
    })).rejects.toThrow('WINDOWS_SANDBOX_CONNECT_FAILED');
    expect(calls.map((item) => item[0])).toEqual(['start', 'connect', 'stop']);
  });

  it('derives the restricted worker token from the sandbox login instead of a WTS console session', () => {
    expect(WINDOWS_JOB_SUPERVISOR_SOURCE).toContain('OpenProcessToken(GetCurrentProcess()');
    expect(WINDOWS_JOB_SUPERVISOR_SOURCE).toContain('CreateRestrictedToken(userToken, DISABLE_MAX_PRIVILEGE, 0, IntPtr.Zero, 0, IntPtr.Zero, 0, IntPtr.Zero');
    expect(WINDOWS_JOB_SUPERVISOR_SOURCE).not.toContain('LUA_TOKEN');
    expect(WINDOWS_JOB_SUPERVISOR_SOURCE).not.toContain('WTSQueryUserToken');
    expect(WINDOWS_JOB_SUPERVISOR_SOURCE).toContain('{ "USERPROFILE", profile }');
    expect(WINDOWS_JOB_SUPERVISOR_SOURCE).toContain('{ "LOCALAPPDATA", Path.Combine(profile');
  });

  it('accepts the SandboxId field returned by the Windows Sandbox CLI', async () => {
    const cli: WindowsSandboxCli = {
      async run(args) {
        return {
          status: 0,
          stdout: args[0] === 'start' ? '{"SandboxId":"sandbox-1"}' : '{}',
          stderr: '',
        };
      },
    };
    const vm = await WindowsSandboxTaskVm.start(cli, {
      taskId: 'task', sandboxId: 'sandbox-1', budget, baselinePath: 'C:\\base', cowPath: 'C:\\cow',
    });
    await vm.stop();
  });

  it('derives low-integrity Job Object limits without inherited handles or raw network', () => {
    expect(deriveWindowsWorkerPolicy(budget)).toMatchObject({
      integrity: 'low',
      job: { killOnClose: true, activeProcessLimit: 32, memoryBytes: budget.memoryBytes, timeoutMs: 20_000, cpuCores: 2 },
      inheritedHandles: [], rawNetwork: false, controlChannelVisible: false,
    });
  });

  it('records deterministic platform probe evidence', async () => {
    const evidence = await probeWindowsSandbox(
      { platform: 'win32', productName: 'Windows 11 Pro', build: 26100, featureState: 'enabled' },
      { run: async () => ({ status: 0, stdout: '1.0.0', stderr: '' }) },
      'commit',
    );
    expect(evidence.map((item) => [item.probeId, item.status])).toEqual([
      ['windows_11_24h2', 'passed'], ['windows_sandbox_feature', 'passed'], ['windows_sandbox_cli', 'passed'],
    ]);
  });

  it('reprobes CLI changes and rejects old commit, OS, or backend evidence replay', async () => {
    let available = true;
    const cli = { run: async () => available
      ? { status: 0, stdout: '1.0.0', stderr: '' }
      : { status: 1, stdout: '', stderr: 'missing' } };
    const facts = { platform: 'win32' as const, productName: 'Windows 11 Pro', build: 26100, featureState: 'enabled' as const };
    const first = await WindowsSandboxBackend.create({
      facts, cli, commit: 'new', certificationEvidence: [...requiredEvidence('passed'), evidence('windows_read_tools', 'passed')],
      openCertifiedTask: async () => { throw new Error('unused'); },
    });
    expect(first.report.capabilities).toEqual([]);
    expect(first.report.evidence.some((item) => item.status === 'failed')).toBe(true);
    available = false;
    const second = await WindowsSandboxBackend.create({ facts, cli, commit: 'new' });
    expect(second.report.evidence.find((item) => item.probeId === 'windows_sandbox_cli')?.status).toBe('failed');
    expect(second.report.capabilities).toEqual([]);
  });

  it('enables host broker capabilities only from independently bound component evidence', async () => {
    const backend = await WindowsSandboxBackend.create({
      facts: { platform: 'win32', productName: 'Windows 11 Pro', build: 26100, featureState: 'enabled' },
      cli: { run: async () => ({ status: 0, stdout: '1.0.0', stderr: '' }) },
      certificationEvidence: [
        ...requiredEvidence('passed'),
        evidence('windows_read_tools', 'passed'),
        { ...evidence('windows_network_egress', 'passed'), backend: 'windows-egress-broker', backendVersion: 'windows-egress-broker-v1' },
        { ...evidence('windows_credential_manager', 'passed'), backend: 'windows-credential-manager', backendVersion: 'windows-credential-manager-v1' },
      ],
      openCertifiedTask: async () => { throw new Error('unused'); },
    });
    expect(backend.report.capabilities).toEqual(['FilesystemRead', 'NetworkEgress', 'CredentialUse']);
  });

  it('removes capabilities when the installed Store CLI version changes', async () => {
    const facts = { platform: 'win32' as const, productName: 'Windows 11 Pro', build: 26100, featureState: 'enabled' as const };
    const certificationEvidence = [...requiredEvidence('passed'), evidence('windows_read_tools', 'passed')];
    const current = await WindowsSandboxBackend.create({
      facts,
      cli: { run: async () => ({ status: 0, stdout: '1.0.0', stderr: '' }) },
      certificationEvidence,
      openCertifiedTask: async () => { throw new Error('unused'); },
    });
    expect(current.report.capabilities).toEqual(['FilesystemRead']);
    const changed = await WindowsSandboxBackend.create({
      facts,
      cli: { run: async () => ({ status: 0, stdout: '2.0.0', stderr: '' }) },
      certificationEvidence,
      openCertifiedTask: async () => { throw new Error('unused'); },
    });
    expect(changed.report.capabilities).toEqual([]);
    expect(changed.report.backendVersion).toBe('windows-sandbox-cli-v1@2.0.0#unpackaged');
  });
});

function requiredEvidence(status: ProbeEvidence['status']): ProbeEvidence[] {
  return REQUIRED_SANDBOX_PROBES.map((probeId) => evidence(probeId, status));
}

function evidence(probeId: string, status: ProbeEvidence['status']): ProbeEvidence {
  return { probeId, status, commit: 'working-tree', os: 'win32:build:26100', backend: 'windows-sandbox', backendVersion: 'windows-sandbox-cli-v1@1.0.0#unpackaged', probeVersion: '1', evidenceDigest: `${probeId}-${status}` };
}
