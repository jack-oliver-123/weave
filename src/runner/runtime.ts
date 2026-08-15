import { availableParallelism, totalmem, userInfo } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  EphemeralRunnerIdentity,
  type LocalIpcEndpoint,
  RUNNER_PROTOCOL_VERSION,
} from './protocol.js';
import { openRunnerControlChannel } from './ipc-control.js';
import { LinuxNamespaceBackend, linuxReadToolDefinitions } from './linux-backend.js';
import { defaultResourceBudget } from './resources.js';
import { RunnerSupervisor } from './supervisor.js';
import { SupervisorActionRunnerParticipant } from './action-runner.js';
import type { CapabilityReport } from './capability-report.js';
import type { ProbeEvidence } from './capability-report.js';
import {
  HostWindowsSandboxCli,
  windowsPlatformProbeScript,
  windowsSandboxRuntimeVersion,
  WINDOWS_CREDENTIAL_BACKEND_VERSION,
  WINDOWS_EGRESS_BACKEND_VERSION,
  WindowsSandboxBackend,
  type WindowsPlatformFacts,
  type WindowsSandboxCli,
} from './windows-backend.js';
import { WindowsTaskSandbox } from './windows-task-sandbox.js';
import {
  loadWindowsCertificationArtifact,
  loadWindowsComponentCertificationArtifact,
} from './certification-artifact.js';

export interface CertifiedReadRunnerRuntime {
  readonly runner: SupervisorActionRunnerParticipant;
  readonly definitions: ReturnType<typeof linuxReadToolDefinitions>;
  readonly backend: 'linux' | 'wsl2' | 'windows-sandbox';
  readonly capabilityReport: CapabilityReport;
}

export interface CertifiedWindowsRunnerOptions {
  readonly facts: WindowsPlatformFacts;
  readonly certificationEvidence: readonly ProbeEvidence[];
  readonly commit?: string;
  readonly cli?: WindowsSandboxCli;
}

export interface CertifiedWindowsArtifactRunnerOptions {
  readonly facts: WindowsPlatformFacts;
  readonly evidencePath: string;
  readonly expectedCommit: string;
  readonly cli?: WindowsSandboxCli;
}

export async function createCertifiedWindowsRunnerRuntimeFromArtifact(
  workspaceRoot: string,
  options: CertifiedWindowsArtifactRunnerOptions,
): Promise<CertifiedReadRunnerRuntime> {
  const certificationEvidence = await loadWindowsCertificationArtifact(
    options.evidencePath,
    options.facts,
    options.expectedCommit,
  );
  return createCertifiedWindowsRunnerRuntime(workspaceRoot, {
    facts: options.facts,
    certificationEvidence,
    commit: options.expectedCommit,
    ...(options.cli === undefined ? {} : { cli: options.cli }),
  });
}

export async function createCertifiedWindowsRunnerRuntimeFromLocalArtifact(
  workspaceRoot: string,
): Promise<CertifiedReadRunnerRuntime> {
  if (process.platform !== 'win32') throw new Error('WINDOWS_SANDBOX_UNAVAILABLE');
  const applicationRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const cli = new HostWindowsSandboxCli();
  const [facts, commit] = await Promise.all([
    detectWindowsPlatformFacts(),
    currentRepositoryCommit(applicationRoot),
  ]);
  const versionResult = await cli.run(['--version']);
  if (versionResult.status !== 0 || versionResult.stdout.trim() === '') throw new Error('WINDOWS_SANDBOX_UNAVAILABLE');
  const sandboxBackendVersion = windowsSandboxRuntimeVersion(facts, versionResult.stdout.trim());
  const evidenceRoot = resolve(applicationRoot, 'artifacts', 'certification');
  const sandboxEvidence = await loadWindowsCertificationArtifact(
    resolve(evidenceRoot, 'windows-sandbox.json'), facts, commit, sandboxBackendVersion,
  );
  const [networkEvidence, credentialEvidence] = await Promise.all([
    optionalWindowsComponentEvidence(
      resolve(evidenceRoot, 'windows-egress-broker.json'), facts, commit,
      'windows-egress-broker', WINDOWS_EGRESS_BACKEND_VERSION,
    ),
    optionalWindowsComponentEvidence(
      resolve(evidenceRoot, 'windows-credential-manager.json'), facts, commit,
      'windows-credential-manager', WINDOWS_CREDENTIAL_BACKEND_VERSION,
    ),
  ]);
  return createCertifiedWindowsRunnerRuntime(workspaceRoot, {
    facts,
    commit,
    cli,
    certificationEvidence: [...sandboxEvidence, ...networkEvidence, ...credentialEvidence],
  });
}

export async function createCertifiedWindowsRunnerRuntime(
  workspaceRoot: string,
  options: CertifiedWindowsRunnerOptions,
): Promise<CertifiedReadRunnerRuntime> {
  const cli = options.cli ?? new HostWindowsSandboxCli();
  let certifiedCapabilities = Object.freeze([]) as CapabilityReport['capabilities'];
  const backend = await WindowsSandboxBackend.create({
    facts: options.facts,
    cli,
    certificationEvidence: options.certificationEvidence,
    ...(options.commit === undefined ? {} : { commit: options.commit }),
    openCertifiedTask: async (input) => WindowsTaskSandbox.create({
      ...input,
      workspaceRoot,
      cli,
      certifiedCapabilities,
    }),
  });
  certifiedCapabilities = backend.report.capabilities;
  if (!certifiedCapabilities.includes('FilesystemRead')) throw new Error('SANDBOX_UNAVAILABLE');
  const supervisor = await createAuthenticatedSupervisor(backend);
  const definitions = linuxReadToolDefinitions();
  const runner = new SupervisorActionRunnerParticipant(
    supervisor,
    definitions,
    defaultResourceBudget({ cpuCores: availableParallelism(), memoryBytes: totalmem() }),
    randomUUID,
    certifiedCapabilities,
  );
  return Object.freeze({ runner, definitions, backend: 'windows-sandbox', capabilityReport: backend.report });
}

export async function createCertifiedReadRunnerRuntime(workspaceRoot: string): Promise<CertifiedReadRunnerRuntime> {
  const platform = process.platform === 'win32' ? 'wsl2' : 'linux';
  const backend = await LinuxNamespaceBackend.create({ workspaceRoot, platform });
  if (!backend.report.capabilities.includes('FilesystemRead')) throw new Error('SANDBOX_UNAVAILABLE');

  const supervisor = await createAuthenticatedSupervisor(backend);
  const definitions = linuxReadToolDefinitions();
  const runner = new SupervisorActionRunnerParticipant(
    supervisor,
    definitions,
    defaultResourceBudget({ cpuCores: availableParallelism(), memoryBytes: totalmem() }),
    randomUUID,
    backend.report.capabilities,
  );
  return Object.freeze({ runner, definitions, backend: platform, capabilityReport: backend.report });
}

async function createAuthenticatedSupervisor(backend: ConstructorParameters<typeof RunnerSupervisor>[1]) {
  const runnerId = backend.report.runnerId;
  const owner = userInfo().username;
  const host = new EphemeralRunnerIdentity(`host-${randomUUID()}`);
  const supervisorIdentity = new EphemeralRunnerIdentity(runnerId);
  const endpoint: LocalIpcEndpoint = process.platform === 'win32'
    ? {
        protocolVersion: RUNNER_PROTOCOL_VERSION,
        transport: 'windows_named_pipe',
        address: `\\\\.\\pipe\\weave-${randomUUID()}`,
        ownerIdentity: owner,
        access: 'current_user_only',
        tcpListening: false,
      }
    : {
        protocolVersion: RUNNER_PROTOCOL_VERSION,
        transport: 'unix_socket',
        address: `/tmp/weave-${randomUUID()}.sock`,
        ownerIdentity: owner,
        access: 'current_user_only',
        tcpListening: false,
      };
  return openRunnerControlChannel({
    endpoint,
    expectedOwner: owner,
    hostIdentity: host,
    supervisorIdentity,
    createSupervisor: (session) => new RunnerSupervisor(session, backend, randomUUID),
  });
}

async function detectWindowsPlatformFacts(): Promise<WindowsPlatformFacts> {
  const { stdout } = await promisify(execFile)('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', windowsPlatformProbeScript(),
  ], { windowsHide: true });
  const parsed = JSON.parse(stdout) as Partial<WindowsPlatformFacts>;
  if (typeof parsed.productName !== 'string' || !Number.isInteger(parsed.build)
    || !['enabled', 'disabled', 'unknown'].includes(parsed.featureState ?? '')) {
    throw new Error('WINDOWS_PLATFORM_PROBE_FAILED');
  }
  return {
    platform: 'win32', productName: parsed.productName, build: parsed.build!,
    featureState: parsed.featureState!,
    ...(typeof parsed.cliPackageIdentity === 'string' ? { cliPackageIdentity: parsed.cliPackageIdentity } : {}),
  };
}

async function currentRepositoryCommit(applicationRoot: string): Promise<string> {
  const { stdout } = await promisify(execFile)('git.exe', ['-C', applicationRoot, 'rev-parse', 'HEAD'], { windowsHide: true });
  const commit = stdout.trim();
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error('BUILD_COMMIT_UNAVAILABLE');
  return commit;
}

async function optionalWindowsComponentEvidence(
  path: string,
  facts: WindowsPlatformFacts,
  commit: string,
  backend: 'windows-egress-broker' | 'windows-credential-manager',
  version: string,
): Promise<readonly ProbeEvidence[]> {
  try {
    return await loadWindowsComponentCertificationArtifact(path, facts, commit, backend, version);
  } catch {
    return [];
  }
}
