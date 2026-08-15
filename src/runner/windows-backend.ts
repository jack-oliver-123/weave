import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { release } from 'node:os';
import type { CapabilityPrimitive } from '../security/domain.js';
import { buildCapabilityReport, REQUIRED_SANDBOX_PROBES, type CapabilityReport, type ProbeEvidence } from './capability-report.js';
import type { ResourceBudget } from './resources.js';
import type { SandboxBackend, TaskSandboxBackend } from './supervisor.js';

export const WINDOWS_BACKEND_VERSION = 'windows-sandbox-cli-v1';
export const WINDOWS_EGRESS_BACKEND_VERSION = 'windows-egress-broker-v1';
export const WINDOWS_CREDENTIAL_BACKEND_VERSION = 'windows-credential-manager-v1';
export const WINDOWS_SANDBOX_APPX_NAME_PATTERN = '*WindowsSandbox*';
const WINDOWS_MINIMUM_BUILD = 26_100;
const MAX_CLI_OUTPUT_BYTES = 1024 * 1024;
const WINDOWS_LOGIN_READY_TIMEOUT_MS = 30_000;
const WINDOWS_LOGIN_RETRY_MS = 250;

export interface WindowsSandboxCommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface WindowsSandboxCli {
  run(args: readonly string[], signal?: AbortSignal): Promise<WindowsSandboxCommandResult>;
}

export function windowsSandboxCliCapturesOutput(args: readonly string[]): boolean {
  const command = args[0]?.toLowerCase();
  return command !== 'connect' && command !== 'connecttosandbox';
}

export class HostWindowsSandboxCli implements WindowsSandboxCli {
  constructor(private readonly executable = 'wsb.exe') {}

  async run(args: readonly string[], signal?: AbortSignal): Promise<WindowsSandboxCommandResult> {
    return new Promise((resolve, reject) => {
      const captureOutput = windowsSandboxCliCapturesOutput(args);
      const child = spawn(this.executable, [...args], {
        windowsHide: true,
        shell: false,
        stdio: captureOutput ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'ignore', 'ignore'],
        ...(signal === undefined ? {} : { signal }),
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes <= MAX_CLI_OUTPUT_BYTES) stdout.push(chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes <= MAX_CLI_OUTPUT_BYTES) stderr.push(chunk);
      });
      child.once('error', reject);
      child.once('close', (status) => resolve({
        status: status ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }));
    });
  }
}

export interface WindowsPlatformFacts {
  readonly platform: NodeJS.Platform;
  readonly productName: string;
  readonly build: number;
  readonly featureState: 'enabled' | 'disabled' | 'unknown';
  readonly cliPackageIdentity?: string;
  readonly cliVersion?: string;
}

export function windowsPlatformProbeScript(): string {
  return [
    '$os=Get-CimInstance Win32_OperatingSystem;',
    `$package=Get-AppxPackage -Name '${WINDOWS_SANDBOX_APPX_NAME_PATTERN}' -ErrorAction SilentlyContinue | Select-Object -First 1;`,
    "[pscustomobject]@{productName=$os.Caption;build=[int]$os.BuildNumber;featureState=$(if($package){'enabled'}else{'unknown'});cliPackageIdentity=$(if($package){$package.PackageFullName}else{$null})}|ConvertTo-Json -Compress",
  ].join('');
}

export interface WindowsSandboxBackendOptions {
  readonly facts: WindowsPlatformFacts;
  readonly cli: WindowsSandboxCli;
  readonly commit?: string;
  readonly certificationEvidence?: readonly ProbeEvidence[];
  readonly openCertifiedTask?: (input: WindowsTaskVmInput) => Promise<TaskSandboxBackend>;
}

export interface WindowsTaskVmInput {
  readonly taskId: string;
  readonly sandboxId: string;
  readonly budget: ResourceBudget;
  readonly baselinePath: string;
  readonly cowPath: string;
}

export class WindowsSandboxBackend implements SandboxBackend {
  private constructor(
    readonly report: CapabilityReport,
    private readonly openCertifiedTask?: WindowsSandboxBackendOptions['openCertifiedTask'],
  ) {}

  static async create(options: WindowsSandboxBackendOptions): Promise<WindowsSandboxBackend> {
    const commit = options.commit ?? 'working-tree';
    const platformEvidence = await probeWindowsSandbox(options.facts, options.cli, commit);
    const runtimeBackendVersion = platformEvidence.find((item) => item.probeId === 'windows_sandbox_cli')?.backendVersion
      ?? windowsSandboxRuntimeVersion(options.facts, 'missing');
    const evidence = [
      ...platformEvidence,
      ...(options.certificationEvidence ?? []).map((item) => currentEvidence(item, options.facts, commit, runtimeBackendVersion)),
    ];
    const report = buildCapabilityReport({
      runnerId: 'runner-windows-sandbox',
      backend: 'windows-sandbox',
      backendVersion: runtimeBackendVersion,
      requestedCapabilities: options.openCertifiedTask === undefined ? [] : certifiedSlices(evidence),
      evidence,
    });
    return new WindowsSandboxBackend(report, options.openCertifiedTask);
  }

  async openTask(input: { readonly taskId: string; readonly sandboxId: string; readonly budget: ResourceBudget }): Promise<TaskSandboxBackend> {
    if (!this.report.capabilities.includes('FilesystemRead') || this.openCertifiedTask === undefined) {
      throw new Error('SANDBOX_UNCERTIFIED');
    }
    return this.openCertifiedTask({ ...input, baselinePath: '', cowPath: '' });
  }
}

export class WindowsSandboxTaskVm {
  private stopped = false;
  private constructor(readonly id: string, private readonly cli: WindowsSandboxCli) {}

  static async start(cli: WindowsSandboxCli, input: WindowsTaskVmInput): Promise<WindowsSandboxTaskVm> {
    const config = windowsSandboxConfiguration(input);
    const result = await cli.run(['start', '--raw', '--id', input.sandboxId, '--config', config]);
    if (result.status !== 0) throw new Error('WINDOWS_SANDBOX_START_FAILED');
    const parsed = parseRawJson(result.stdout);
    const id = stringField(parsed, ['id', 'sandboxId', 'SandboxId', 'Id']) ?? input.sandboxId;
    if (id !== input.sandboxId) throw new Error('WINDOWS_SANDBOX_IDENTITY_MISMATCH');
    const vm = new WindowsSandboxTaskVm(id, cli);
    try {
      const connected = await cli.run(['connect', '--raw', '--id', id]);
      if (connected.status !== 0) throw new Error('WINDOWS_SANDBOX_CONNECT_FAILED');
      await waitForWindowsSandboxLogin(cli, id);
      return vm;
    } catch (error) {
      await vm.stop().catch(() => undefined);
      throw error;
    }
  }

  async execWorker(command: string, workingDirectory = 'C:\\Weave\\Cow'): Promise<void> {
    return this.exec(command, 'ExistingLogin', workingDirectory);
  }

  async exec(
    command: string,
    runAs: 'ExistingLogin' | 'System',
    workingDirectory = 'C:\\Weave\\Cow',
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.stopped) throw new Error('TASK_SANDBOX_CLOSED');
    const result = await this.cli.run([
      'exec', '--raw', '--id', this.id, '--command', command,
      '--run-as', runAs, '--working-directory', workingDirectory,
    ], signal);
    if (result.status !== 0) throw new Error('WINDOWS_WORKER_FAILED');
  }

  async share(hostPath: string, sandboxPath: string, allowWrite: boolean): Promise<void> {
    if (this.stopped) throw new Error('TASK_SANDBOX_CLOSED');
    const args = ['share', '--raw', '--id', this.id, '--host-path', hostPath, '--sandbox-path', sandboxPath];
    if (allowWrite) args.push('--allow-write');
    const result = await this.cli.run(args);
    if (result.status !== 0) throw new Error('WINDOWS_SANDBOX_SHARE_FAILED');
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const result = await this.cli.run(['stop', '--raw', '--id', this.id]);
    if (result.status !== 0) throw new Error('WINDOWS_SANDBOX_STOP_FAILED');
  }
}

async function waitForWindowsSandboxLogin(cli: WindowsSandboxCli, id: string): Promise<void> {
  const deadline = Date.now() + WINDOWS_LOGIN_READY_TIMEOUT_MS;
  do {
    const ready = await cli.run([
      'exec', '--raw', '--id', id,
      '--command', 'cmd.exe /d /c exit 0',
      '--run-as', 'ExistingLogin',
      '--working-directory', 'C:\\',
    ]);
    if (ready.status === 0) return;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, WINDOWS_LOGIN_RETRY_MS));
  } while (true);
  throw new Error('WINDOWS_SANDBOX_LOGIN_NOT_READY');
}

export function windowsSandboxConfiguration(input: WindowsTaskVmInput): string {
  const memoryMiB = Math.max(2048, Math.min(16 * 1024, Math.floor(input.budget.memoryBytes / 1024 ** 2)));
  return [
    '<Configuration>',
    '<Networking>Disable</Networking>',
    '<VGpu>Disable</VGpu>',
    '<AudioInput>Disable</AudioInput>',
    '<VideoInput>Disable</VideoInput>',
    '<PrinterRedirection>Disable</PrinterRedirection>',
    '<ClipboardRedirection>Disable</ClipboardRedirection>',
    '<ProtectedClient>Enable</ProtectedClient>',
    `<MemoryInMB>${memoryMiB}</MemoryInMB>`,
    '<MappedFolders>',
    mappedFolder(input.baselinePath, 'C:\\Weave\\Baseline', true),
    mappedFolder(input.cowPath, 'C:\\Weave\\Cow', false),
    '</MappedFolders>',
    '</Configuration>',
  ].join('');
}

export interface WindowsWorkerPolicy {
  readonly integrity: 'low';
  readonly job: {
    readonly killOnClose: true;
    readonly activeProcessLimit: number;
    readonly memoryBytes: number;
    readonly timeoutMs: number;
    readonly cpuCores: number;
  };
  readonly inheritedHandles: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly rawNetwork: false;
  readonly controlChannelVisible: false;
}

export function deriveWindowsWorkerPolicy(budget: ResourceBudget): WindowsWorkerPolicy {
  return Object.freeze({
    integrity: 'low',
    job: Object.freeze({
      killOnClose: true,
      activeProcessLimit: budget.pids,
      memoryBytes: budget.memoryBytes,
      timeoutMs: budget.actionTimeoutMs,
      cpuCores: budget.cpuCores,
    }),
    inheritedHandles: Object.freeze([]),
    environment: Object.freeze({ PATH: 'C:\\Windows\\System32', CI: '1' }),
    rawNetwork: false,
    controlChannelVisible: false,
  });
}

export async function probeWindowsSandbox(
  facts: WindowsPlatformFacts,
  cli: WindowsSandboxCli,
  commit = 'working-tree',
): Promise<readonly ProbeEvidence[]> {
  const supported = facts.platform === 'win32'
    && /Windows 11/i.test(facts.productName)
    && Number.isInteger(facts.build)
    && facts.build >= WINDOWS_MINIMUM_BUILD;
  let cliStatus: ProbeEvidence['status'] = 'not_run';
  let featureStatus: ProbeEvidence['status'] = facts.featureState === 'disabled' ? 'failed' : 'not_run';
  let version = facts.cliVersion ?? 'missing';
  if (supported && facts.featureState !== 'disabled') {
    try {
      const result = await cli.run(['--version']);
      cliStatus = result.status === 0 && result.stdout.trim().length > 0 ? 'passed' : 'failed';
      if (cliStatus === 'passed') version = result.stdout.trim();
    } catch { cliStatus = 'not_run'; }
    if (cliStatus === 'passed') {
      try {
        const result = await cli.run(['list', '--raw']);
        featureStatus = result.status === 0 ? 'passed' : 'failed';
      } catch { featureStatus = 'not_run'; }
    }
  }
  return [
    evidence('windows_11_24h2', supported ? 'passed' : 'failed', commit, facts, version),
    evidence('windows_sandbox_feature', featureStatus, commit, facts, version),
    evidence('windows_sandbox_cli', cliStatus, commit, facts, version),
  ];
}

export function currentWindowsPlatformFacts(
  productName: string,
  featureState: WindowsPlatformFacts['featureState'],
  cliVersion?: string,
): WindowsPlatformFacts {
  const build = Number.parseInt(release().split('.')[2] ?? '', 10);
  return { platform: process.platform, productName, build, featureState, ...(cliVersion === undefined ? {} : { cliVersion }) };
}

export function windowsPlatformIdentity(facts: WindowsPlatformFacts): string {
  return `${facts.platform}:build:${facts.build}`;
}

export function windowsSandboxRuntimeVersion(facts: WindowsPlatformFacts, cliVersion: string): string {
  return `${WINDOWS_BACKEND_VERSION}@${cliVersion}#${facts.cliPackageIdentity ?? 'unpackaged'}`;
}

function certifiedSlices(evidence: readonly ProbeEvidence[]): CapabilityPrimitive[] {
  const statuses = new Map(evidence.map((item) => [item.probeId, item.status]));
  if (statuses.get('windows_11_24h2') !== 'passed' || statuses.get('windows_sandbox_feature') !== 'passed'
    || statuses.get('windows_sandbox_cli') !== 'passed'
    || statuses.get('windows_read_tools') !== 'passed') return [];
  const capabilities: CapabilityPrimitive[] = ['FilesystemRead'];
  if (statuses.get('windows_transactional_write') === 'passed') capabilities.push('FilesystemWrite');
  if (statuses.get('windows_structured_process') === 'passed' && statuses.get('windows_bash') === 'passed') capabilities.push('ProcessSpawn');
  if (statuses.get('windows_network_egress') === 'passed') capabilities.push('NetworkEgress');
  if (statuses.get('windows_credential_manager') === 'passed') capabilities.push('CredentialUse');
  return capabilities;
}

function evidence(id: string, status: ProbeEvidence['status'], commit: string, facts: WindowsPlatformFacts, version: string): ProbeEvidence {
  return Object.freeze({
    probeId: id, status, commit,
    os: windowsPlatformIdentity(facts),
    backend: 'windows-sandbox', backendVersion: windowsSandboxRuntimeVersion(facts, version), probeVersion: '1',
    evidenceDigest: createHash('sha256').update(`${id}\0${status}\0${facts.build}\0${version}`).digest('base64url'),
  });
}

function currentEvidence(
  item: ProbeEvidence,
  facts: WindowsPlatformFacts,
  commit: string,
  runtimeBackendVersion: string,
): ProbeEvidence {
  const currentOs = windowsPlatformIdentity(facts);
  const component = evidenceComponent(item.probeId, runtimeBackendVersion);
  const current = item.commit === commit
    && item.os === currentOs
    && item.backend === component.backend
    && item.backendVersion === component.version
    && item.probeVersion === '1';
  if (current) return Object.freeze({ ...item });
  return Object.freeze({
    ...item,
    status: 'failed',
    evidenceDigest: createHash('sha256').update(`stale-evidence\0${item.evidenceDigest}\0${commit}\0${currentOs}`).digest('base64url'),
  });
}

function evidenceComponent(probeId: string, runtimeBackendVersion: string): { readonly backend: string; readonly version: string } {
  if (probeId === 'windows_network_egress') {
    return { backend: 'windows-egress-broker', version: WINDOWS_EGRESS_BACKEND_VERSION };
  }
  if (probeId === 'windows_credential_manager') {
    return { backend: 'windows-credential-manager', version: WINDOWS_CREDENTIAL_BACKEND_VERSION };
  }
  return { backend: 'windows-sandbox', version: runtimeBackendVersion };
}

function mappedFolder(host: string, sandbox: string, readOnly: boolean): string {
  return `<MappedFolder><HostFolder>${xml(host)}</HostFolder><SandboxFolder>${xml(sandbox)}</SandboxFolder><ReadOnly>${readOnly}</ReadOnly></MappedFolder>`;
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function parseRawJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* fail below */ }
  throw new Error('WINDOWS_SANDBOX_PROTOCOL_ERROR');
}

function stringField(record: Record<string, unknown>, names: readonly string[]): string | undefined {
  for (const name of names) if (typeof record[name] === 'string') return record[name];
  return undefined;
}

export const WINDOWS_REQUIRED_NEGATIVE_PROBES = REQUIRED_SANDBOX_PROBES;
