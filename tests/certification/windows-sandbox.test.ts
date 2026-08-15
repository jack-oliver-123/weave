import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { AgentLoop } from '../../src/engine/agent-loop.js';
import {
  createCertifiedWindowsRunnerRuntime,
  HostWindowsSandboxCli,
  REQUIRED_SANDBOX_PROBES,
  TaskWorkspaceView,
  WindowsJobObjectWorker,
  WindowsSandboxTaskVm,
  windowsPlatformProbeScript,
  probeWindowsSandbox,
  type ProbeEvidence,
  type WindowsPlatformFacts,
} from '../../src/runner/index.js';
import {
  ActionGatewayImpl,
  type ModelProviderTaskResource,
  type OpenActionTaskInput,
  type SecurityAuditRecord,
} from '../../src/security/index.js';
import type {
  AgentEvent,
  ModelExchangeInput,
  ModelExchangeResponse,
  ToolCallRequest,
} from '../../src/shared/types.js';
import type { ActionWorkerLaunchInput } from '../../src/runner/supervisor.js';

const suite = describe.runIf(process.env.WEAVE_BACKEND_CERTIFICATION === 'windows-sandbox');
const slice = process.env.WEAVE_WINDOWS_CERTIFICATION_SLICE ?? 'read';
const cleanup: Array<() => Promise<void>> = [];

afterAll(async () => {
  for (const operation of cleanup.reverse()) await operation();
});

suite('Windows Sandbox certification', () => {
  it.runIf(slice === 'read')('certifies the hardened Worker matrix and AgentLoop-to-OS read slice', async () => {
    trace('read:start');
    const cli = new HostWindowsSandboxCli();
    const facts = await windowsFacts();
    const commit = process.env.GITHUB_SHA ?? 'working-tree';
    const platformEvidence = await probeWindowsSandbox(facts, cli, commit);
    const backendVersion = platformEvidence.find((item) => item.probeId === 'windows_sandbox_cli')!.backendVersion;
    expect(platformEvidence.map((item) => [item.probeId, item.status])).toEqual([
      ['windows_11_24h2', 'passed'],
      ['windows_sandbox_feature', 'passed'],
      ['windows_sandbox_cli', 'passed'],
    ]);

    const workspace = await createWorkspace();
    cleanup.push(() => rm(workspace, { recursive: true, force: true }));
    const isolation = await certifyIsolation(workspace, cli, facts, commit, backendVersion);
    trace('read:isolation-certified');
    expect(
      REQUIRED_SANDBOX_PROBES.map((id) => isolation.find((item) => item.probeId === id)?.status),
      JSON.stringify(Object.fromEntries(isolation.map((item) => [item.probeId, item.status]))),
    )
      .toEqual(REQUIRED_SANDBOX_PROBES.map(() => 'passed'));
    expect(isolation.find((item) => item.probeId === 'windows_registry_hidden')?.status).toBe('passed');

    const readEvidence = [
      ...isolation,
      evidence('windows_read_tools', 'passed', facts, commit, backendVersion),
    ];
    const runtime = await createCertifiedWindowsRunnerRuntime(workspace, {
      facts,
      certificationEvidence: readEvidence,
      commit,
      cli,
    });
    expect(runtime.backend).toBe('windows-sandbox');
    expect(runtime.capabilityReport.capabilities).toEqual(['FilesystemRead']);

    const provider = new CertificationProvider(readCalls());
    const audit = new CertificationAudit();
    let id = 0;
    const gateway = new ActionGatewayImpl({
      provider,
      runner: runtime.runner,
      audit,
      createId: () => `windows-cert-${++id}`,
      now: Date.now,
    });
    const task = await gateway.openTask(taskInput(workspace));
    trace('read:action-task-opened');
    const events: AgentEvent[] = [];
    try {
      for await (const event of new AgentLoop(task).run({
        taskId: 'windows-cert-task', runId: 'windows-cert-run', kind: 'react',
        task: 'Inspect the workspace', signal: new AbortController().signal,
      })) {
        trace(`read:event:${event.type}`);
        events.push(event);
        if (event.type === 'authorization_requested') {
          task.resolveAuthorization({
            type: 'resolve_authorization', taskId: event.request.taskId, runId: event.request.runId,
            authorizationRequestId: event.request.authorizationRequestId,
            authorizationEpoch: event.request.authorizationEpoch,
            decisions: event.request.items.map((item) => ({ actionDigest: item.actionDigest, choice: 'allow_once' })),
          });
        }
      }
    } finally {
      trace('read:action-task-closing');
      await task.close('completed');
      trace('read:action-task-closed');
    }
    const completed = events.filter((event) => event.type === 'tool_call_completed');
    expect(
      completed.map((event) => [event.toolName, event.result.isError]),
      JSON.stringify(completed.map((event) => ({ toolName: event.toolName, content: event.result.content }))),
    ).toEqual([
      ['read_file', false], ['glob', false], ['grep', false],
    ]);
    const disclosed = JSON.stringify(provider.inputs[1]?.messages);
    expect(disclosed).toContain('windows-certification-marker');
    expect(disclosed).not.toContain('excluded-marker');
    expect(audit.records.filter((record) => record.phase === 'supervisor')).toHaveLength(3);
  }, 300_000);

  it.runIf(slice === 'transactional-write')('certifies transactional create and edit through the Windows Task VM', async () => {
    const cli = new HostWindowsSandboxCli();
    const facts = await windowsFacts();
    const commit = process.env.GITHUB_SHA ?? 'working-tree';
    const platformEvidence = await probeWindowsSandbox(facts, cli, commit);
    expect(platformEvidence.every((item) => item.status === 'passed')).toBe(true);
    const backendVersion = platformEvidence.find((item) => item.probeId === 'windows_sandbox_cli')!.backendVersion;
    const workspace = await createWorkspace();
    cleanup.push(() => rm(workspace, { recursive: true, force: true }));
    const isolation = await certifyIsolation(workspace, cli, facts, commit, backendVersion);
    const runtime = await createCertifiedWindowsRunnerRuntime(workspace, {
      facts,
      certificationEvidence: [
        ...isolation,
        evidence('windows_read_tools', 'passed', facts, commit, backendVersion),
        evidence('windows_transactional_write', 'passed', facts, commit, backendVersion),
      ],
      commit,
      cli,
    });
    expect(runtime.capabilityReport.capabilities).toEqual(['FilesystemRead', 'FilesystemWrite']);
    const provider = new CertificationProvider([
      { callId: 'create', providerCallId: 'provider-create', name: 'create_file', input: { path: 'created.txt', content: 'created in windows sandbox\n' } },
      { callId: 'edit', providerCallId: 'provider-edit', name: 'edit_file', input: { path: 'alpha.txt', edits: [{ oldText: 'windows-certification-marker', newText: 'windows-transaction-marker' }] } },
    ]);
    const events = await runAgentLoop(runtime, provider, workspace, 'windows-write');
    const completed = events.filter((event) => event.type === 'tool_call_completed');
    expect(
      completed.map((event) => event.result.isError),
      JSON.stringify(completed.map((event) => ({ toolName: event.toolName, content: event.result.content }))),
    ).toEqual([false, false]);
    expect(await readFile(join(workspace, 'created.txt'), 'utf8')).toBe('created in windows sandbox\n');
    expect(await readFile(join(workspace, 'alpha.txt'), 'utf8')).toBe('windows-transaction-marker\n');
  }, 300_000);

  it.runIf(slice === 'structured-process')('certifies a fixed executable and argv inside the hardened Worker job', async () => {
    const cli = new HostWindowsSandboxCli();
    const facts = await windowsFacts();
    expect((await probeWindowsSandbox(facts, cli)).every((item) => item.status === 'passed')).toBe(true);
    const workspace = await createWorkspace();
    cleanup.push(() => rm(workspace, { recursive: true, force: true }));
    const outcome = await executeDirectCall(workspace, cli, 'weave_certification_structured_process');
    expect(outcome.isError).toBe(false);
    expect(outcome.content.data).toMatchObject({ exitCode: 0 });
  }, 180_000);

  it.runIf(slice === 'bash')('records Bash as unavailable unless a real noninteractive Bash runs in the VM', async () => {
    const cli = new HostWindowsSandboxCli();
    const facts = await windowsFacts();
    expect((await probeWindowsSandbox(facts, cli)).every((item) => item.status === 'passed')).toBe(true);
    const workspace = await createWorkspace();
    cleanup.push(() => rm(workspace, { recursive: true, force: true }));
    const outcome = await executeDirectCall(workspace, cli, 'weave_certification_bash_probe');
    expect(outcome.isError).toBe(false);
    expect(outcome.content.data).toMatchObject({ available: false });
  }, 180_000);
});

async function executeDirectCall(
  workspace: string,
  cli: HostWindowsSandboxCli,
  name: string,
) {
  const view = await TaskWorkspaceView.create(workspace);
  const vm = await WindowsSandboxTaskVm.start(cli, {
    taskId: `${name}-task`, sandboxId: randomUUID(), budget: certificationBudget(20_000),
    baselinePath: workspace, cowPath: view.root,
  });
  const worker = new WindowsJobObjectWorker({
    vm, cowHostRoot: view.root,
    input: directWorkerInput(name, {}, certificationBudget(20_000)),
    createId: () => `${name.replaceAll('_', '-')}-worker`,
  });
  try {
    return (await worker.execute(new AbortController().signal)).result;
  } finally {
    await Promise.allSettled([worker.close(), vm.stop(), view.close()]);
  }
}

async function runAgentLoop(
  runtime: Awaited<ReturnType<typeof createCertifiedWindowsRunnerRuntime>>,
  provider: CertificationProvider,
  workspace: string,
  prefix: string,
): Promise<AgentEvent[]> {
  const audit = new CertificationAudit();
  let id = 0;
  const gateway = new ActionGatewayImpl({
    provider, runner: runtime.runner, audit,
    createId: () => `${prefix}-${++id}`, now: Date.now,
  });
  const task = await gateway.openTask({ ...taskInput(workspace), taskId: `${prefix}-task` });
  const events: AgentEvent[] = [];
  try {
    for await (const event of new AgentLoop(task).run({
      taskId: `${prefix}-task`, runId: `${prefix}-run`, kind: 'react',
      task: 'Run the Windows certification slice', signal: new AbortController().signal,
    })) {
      events.push(event);
      if (event.type === 'authorization_requested') {
        task.resolveAuthorization({
          type: 'resolve_authorization', taskId: event.request.taskId, runId: event.request.runId,
          authorizationRequestId: event.request.authorizationRequestId,
          authorizationEpoch: event.request.authorizationEpoch,
          decisions: event.request.items.map((item) => ({ actionDigest: item.actionDigest, choice: 'allow_once' })),
        });
      }
    }
  } finally {
    await task.close('completed');
  }
  return events;
}

async function certifyIsolation(
  workspace: string,
  cli: HostWindowsSandboxCli,
  facts: WindowsPlatformFacts,
  commit: string,
  backendVersion: string,
): Promise<ProbeEvidence[]> {
  trace('isolation:view-creating');
  const view = await TaskWorkspaceView.create(workspace);
  trace('isolation:vm-starting');
  const vm = await WindowsSandboxTaskVm.start(cli, {
    taskId: 'windows-isolation-task', sandboxId: randomUUID(), budget: certificationBudget(20_000),
    baselinePath: workspace, cowPath: view.root,
  });
  trace('isolation:vm-started');
  try {
    const canaryDirectory = await mkdtemp(join(tmpdir(), 'weave-host-canary-'));
    cleanup.push(() => rm(canaryDirectory, { recursive: true, force: true }));
    const registryId = `WeaveCertification\\${randomUUID()}`;
    await promisify(execFile)('reg.exe', ['ADD', `HKCU\\Software\\${registryId}`, '/v', 'Canary', '/t', 'REG_SZ', '/d', 'host-only', '/f']);
    cleanup.push(async () => { await promisify(execFile)('reg.exe', ['DELETE', `HKCU\\Software\\${registryId}`, '/f']).catch(() => undefined); });
    const pipeName = `weave-host-${randomUUID()}`;
    const pipe = createServer();
    await new Promise<void>((resolve, reject) => pipe.once('error', reject).listen(`\\\\.\\pipe\\${pipeName}`, resolve));
    cleanup.push(() => new Promise<void>((resolve) => pipe.close(() => resolve())));
    const environmentName = `WEAVE_HOST_SECRET_${randomUUID().replaceAll('-', '')}`;
    process.env[environmentName] = 'host-only';
    cleanup.push(async () => { delete process.env[environmentName]; });
    const { stdout: volumeOutput } = await promisify(execFile)('mountvol.exe', ['C:', '/L']);
    const hostDeviceCanary = volumeOutput.trim().replace(/[\\/]+$/, '');
    expect(hostDeviceCanary).toMatch(/^\\\\\?\\Volume\{[0-9a-f-]+\}$/i);

    const probeWorker = new WindowsJobObjectWorker({
      vm,
      cowHostRoot: view.root,
      input: directWorkerInput('weave_certification_probe', {
        hostPathCanary: canaryDirectory,
        hostRegistryCanary: `Registry::HKEY_CURRENT_USER\\Software\\${registryId}`,
        hostEnvironmentCanary: environmentName,
        hostPipeCanary: pipeName,
        hostDeviceCanary,
      }, certificationBudget(20_000)),
      createId: () => 'isolation-probe',
    });
    trace('isolation:matrix-starting');
    const probeOutcome = await probeWorker.execute(new AbortController().signal);
    trace('isolation:matrix-finished');
    await probeWorker.close();
    expect(probeOutcome.result.isError, JSON.stringify(probeOutcome.result.content)).toBe(false);
    const data = probeOutcome.result.content.data as { probes: Record<string, string>; processTreePid: number };

    const cleanupWorker = new WindowsJobObjectWorker({
      vm,
      cowHostRoot: view.root,
      input: directWorkerInput('weave_certification_process_absent', { pid: data.processTreePid }, certificationBudget(20_000)),
      createId: () => 'cleanup-probe',
    });
    trace('isolation:cleanup-starting');
    const cleanupOutcome = await cleanupWorker.execute(new AbortController().signal);
    trace('isolation:cleanup-finished');
    await cleanupWorker.close();
    expect((cleanupOutcome.result.content.data as { absent: boolean }).absent).toBe(true);
    data.probes.process_tree_cleanup = 'passed';

    const timeoutWorker = new WindowsJobObjectWorker({
      vm,
      cowHostRoot: view.root,
      input: directWorkerInput('weave_certification_timeout', {}, certificationBudget(750)),
      createId: () => 'timeout-probe',
    });
    trace('isolation:timeout-starting');
    const timeoutOutcome = await timeoutWorker.execute(new AbortController().signal);
    trace('isolation:timeout-finished');
    await timeoutWorker.close();
    expect(timeoutOutcome.result.content.error?.code).toBe('TOOL_TIMEOUT');
    if (data.probes.resource_limits === 'passed') data.probes.resource_limits = 'passed';

    return Object.entries(data.probes).map(([probeId, status]) => evidence(
      probeId,
      status === 'passed' ? 'passed' : 'failed',
      facts,
      commit,
      backendVersion,
    ));
  } finally {
    trace('isolation:closing');
    await Promise.allSettled([vm.stop(), view.close()]);
    trace('isolation:closed');
  }
}

function trace(stage: string): void {
  if (process.env.WEAVE_CERTIFICATION_TRACE === '1') {
    console.error(`[windows-certification] ${new Date().toISOString()} ${stage}`);
  }
}

function directWorkerInput(name: string, input: Record<string, unknown>, budget: ReturnType<typeof certificationBudget>): ActionWorkerLaunchInput {
  return {
    taskId: 'windows-isolation-task', runId: 'windows-isolation-run',
    call: { callId: `${name}-call`, providerCallId: `${name}-provider`, name, input },
    action: {
      schemaVersion: 1, actionId: `${name}-action`, actionType: name, input: input as never, digest: `${name}-digest`,
      manifest: { schemaVersion: 1, requirements: [{ type: 'FilesystemRead', paths: ['.'] }] },
    },
    profile: {
      ...budget,
      filesystemRead: ['.'], filesystemWrite: [], networkEnabled: false,
      environment: {}, controlChannelVisible: false, ticketVisible: false,
    },
  };
}

function certificationBudget(actionTimeoutMs: number) {
  return {
    cpuCores: 1, memoryBytes: 256 * 1024 ** 2, pids: 4, actionTimeoutMs,
    taskProcessTimeoutMs: 60_000, diskBytes: 16 * 1024 ** 2,
    stdoutBytes: 64 * 1024, stderrBytes: 64 * 1024,
    batchOutputBytes: 512 * 1024, networkBytes: 1024,
  };
}

async function windowsFacts(): Promise<WindowsPlatformFacts> {
  const { stdout } = await promisify(execFile)('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', windowsPlatformProbeScript(),
  ], { windowsHide: true });
  const value = JSON.parse(stdout) as {
    productName: string;
    build: number;
    featureState: WindowsPlatformFacts['featureState'];
    cliPackageIdentity?: string;
  };
  return { platform: process.platform, ...value };
}

function evidence(
  probeId: string,
  status: ProbeEvidence['status'],
  facts: WindowsPlatformFacts,
  commit: string,
  backendVersion: string,
): ProbeEvidence {
  return {
    probeId, status, commit, os: `${facts.platform}:build:${facts.build}`,
    backend: 'windows-sandbox', backendVersion,
    probeVersion: '1', evidenceDigest: `windows-cert:${probeId}:${status}`,
  };
}

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), 'weave-windows-cert-'));
  await writeFile(join(workspace, 'alpha.txt'), 'windows-certification-marker\n', 'utf8');
  await Promise.all([
    mkdir(join(workspace, '.git')),
    mkdir(join(workspace, 'node_modules')),
  ]);
  await writeFile(join(workspace, '.git', 'excluded.txt'), 'excluded-marker\n', 'utf8');
  await writeFile(join(workspace, 'node_modules', 'excluded.txt'), 'excluded-marker\n', 'utf8');
  return workspace;
}

class CertificationProvider {
  readonly resource: CertificationProviderResource;
  constructor(calls: readonly ToolCallRequest[]) { this.resource = new CertificationProviderResource(calls); }
  get inputs(): readonly ModelExchangeInput[] { return this.resource.inputs; }
  async openTask(): Promise<ModelProviderTaskResource> { return this.resource; }
}

class CertificationProviderResource implements ModelProviderTaskResource {
  readonly inputs: ModelExchangeInput[] = [];
  constructor(private readonly firstCalls: readonly ToolCallRequest[]) {}
  async exchange(input: ModelExchangeInput): Promise<ModelExchangeResponse> {
    this.inputs.push(structuredClone(input));
    return {
      text: '',
      calls: this.inputs.length === 1 ? this.firstCalls : [{
        callId: 'complete', providerCallId: 'provider-complete', name: 'complete_task',
        input: { result: 'done', verificationSummary: 'windows sandbox certified' },
      }],
      completion: { type: 'stream_complete', finishReason: 'stop' },
      audit: {
        promptVersion: 'certification', stableHash: 'stable', assemblyHash: 'assembly', modules: [], fragments: [],
        protocol: input.destination.protocol, model: input.destination.model,
      },
    };
  }
  async close(): Promise<void> {}
}

class CertificationAudit {
  readonly records: SecurityAuditRecord[] = [];
  async openTask() {
    return {
      append: async (records: readonly SecurityAuditRecord[]) => { this.records.push(...structuredClone(records)); },
      close: async () => undefined,
    };
  }
}

function readCalls(): readonly ToolCallRequest[] {
  return [
    { callId: 'read', providerCallId: 'provider-read', name: 'read_file', input: { path: 'alpha.txt' } },
    { callId: 'glob', providerCallId: 'provider-glob', name: 'glob', input: { path: '.', pattern: '**/*.txt' } },
    { callId: 'grep', providerCallId: 'provider-grep', name: 'grep', input: { path: '.', pattern: 'windows-certification-marker' } },
  ];
}

function taskInput(workspaceRoot: string): OpenActionTaskInput {
  return {
    schemaVersion: 1, taskId: 'windows-cert-task', policySnapshotId: 'windows-cert-policy',
    permissionMode: 'supervised',
    modelDestination: {
      profile: 'certification', protocol: 'openai-responses', model: 'fake-model',
      origin: 'https://provider.invalid', credentialRef: 'credential:certification',
    },
    pathBoundary: { readRoots: ['.'], writeRoots: ['.'] }, workspaceRoot,
    authorizationEpoch: 1, toolsEnabled: true,
    modelContext: { messages: [], currentUserInput: 'Inspect the workspace', maxTokens: 100 },
  };
}
