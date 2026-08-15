import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { minimatch } from 'minimatch';
import type { ToolCallResult, ToolDefinition } from '../shared/types.js';
import { buildCapabilityReport, REQUIRED_SANDBOX_PROBES, type CapabilityReport, type ProbeEvidence } from './capability-report.js';
import type { ActionWorkerBackend, ActionWorkerLaunchInput, ActionWorkerResult, SandboxBackend, TaskSandboxBackend } from './supervisor.js';
import type { ResourceBudget } from './resources.js';
import {
  captureWorkspaceSnapshots,
  TaskWorkspaceView,
  WorkspaceCommitBroker,
  defaultTransactionRoot,
  type FileSnapshot,
  type WorkspaceChangeSet,
} from './workspace-transaction.js';

const MAX_RESULTS = 1_000;
const MAX_SCAN_BYTES = 1024 * 1024;
const BACKEND_VERSION = 'linux-userns-v1';

export interface LinuxNamespaceBackendOptions {
  readonly workspaceRoot: string;
  readonly commit?: string;
  readonly platform?: 'linux' | 'wsl2';
  readonly transport?: NamespaceTransport;
  readonly transactionRecovery?: () => Promise<boolean>;
}

export interface NamespaceExecution {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly exitCode: number;
}

export interface NamespaceTransport {
  readonly platform: 'linux' | 'wsl2';
  readonly osDescription: string;
  toSandboxPath(hostPath: string): Promise<string>;
  run(workspacePath: string, mode: string, args: readonly string[], signal?: AbortSignal): Promise<NamespaceExecution>;
  verifyProcessTreeCleanup?(workspacePath: string): Promise<boolean>;
}

export class LinuxNamespaceBackend implements SandboxBackend {
  private constructor(
    readonly report: CapabilityReport,
    private readonly workspaceRoot: string,
    private readonly workspacePath: string,
    private readonly transport: NamespaceTransport,
  ) {}

  static async create(options: LinuxNamespaceBackendOptions): Promise<LinuxNamespaceBackend> {
    const transport = options.transport ?? await HostNamespaceTransport.create(options.platform);
    const workspacePath = await transport.toSandboxPath(options.workspaceRoot);
    const probe = await transport.run(workspacePath, 'probe', []);
    const statuses = parseProbeOutput(probe.stdout.toString('utf8'));
    if (transport.verifyProcessTreeCleanup !== undefined) {
      let cleanupPassed = false;
      try { cleanupPassed = await transport.verifyProcessTreeCleanup(workspacePath); } catch { cleanupPassed = false; }
      statuses.set('process_tree_cleanup', cleanupPassed ? 'passed' : 'failed');
    }
    const evidence: ProbeEvidence[] = REQUIRED_SANDBOX_PROBES.map((probeId) => ({
      probeId,
      status: statuses.get(probeId) === 'passed' ? 'passed' : 'failed',
      commit: options.commit ?? 'working-tree',
      os: transport.osDescription,
      backend: transport.platform,
      backendVersion: BACKEND_VERSION,
      probeVersion: '1',
      evidenceDigest: evidenceDigest(probeId, statuses.get(probeId) ?? 'missing'),
    }));
    if (transport.platform === 'wsl2') {
      for (const probeId of ['wsl_windows_mount_hidden', 'wsl_interop_hidden', 'wsl_windows_path_hidden']) {
        const status = statuses.get(probeId) === 'passed' ? 'passed' : 'failed';
        evidence.push({
          probeId, status, commit: options.commit ?? 'working-tree', os: transport.osDescription,
          backend: 'wsl2', backendVersion: BACKEND_VERSION, probeVersion: '1',
          evidenceDigest: evidenceDigest(probeId, status),
        });
      }
    }
    for (const probeId of ['write_worker_runtime', 'atomic_replace', 'bash_runtime', 'timeout_runtime']) {
      const status = statuses.get(probeId) === 'passed' ? 'passed' : 'failed';
      evidence.push({
        probeId, status, commit: options.commit ?? 'working-tree', os: transport.osDescription,
        backend: transport.platform, backendVersion: BACKEND_VERSION, probeVersion: '1',
        evidenceDigest: evidenceDigest(probeId, status),
      });
    }
    const readReport = buildCapabilityReport({
      runnerId: `runner-${transport.platform}`,
      backend: transport.platform,
      backendVersion: BACKEND_VERSION,
      requestedCapabilities: ['FilesystemRead'],
      evidence,
    });
    if (transport.platform === 'wsl2' && ['wsl_windows_mount_hidden', 'wsl_interop_hidden', 'wsl_windows_path_hidden']
      .some((probeId) => statuses.get(probeId) !== 'passed')) {
      return new LinuxNamespaceBackend({ ...readReport, capabilities: [] }, options.workspaceRoot, workspacePath, transport);
    }
    const recoveryAvailable = await (options.transactionRecovery ?? (async () => {
      const broker = await WorkspaceCommitBroker.create({
        workspaceRoot: options.workspaceRoot,
        transactionRoot: defaultTransactionRoot(options.workspaceRoot),
        allowedPaths: [],
      });
      return broker.writesAvailable;
    }))();
    const writeCertified = recoveryAvailable && ['write_worker_runtime', 'atomic_replace'].every((probeId) => statuses.get(probeId) === 'passed');
    const capabilities = [...readReport.capabilities];
    if (writeCertified && capabilities.includes('FilesystemRead')) capabilities.push('FilesystemWrite');
    if (capabilities.includes('FilesystemWrite') && ['bash_runtime', 'timeout_runtime'].every((probeId) => statuses.get(probeId) === 'passed')) capabilities.push('ProcessSpawn');
    const report = { ...readReport, capabilities: Object.freeze(capabilities) };
    return new LinuxNamespaceBackend(report, options.workspaceRoot, workspacePath, transport);
  }

  async openTask(_input: { readonly taskId: string; readonly sandboxId: string; readonly budget: ResourceBudget }): Promise<TaskSandboxBackend> {
    if (!this.report.capabilities.includes('FilesystemRead')) throw new Error('SANDBOX_UNCERTIFIED');
    const view = await TaskWorkspaceView.create(this.workspaceRoot);
    return new LinuxTaskSandbox(this.workspaceRoot, view, this.transport);
  }
}

class LinuxTaskSandbox implements TaskSandboxBackend {
  private closed = false;
  private currentView: TaskWorkspaceView;
  constructor(
    private readonly hostWorkspace: string,
    view: TaskWorkspaceView,
    private readonly transport: NamespaceTransport,
  ) { this.currentView = view; }

  async openWorker(input: ActionWorkerLaunchInput): Promise<ActionWorkerBackend> {
    if (this.closed) throw new Error('TASK_SANDBOX_CLOSED');
    if (!input.action.manifest.requirements.every((requirement) => requirement.type === 'FilesystemRead' || requirement.type === 'FilesystemWrite' || requirement.type === 'ProcessSpawn')) {
      throw new Error('SANDBOX_CAPABILITY_UNAVAILABLE');
    }
    const writes = input.action.manifest.requirements.some((requirement) => requirement.type === 'FilesystemWrite');
    if (!writes) return new LinuxReadWorker(await this.transport.toSandboxPath(this.currentView.root), this.transport, input);

    const actionView = await TaskWorkspaceView.create(this.currentView.root);
    const allowedPaths = input.action.manifest.requirements.flatMap((requirement) => requirement.type === 'FilesystemWrite' ? requirement.paths : []);
    const baselines = await captureWorkspaceSnapshots(this.hostWorkspace);
    const broker = await WorkspaceCommitBroker.create({
      workspaceRoot: this.hostWorkspace,
      transactionRoot: defaultTransactionRoot(this.hostWorkspace),
      allowedPaths,
    });
    const delegate = new LinuxReadWorker(await this.transport.toSandboxPath(actionView.root), this.transport, input);
    return new TransactionalLinuxWorker(delegate, actionView, baselines, broker, async () => {
      const previous = this.currentView;
      this.currentView = actionView;
      await previous.close();
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.currentView.close();
  }
}

class TransactionalLinuxWorker implements ActionWorkerBackend {
  private adopted = false;
  constructor(
    private readonly delegate: LinuxReadWorker,
    private readonly view: TaskWorkspaceView,
    private readonly baselines: ReadonlyMap<string, FileSnapshot>,
    private readonly broker: WorkspaceCommitBroker,
    private readonly adopt: () => Promise<void>,
  ) {}

  async execute(signal: AbortSignal): Promise<ActionWorkerResult> {
    const outcome = await this.delegate.execute(signal);
    const errorCode = outcome.result.content.error?.code;
    if ((outcome.result.isError && errorCode !== 'COMMAND_FAILED') || signal.aborted) return outcome;
    try {
      const extracted = await this.view.extractChangeSet(this.delegate.actionId);
      const changeSet: WorkspaceChangeSet = {
        actionId: extracted.actionId,
        changes: extracted.changes.map((change) => ({
          ...change,
          baseline: this.baselines.get(change.path) ?? { exists: false },
        })),
      };
      await this.broker.commit(changeSet);
      await this.adopt();
      this.adopted = true;
      return outcome;
    } catch (error) {
      return { result: failure(this.delegate.call, errorCodeFromUnknown(error), safeMessage(error)) };
    }
  }

  async close(reason: 'action_completed' | 'cancelled' | 'failed'): Promise<void> {
    await this.delegate.close(reason);
    if (!this.adopted) await this.view.close();
  }
}

class LinuxReadWorker implements ActionWorkerBackend {
  private closed = false;
  constructor(
    private readonly workspacePath: string,
    private readonly transport: NamespaceTransport,
    private readonly input: ActionWorkerLaunchInput,
  ) {}

  get actionId(): string { return this.input.action.actionId; }
  get call(): ActionWorkerLaunchInput['call'] { return this.input.call; }

  async execute(signal: AbortSignal): Promise<ActionWorkerResult> {
    if (this.closed) throw new Error('ACTION_WORKER_CLOSED');
    const call = this.input.call;
    let result: ToolCallResult;
    try {
      if (call.name === 'read_file') result = await this.readFile(signal);
      else if (call.name === 'glob') result = await this.glob(signal);
      else if (call.name === 'grep') result = await this.grep(signal);
      else if (call.name === 'create_file') result = await this.createFile(signal);
      else if (call.name === 'edit_file') result = await this.editFile(signal);
      else if (call.name === 'bash') result = await this.bash(signal);
      else result = failure(call, 'SANDBOX_CAPABILITY_UNAVAILABLE', 'Tool is not certified by this backend');
    } catch (error) {
      result = failure(call, signal.aborted ? 'TOOL_CANCELLED' : 'SANDBOX_EXECUTION_FAILED', safeMessage(error));
    }
    return { result };
  }

  async close(_reason: 'action_completed' | 'cancelled' | 'failed'): Promise<void> { this.closed = true; }

  private async readFile(signal: AbortSignal): Promise<ToolCallResult> {
    const record = inputRecord(this.input.call.input);
    const path = requiredString(record.path, 'path');
    const execution = await this.transport.run(this.workspacePath, 'read_file', [path], signal);
    if (execution.exitCode !== 0) return failure(this.input.call, errorCode(execution), safeStderr(execution));
    const text = new TextDecoder('utf-8', { fatal: true }).decode(execution.stdout);
    const lines = text.split(/\r\n|\n|\r/);
    const startLine = optionalPositiveInteger(record.startLine, 1, 'startLine');
    const lineCount = optionalPositiveInteger(record.lineCount, 200, 'lineCount');
    const selected = lines.slice(startLine - 1, startLine - 1 + lineCount);
    let content = selected.join('\n');
    let truncated = startLine - 1 + selected.length < lines.length;
    while (Buffer.byteLength(content, 'utf8') > this.input.profile.stdoutBytes && selected.length > 0) {
      selected.pop();
      content = selected.join('\n');
      truncated = true;
    }
    const endLine = selected.length === 0 ? startLine - 1 : startLine + selected.length - 1;
    return success(this.input.call, `Read ${path}`, {
      path: normalizeRelative(path), content, startLine, endLine, totalLines: lines.length, truncated,
      ...(truncated && selected.length > 0 ? { nextStartLine: endLine + 1 } : {}),
    });
  }

  private async glob(signal: AbortSignal): Promise<ToolCallResult> {
    const record = inputRecord(this.input.call.input);
    const pattern = requiredString(record.pattern, 'pattern');
    const base = optionalString(record.path, '.');
    const execution = await this.transport.run(this.workspacePath, 'glob', [base], signal);
    if (execution.exitCode !== 0) return failure(this.input.call, errorCode(execution), safeStderr(execution));
    const files = execution.stdout.toString('utf8').split('\0').filter(Boolean).map((path) => joinRelative(base, path)).sort();
    const prefix = base === '.' ? '' : `${normalizeRelative(base).replace(/\/$/, '')}/`;
    const matches = files.filter((path) => {
      const candidate = prefix !== '' && path.startsWith(prefix) ? path.slice(prefix.length) : path;
      return minimatch(candidate, pattern, { dot: false, nocase: false });
    });
    const truncated = matches.length > MAX_RESULTS || execution.stdout.length >= MAX_SCAN_BYTES;
    return success(this.input.call, `Matched ${Math.min(matches.length, MAX_RESULTS)} files`, {
      files: matches.slice(0, MAX_RESULTS), truncated,
      ...(truncated ? { reason: matches.length > MAX_RESULTS ? 'result_limit' : 'scan_limit' } : {}),
    });
  }

  private async grep(signal: AbortSignal): Promise<ToolCallResult> {
    const record = inputRecord(this.input.call.input);
    const pattern = requiredString(record.pattern, 'pattern');
    if (pattern.length > 4096) throw new TypeError('pattern must be at most 4096 characters');
    const base = optionalString(record.path, '.');
    const caseSensitive = record.caseSensitive !== false;
    const execution = await this.transport.run(this.workspacePath, 'grep', [base, pattern, caseSensitive ? '1' : '0'], signal);
    if (execution.exitCode !== 0 && execution.exitCode !== 1) return failure(this.input.call, errorCode(execution), safeStderr(execution));
    const matches = parseGrep(execution.stdout, typeof record.glob === 'string' ? record.glob : undefined);
    const truncated = matches.length >= MAX_RESULTS || execution.stdout.length >= this.input.profile.batchOutputBytes;
    return success(this.input.call, `Found ${Math.min(matches.length, MAX_RESULTS)} matches`, {
      matches: matches.slice(0, MAX_RESULTS), warnings: [], truncated,
      ...(truncated ? { reason: 'result_limit' } : {}),
    });
  }

  private async createFile(signal: AbortSignal): Promise<ToolCallResult> {
    const record = inputRecord(this.input.call.input);
    const path = requiredString(record.path, 'path');
    const content = requiredStringAllowEmpty(record.content, 'content');
    if (Buffer.byteLength(content, 'utf8') > 1024 * 1024) return failure(this.input.call, 'FILE_TOO_LARGE', 'File content exceeds 1 MiB');
    const execution = await this.transport.run(this.workspacePath, 'create_file', [path, content], signal);
    if (execution.exitCode !== 0) return failure(this.input.call, errorCode(execution), safeStderr(execution));
    return success(this.input.call, `Created ${path}`, {
      path: normalizeRelative(path), bytesWritten: Buffer.byteLength(content, 'utf8'), createdDirectories: [],
    });
  }

  private async editFile(signal: AbortSignal): Promise<ToolCallResult> {
    const record = inputRecord(this.input.call.input);
    const path = requiredString(record.path, 'path');
    if (!Array.isArray(record.edits) || record.edits.length < 1 || record.edits.length > 100) throw new TypeError('edits must contain 1 to 100 items');
    const edits = record.edits.map((value) => {
      const edit = inputRecord(value);
      return {
        oldText: requiredString(edit.oldText, 'oldText'),
        newText: requiredStringAllowEmpty(edit.newText, 'newText'),
      };
    });
    const execution = await this.transport.run(this.workspacePath, 'edit_file', [path, JSON.stringify(edits)], signal);
    if (execution.exitCode !== 0) return failure(this.input.call, errorCode(execution), safeStderr(execution));
    const data = JSON.parse(execution.stdout.toString('utf8')) as { beforeBytes: number; afterBytes: number };
    return success(this.input.call, `Edited ${path}`, {
      path: normalizeRelative(path), replacements: edits.length, ...data,
    });
  }

  private async bash(signal: AbortSignal): Promise<ToolCallResult> {
    const record = inputRecord(this.input.call.input);
    const command = requiredString(record.command, 'command');
    const cwd = optionalString(record.cwd, '.');
    const timeoutMs = optionalPositiveInteger(record.timeoutMs, this.input.profile.actionTimeoutMs, 'timeoutMs');
    if (timeoutMs > 600_000) throw new TypeError('timeoutMs must not exceed 600000');
    const watchdog = AbortSignal.timeout(timeoutMs + 30_000);
    const actionSignal = AbortSignal.any([signal, watchdog]);
    const execution = await this.transport.run(this.workspacePath, 'bash', [cwd, command, String(timeoutMs)], actionSignal);
    if (execution.exitCode !== 0) {
      const code = signal.aborted ? 'TOOL_CANCELLED' : watchdog.aborted ? 'TOOL_TIMEOUT' : errorCode(execution);
      return failure(this.input.call, code, safeStderr(execution));
    }
    const encoded = JSON.parse(execution.stdout.toString('utf8')) as {
      stdout: string; stderr: string; exitCode: number; durationMs: number; timedOut: boolean; truncated: boolean;
    };
    const data = {
      stdout: Buffer.from(encoded.stdout, 'base64').toString('utf8'),
      stderr: Buffer.from(encoded.stderr, 'base64').toString('utf8'),
      exitCode: encoded.exitCode,
      durationMs: encoded.durationMs,
      timedOut: encoded.timedOut,
      truncated: encoded.truncated,
    };
    if (encoded.timedOut) return failureWithData(this.input.call, 'TOOL_TIMEOUT', 'Bash execution timed out', data);
    if (encoded.exitCode !== 0) return failureWithData(this.input.call, 'COMMAND_FAILED', `Bash exited with status ${encoded.exitCode}`, data);
    return success(this.input.call, `Bash completed with status ${encoded.exitCode}`, data);
  }
}

export class HostNamespaceTransport implements NamespaceTransport {
  private constructor(
    readonly platform: 'linux' | 'wsl2',
    readonly osDescription: string,
    private readonly executable: string,
  ) {}

  static async create(requested?: 'linux' | 'wsl2'): Promise<HostNamespaceTransport> {
    const platform = requested ?? (process.platform === 'win32' ? 'wsl2' : 'linux');
    const executable = platform === 'wsl2' ? 'wsl.exe' : 'unshare';
    const version = platform === 'wsl2'
      ? await runProcess('wsl.exe', ['--exec', 'uname', '-r'])
      : await runProcess('uname', ['-r']);
    const description = version.stdout.toString('utf8').trim();
    if (platform === 'wsl2' && !/microsoft-standard-WSL2/i.test(description)) throw new Error('WSL1_UNSUPPORTED');
    return new HostNamespaceTransport(platform, description, executable);
  }

  async toSandboxPath(hostPath: string): Promise<string> {
    if (this.platform === 'linux') return hostPath;
    const match = /^([A-Za-z]):[\\/](.*)$/.exec(hostPath);
    if (match === null || hostPath.startsWith('\\\\') || hostPath.includes('\0')) throw new Error('WSL_PATH_CONVERSION_FAILED');
    return `/mnt/${match[1]!.toLowerCase()}/${match[2]!.replaceAll('\\', '/')}`;
  }

  run(workspacePath: string, mode: string, args: readonly string[], signal?: AbortSignal): Promise<NamespaceExecution> {
    const encoded = [workspacePath, mode, ...args].map((value) => Buffer.from(value, 'utf8').toString('base64'));
    const unshare = ['--user', '--map-root-user', '--mount', '--pid', '--fork', '--net', '/usr/bin/bash', '-s', '--', ...encoded];
    if (this.platform !== 'wsl2') return runProcess(this.executable, unshare, NAMESPACE_SCRIPT, signal);
    const token = `weave-namespace-${randomUUID()}`;
    return runProcess(
      this.executable,
      [
        '--exec', '/usr/bin/bash', '--noprofile', '--norc', '-c',
        'exec -a "$1" /usr/bin/unshare "${@:2}"', '_', token, ...unshare,
      ],
      NAMESPACE_SCRIPT,
      signal,
      async () => {
        await runProcess('wsl.exe', ['--exec', 'pkill', '-KILL', '-f', '--', token]);
      },
    );
  }

  async verifyProcessTreeCleanup(workspacePath: string): Promise<boolean> {
    const token = `weave-cleanup-${randomUUID()}`;
    const controller = new AbortController();
    const execution = this.run(workspacePath, 'cleanup_probe', [token], controller.signal);
    let processIds: readonly number[] = [];
    try {
      processIds = await waitForProcessIds(() => this.findProcessIds(token), 5_000);
    } finally {
      controller.abort(new Error('PROCESS_TREE_CLEANUP_PROBE_CLOSE'));
      await execution.catch(() => undefined);
    }
    if (processIds.length === 0) return false;
    const absent = await waitForProcessesGone(processIds, (pid) => this.processExists(pid), 5_000);
    if (!absent) await Promise.allSettled(processIds.map((pid) => this.killProcess(pid)));
    return absent;
  }

  private async findProcessIds(token: string): Promise<readonly number[]> {
    const execution = this.platform === 'wsl2'
      ? await runProcess('wsl.exe', ['--exec', 'pgrep', '-f', '--', token])
      : await runProcess('pgrep', ['-f', '--', token]);
    if (execution.exitCode !== 0) return [];
    return execution.stdout.toString('utf8').trim().split(/\s+/).map(Number).filter((pid) => Number.isInteger(pid) && pid > 1);
  }

  private async processExists(pid: number): Promise<boolean> {
    const execution = this.platform === 'wsl2'
      ? await runProcess('wsl.exe', ['--exec', 'kill', '-0', String(pid)])
      : await runProcess('kill', ['-0', String(pid)]);
    return execution.exitCode === 0;
  }

  private async killProcess(pid: number): Promise<void> {
    if (this.platform === 'wsl2') await runProcess('wsl.exe', ['--exec', 'kill', '-KILL', String(pid)]);
    else await runProcess('kill', ['-KILL', String(pid)]);
  }
}

const NAMESPACE_SCRIPT = String.raw`set -eu
decode() { printf '%s' "$1" | base64 -d; }
workspace=$(decode "$1")
shift
requested_mode=$(decode "$1")
root=$(mktemp -d)
cleanup() { umount -l -R "$root" 2>/dev/null || true; rm -rf "$root" 2>/dev/null || true; }
trap cleanup EXIT INT TERM
mount -t tmpfs tmpfs "$root"
mkdir -p "$root/usr" "$root/proc" "$root/tmp" "$root/workspace"
mount --rbind /usr "$root/usr"; mount -o remount,ro,bind "$root/usr"
ln -s usr/lib "$root/lib"
ln -s usr/lib64 "$root/lib64"
mount --rbind "$workspace" "$root/workspace"
if [ "$requested_mode" != create_file ] && [ "$requested_mode" != edit_file ] && [ "$requested_mode" != bash ]; then mount -o remount,ro,bind "$root/workspace"; fi
mount -t proc proc "$root/proc"
cat > "$root/tmp/worker.sh" <<'WEAVE_WORKER'
set -eu
decode() { printf '%s' "$1" | base64 -d; }
mode=$(decode "$1")
shift
safe_base() {
  value=$(decode "$1")
  case "$value" in /*|*..*|*'\'*) echo 'PATH_OUTSIDE_BOUNDARY' >&2; exit 41;; esac
  target=$(realpath -e "/workspace/$value" 2>/tmp/path-error) || { echo 'PATH_NOT_FOUND' >&2; exit 42; }
  case "$target" in /workspace|/workspace/*) printf '%s' "$target";; *) echo 'PATH_OUTSIDE_BOUNDARY' >&2; exit 41;; esac
}
if [ "$mode" = cleanup_probe ]; then
  token=$(decode "$1")
  case "$token" in weave-cleanup-[A-Za-z0-9-]*) ;; *) exit 46;; esac
  : > /tmp/probe-null
  /usr/bin/bash -c 'exec -a "$1" /usr/bin/sleep 300' _ "$token" </tmp/probe-null >/tmp/probe-null 2>&1 &
  wait
  exit 47
fi
if [ "$mode" = probe ]; then
  probe() { printf '%s=%s\n' "$1" "$2"; }
  : > /tmp/probe-null
  if [ "$(id -u)" -eq 0 ] && /usr/bin/grep -q '^Uid:[[:space:]]*0' /proc/self/status; then probe process_identity passed; else probe process_identity failed; fi
  if [ ! -e /etc/passwd ]; then probe host_paths_hidden passed; else probe host_paths_hidden failed; fi
  if /usr/bin/bash -c 'exec 3<>/dev/tcp/1.1.1.1/80' 2>/tmp/probe-null; then probe raw_network_blocked failed; else probe raw_network_blocked passed; fi
  if [ "$(/usr/bin/env | /usr/bin/grep -Evc '^(PATH=|PWD=|SHLVL=|_=)' || true)" -eq 0 ]; then probe environment_cleared passed; else probe environment_cleared failed; fi
  if [ ! -e /dev/null ]; then probe devices_hidden passed; else probe devices_hidden failed; fi
  if [ ! -e /etc/sudoers ]; then probe privilege_escalation_blocked passed; else probe privilege_escalation_blocked failed; fi
  limit=$(ulimit -u 2>/tmp/probe-null || printf unlimited)
  case "$limit" in *[!0-9]*|'') probe resource_limits failed;; *) if [ "$limit" -le 128 ]; then probe resource_limits passed; else probe resource_limits failed; fi;; esac
  probe process_tree_cleanup pending
  if [ ! -e /run/weave-control ]; then probe control_ipc_hidden passed; else probe control_ipc_hidden failed; fi
  if [ ! -e /run/weave-broker ]; then probe brokers_hidden passed; else probe brokers_hidden failed; fi
  if [ ! -e /mnt/c ]; then probe wsl_windows_mount_hidden passed; else probe wsl_windows_mount_hidden failed; fi
  if [ "$(/usr/bin/env | /usr/bin/grep -c '^WSL_INTEROP=' || true)" -eq 0 ]; then probe wsl_interop_hidden passed; else probe wsl_interop_hidden failed; fi
  if command -v cmd.exe >/tmp/probe-null 2>&1; then probe wsl_windows_path_hidden failed; else probe wsl_windows_path_hidden passed; fi
  if /usr/bin/python3 --version >/tmp/probe-null 2>&1; then probe write_worker_runtime passed; else probe write_worker_runtime failed; fi
  if /usr/bin/python3 -c 'import os; open("/tmp/replace-a", "wb").write(b"a"); open("/tmp/replace-b", "wb").write(b"b"); os.replace("/tmp/replace-b", "/tmp/replace-a"); assert open("/tmp/replace-a", "rb").read() == b"b"' >/tmp/probe-null 2>&1; then probe atomic_replace passed; else probe atomic_replace failed; fi
  if /usr/bin/bash --noprofile --norc -c 'exit 0' >/tmp/probe-null 2>&1; then probe bash_runtime passed; else probe bash_runtime failed; fi
  if /usr/bin/timeout 1 /usr/bin/bash -c 'exit 0' >/tmp/probe-null 2>&1; then probe timeout_runtime passed; else probe timeout_runtime failed; fi
  exit 0
fi
case "$mode" in
  read_file)
    base=$(safe_base "$1")
    [ -f "$base" ] || { echo 'PATH_NOT_FILE' >&2; exit 43; }
    [ "$(stat -c %h "$base")" -eq 1 ] || { echo 'HARDLINK_UNSAFE' >&2; exit 44; }
    cat -- "$base"
    ;;
  glob)
    base=$(safe_base "$1")
    find -P "$base" -xdev \( -name .git -o -name node_modules -o -name .weave \) -prune -o -type f -links 1 -printf '%P\0'
    ;;
  grep)
    base=$(safe_base "$1")
    shift
    pattern=$(decode "$1"); sensitive=$(decode "$2")
    if [ "$sensitive" = 1 ]; then caseflag=''; else caseflag='-i'; fi
    find -P "$base" -xdev \( -name .git -o -name node_modules -o -name .weave \) -prune -o -type f -links 1 -exec grep -I -F $caseflag -Z -n -H -- "$pattern" {} +
    ;;
  create_file|edit_file)
    decode "$1" > /tmp/action-path
    decode "$2" > /tmp/action-input
    /usr/bin/python3 /tmp/write-worker.py "$mode" /tmp/action-path /tmp/action-input
    ;;
  bash)
    base=$(safe_base "$1")
    [ -d "$base" ] || { echo 'PATH_NOT_DIRECTORY' >&2; exit 43; }
    decode "$2" > /tmp/bash-command
    timeout_ms=$(decode "$3")
    /usr/bin/python3 /tmp/bash-worker.py "$base" /tmp/bash-command "$timeout_ms"
    ;;
  *) echo 'SANDBOX_CAPABILITY_UNAVAILABLE' >&2; exit 45;;
esac
WEAVE_WORKER
cat > "$root/tmp/write-worker.py" <<'WEAVE_WRITE_WORKER'
import json, os, pathlib, sys, tempfile

workspace = pathlib.Path('/workspace')
mode, path_file, input_file = sys.argv[1:]
relative = pathlib.PurePosixPath(pathlib.Path(path_file).read_text(encoding='utf-8'))
if relative.is_absolute() or not relative.parts or any(part in ('', '.', '..') for part in relative.parts):
    raise SystemExit('PATH_OUTSIDE_BOUNDARY')
target = workspace.joinpath(*relative.parts)

def require_inside(path):
    resolved = path.resolve(strict=True)
    if resolved != workspace and workspace not in resolved.parents:
        raise SystemExit('PATH_OUTSIDE_BOUNDARY')
    return resolved

if mode == 'create_file':
    if target.exists() or target.is_symlink():
        raise SystemExit('FILE_ALREADY_EXISTS')
    ancestor = target.parent
    missing = []
    while not ancestor.exists():
        missing.append(ancestor)
        ancestor = ancestor.parent
    require_inside(ancestor)
    target.parent.mkdir(parents=True, exist_ok=True)
    content = pathlib.Path(input_file).read_bytes()
    with target.open('xb') as output:
        output.write(content)
    print(json.dumps({'beforeBytes': 0, 'afterBytes': len(content), 'createdDirectories': [str(path.relative_to(workspace)).replace(os.sep, '/') for path in reversed(missing)]}))
else:
    resolved = require_inside(target)
    metadata = resolved.stat()
    if not resolved.is_file():
        raise SystemExit('NOT_A_FILE')
    if metadata.st_nlink != 1:
        raise SystemExit('HARDLINK_UNSAFE')
    before = resolved.read_bytes()
    if len(before) > 1024 * 1024:
        raise SystemExit('FILE_TOO_LARGE')
    try:
        text = before.decode('utf-8')
    except UnicodeDecodeError:
        raise SystemExit('INVALID_UTF8')
    edits = json.loads(pathlib.Path(input_file).read_text(encoding='utf-8'))
    for edit in edits:
        old, new = edit['oldText'], edit['newText']
        if not old or old == new:
            raise SystemExit('INVALID_ARGUMENT')
        if text.count(old) == 0:
            raise SystemExit('TEXT_NOT_FOUND')
        if text.count(old) != 1:
            raise SystemExit('AMBIGUOUS_MATCH')
        text = text.replace(old, new, 1)
    after = text.encode('utf-8')
    if len(after) > 1024 * 1024:
        raise SystemExit('FILE_TOO_LARGE')
    descriptor, temporary = tempfile.mkstemp(prefix='.weave-edit-', dir=resolved.parent)
    try:
        with os.fdopen(descriptor, 'wb') as output:
            output.write(after)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, resolved)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)
    print(json.dumps({'beforeBytes': len(before), 'afterBytes': len(after)}))
WEAVE_WRITE_WORKER
cat > "$root/tmp/bash-worker.py" <<'WEAVE_BASH_WORKER'
import base64, json, os, pathlib, resource, signal, subprocess, sys, tempfile, time

cwd, command_file, timeout_ms = sys.argv[1], sys.argv[2], int(sys.argv[3])
command = pathlib.Path(command_file).read_text(encoding='utf-8')
started = time.monotonic()

def limits():
    resource.setrlimit(resource.RLIMIT_NPROC, (128, 128))
    resource.setrlimit(resource.RLIMIT_FSIZE, (64 * 1024, 64 * 1024))

with tempfile.TemporaryFile() as stdin_file, tempfile.TemporaryFile() as stdout_file, tempfile.TemporaryFile() as stderr_file:
    process = subprocess.Popen(
        ['/usr/bin/bash', '--noprofile', '--norc', '-c', command], cwd=cwd,
        env={'PATH': '/usr/bin:/bin', 'CI': '1'}, stdin=stdin_file,
        stdout=stdout_file, stderr=stderr_file, start_new_session=True, preexec_fn=limits,
    )
    timed_out = False
    try:
        process.wait(timeout=timeout_ms / 1000)
    except subprocess.TimeoutExpired:
        timed_out = True
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
    limit = 64 * 1024
    stdout_file.seek(0); stdout = stdout_file.read(limit)
    stderr_file.seek(0); stderr = stderr_file.read(limit)
    truncated = len(stdout) == limit or len(stderr) == limit
result = {
    'stdout': base64.b64encode(stdout[:limit]).decode('ascii'),
    'stderr': base64.b64encode(stderr[:limit]).decode('ascii'),
    'exitCode': -1 if timed_out else process.returncode,
    'durationMs': int((time.monotonic() - started) * 1000),
    'timedOut': timed_out,
    'truncated': truncated,
}
print(json.dumps(result))
WEAVE_BASH_WORKER
chmod 500 "$root/tmp/worker.sh"
chmod 400 "$root/tmp/write-worker.py"
chmod 400 "$root/tmp/bash-worker.py"
ulimit -u 128
chroot "$root" /usr/bin/env -i PATH=/usr/bin:/bin /usr/bin/bash /tmp/worker.sh "$@"
`;

export function linuxReadToolDefinitions(): readonly ToolDefinition[] {
  const common = { resultSchema: { type: 'object' }, worksWith: [], executionMode: 'read_shared' as const };
  return Object.freeze([
    { name: 'read_file', purpose: 'Read a UTF-8 workspace file', useWhen: ['inspect file'], avoidWhen: ['binary file'], inputSchema: { type: 'object', required: ['path'] }, ...common },
    { name: 'glob', purpose: 'Find workspace files by glob', useWhen: ['find files'], avoidWhen: ['search content'], inputSchema: { type: 'object', required: ['pattern'] }, ...common },
    { name: 'grep', purpose: 'Search literal text in workspace files', useWhen: ['search content'], avoidWhen: ['regex'], inputSchema: { type: 'object', required: ['pattern'] }, ...common },
    { name: 'create_file', purpose: 'Create a UTF-8 workspace file', useWhen: ['create file'], avoidWhen: ['file exists'], inputSchema: { type: 'object', required: ['path', 'content'] }, ...common, executionMode: 'write_exclusive' as const },
    { name: 'edit_file', purpose: 'Apply unique exact text edits', useWhen: ['edit file'], avoidWhen: ['ambiguous match'], inputSchema: { type: 'object', required: ['path', 'edits'] }, ...common, executionMode: 'write_exclusive' as const },
    { name: 'bash', purpose: 'Run an isolated non-interactive Bash command', useWhen: ['run process'], avoidWhen: ['dedicated tool exists'], inputSchema: { type: 'object', required: ['command'] }, ...common, executionMode: 'write_exclusive' as const },
  ]);
}

async function runProcess(
  executable: string,
  args: readonly string[],
  stdin?: string,
  signal?: AbortSignal,
  terminate?: () => Promise<void>,
): Promise<NamespaceExecution> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const abort = () => {
      if (terminate === undefined) { child.kill('SIGKILL'); return; }
      const deadline = new Promise<void>((resolveTimeout) => {
        const timer = setTimeout(resolveTimeout, 2_000);
        timer.unref();
      });
      void Promise.race([terminate().catch(() => undefined), deadline]).finally(() => child.kill('SIGKILL'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_SCAN_BYTES) stdout.push(chunk);
      else child.kill('SIGKILL');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 64 * 1024) stderr.push(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort);
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode: code ?? 1 });
    });
    child.stdin.end(stdin);
  });
}

function parseProbeOutput(output: string): Map<string, string> {
  return new Map(output.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const index = line.indexOf('=');
    return index < 0 ? [line, 'invalid'] : [line.slice(0, index), line.slice(index + 1)];
  }));
}

async function waitForProcessIds(probe: () => Promise<readonly number[]>, timeoutMs: number): Promise<readonly number[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const processIds = await probe();
    if (processIds.length > 0) return processIds;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return [];
}

async function waitForProcessesGone(
  processIds: readonly number[],
  exists: (pid: number) => Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const present = await Promise.all(processIds.map(exists));
    if (present.every((value) => !value)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

function evidenceDigest(probeId: string, status: string): string {
  return `evidence:v1:${createHash('sha256').update(`${BACKEND_VERSION}\0${probeId}\0${status}`).digest('base64url')}`;
}

function parseGrep(output: Buffer, glob: string | undefined): { path: string; line: number; text: string }[] {
  const matches: { path: string; line: number; text: string }[] = [];
  let offset = 0;
  while (offset < output.length && matches.length < MAX_RESULTS) {
    const separator = output.indexOf(0, offset);
    if (separator < 0) break;
    const path = normalizeRelative(output.subarray(offset, separator).toString('utf8'));
    const newline = output.indexOf(10, separator + 1);
    const end = newline < 0 ? output.length : newline;
    const line = output.subarray(separator + 1, end).toString('utf8');
    const colon = line.indexOf(':');
    const lineNumber = Number(line.slice(0, colon));
    if (colon > 0 && Number.isInteger(lineNumber) && (glob === undefined || minimatch(path, glob, { dot: false }))) {
      matches.push({ path, line: lineNumber, text: line.slice(colon + 1, colon + 501) });
    }
    offset = end + 1;
  }
  return matches.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line);
}

function inputRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Tool input must be an object');
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/.test(value)) throw new TypeError(`${field} must be a non-empty single-line string`);
  return value;
}

function requiredStringAllowEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || /[\0]/.test(value)) throw new TypeError(`${field} must be a string without NUL bytes`);
  return value;
}

function optionalString(value: unknown, fallback: string): string { return value === undefined ? fallback : requiredString(value, 'path'); }

function optionalPositiveInteger(value: unknown, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < 1) throw new TypeError(`${field} must be a positive integer`);
  return value as number;
}

function normalizeRelative(value: string): string { return value.replace(/^\/workspace\/?/, '').replaceAll('\\', '/').replace(/^\.\//, ''); }

function joinRelative(base: string, value: string): string {
  const normalizedBase = normalizeRelative(base);
  const normalizedValue = normalizeRelative(value);
  return normalizedBase === '.' || normalizedBase === '' ? normalizedValue : `${normalizedBase.replace(/\/$/, '')}/${normalizedValue}`;
}

function success(call: ActionWorkerLaunchInput['call'], summary: string, data: unknown): ToolCallResult {
  return { callId: call.callId, providerCallId: call.providerCallId, toolName: call.name, isError: false, content: { summary, data } };
}

function failure(call: ActionWorkerLaunchInput['call'], code: string, message: string): ToolCallResult {
  return { callId: call.callId, providerCallId: call.providerCallId, toolName: call.name, isError: true, content: { summary: message, error: { code, message, retryable: false } } };
}

function failureWithData(call: ActionWorkerLaunchInput['call'], code: string, message: string, data: unknown): ToolCallResult {
  return {
    callId: call.callId, providerCallId: call.providerCallId, toolName: call.name, isError: true,
    content: { summary: message, data, error: { code, message, retryable: false } },
  };
}

function errorCode(execution: NamespaceExecution): string {
  const text = execution.stderr.toString('utf8');
  return /^(PATH_[A-Z_]+|HARDLINK_UNSAFE|SANDBOX_CAPABILITY_UNAVAILABLE|FILE_ALREADY_EXISTS|NOT_A_FILE|FILE_TOO_LARGE|INVALID_UTF8|INVALID_ARGUMENT|TEXT_NOT_FOUND|AMBIGUOUS_MATCH)/m.exec(text)?.[1] ?? 'SANDBOX_EXECUTION_FAILED';
}

function safeStderr(execution: NamespaceExecution): string {
  const code = errorCode(execution);
  return code === 'SANDBOX_EXECUTION_FAILED' ? `Sandbox command failed with status ${execution.exitCode}` : code;
}

function safeMessage(error: unknown): string { return error instanceof Error ? error.message : 'Sandbox execution failed'; }

function errorCodeFromUnknown(error: unknown): string {
  const message = safeMessage(error);
  return /^(RECOVERY_CONFLICT|FILE_CHANGED_DURING_EDIT|PERMISSION_DENIED|PATH_OUTSIDE_WORKSPACE)/.exec(message)?.[1]
    ?? 'TRANSACTION_COMMIT_FAILED';
}
