import { link, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../../src/engine/agent-loop.js';
import { createCertifiedReadRunnerRuntime } from '../../src/runner/index.js';
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

const certificationTarget = process.env.WEAVE_BACKEND_CERTIFICATION;
const suite = describe.runIf(certificationTarget === 'linux' || certificationTarget === 'wsl2');

suite('Linux/WSL2 read-tool certification', () => {
  it('runs the AgentLoop-to-OS slice and discloses ordered results only through the next model exchange', async () => {
    const workspace = await createWorkspace();
    const runtime = await createCertifiedReadRunnerRuntime(workspace);
    expect(runtime.capabilityReport.capabilities).toEqual(['FilesystemRead', 'FilesystemWrite', 'ProcessSpawn']);
    expect(runtime.capabilityReport.evidence.every((item) => item.status === 'passed')).toBe(true);

    const provider = new CertificationProvider(calls());
    const audit = new CertificationAudit();
    let id = 0;
    const gateway = new ActionGatewayImpl({
      provider,
      runner: runtime.runner,
      audit,
      createId: () => `cert-id-${++id}`,
      now: Date.now,
    });
    const task = await gateway.openTask(taskInput(workspace));
    const events: AgentEvent[] = [];
    try {
      for await (const event of new AgentLoop(task).run({
        taskId: 'cert-task', runId: 'cert-run', kind: 'react', task: 'Inspect the workspace',
        signal: new AbortController().signal,
      })) {
        events.push(event);
        if (event.type === 'authorization_requested') {
          task.resolveAuthorization({
            type: 'resolve_authorization', taskId: event.request.taskId,
            runId: event.request.runId,
            authorizationRequestId: event.request.authorizationRequestId,
            authorizationEpoch: event.request.authorizationEpoch,
            decisions: event.request.items.map((item) => ({ actionDigest: item.actionDigest, choice: 'allow_once' })),
          });
        }
      }
    } finally {
      await task.close('completed');
    }

    const completed = events.filter((event) => event.type === 'tool_call_completed');
    expect(completed.map((event) => event.toolName)).toEqual([
      'read_file', 'glob', 'grep', 'create_file', 'edit_file', 'bash', 'bash', 'bash', 'bash',
    ]);
    expect(completed.map((event) => ({
      toolName: event.toolName,
      isError: event.result.isError,
      errorCode: event.result.content.error?.code,
    }))).toEqual([
      { toolName: 'read_file', isError: false, errorCode: undefined },
      { toolName: 'glob', isError: false, errorCode: undefined },
      { toolName: 'grep', isError: false, errorCode: undefined },
      { toolName: 'create_file', isError: false, errorCode: undefined },
      { toolName: 'edit_file', isError: false, errorCode: undefined },
      { toolName: 'bash', isError: false, errorCode: undefined },
      { toolName: 'bash', isError: true, errorCode: 'COMMAND_FAILED' },
      { toolName: 'bash', isError: true, errorCode: 'TOOL_TIMEOUT' },
      { toolName: 'bash', isError: true, errorCode: 'COMMAND_FAILED' },
    ]);
    expect(await readFile(join(workspace, 'created', 'new.txt'), 'utf8')).toBe('created by worker\n');
    expect(await readFile(join(workspace, 'src', 'alpha.ts'), 'utf8')).toBe('const marker = "edited";\n');
    expect(await readFile(join(workspace, 'bash.txt'), 'utf8')).toBe('from bash\n');
    expect(await readFile(join(workspace, 'nonzero.txt'), 'utf8')).toBe('committed despite exit\n');
    await expect(readFile(join(workspace, 'timeout.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const outputLimited = completed.find((event) => event.result.callId === 'bash-output')!;
    expect(outputLimited.result.content.data).toMatchObject({ truncated: true });
    expect(provider.inputs).toHaveLength(2);
    const disclosed = JSON.stringify(provider.inputs[1]!.messages);
    expect(disclosed).toContain('const needle');
    expect(disclosed.indexOf('provider-read')).toBeLessThan(disclosed.indexOf('provider-glob'));
    expect(disclosed.indexOf('provider-glob')).toBeLessThan(disclosed.indexOf('provider-grep'));
    expect(disclosed).not.toContain('dependency.ts');
    expect(disclosed).not.toContain('hardlink.ts');
    expect(audit.records.map((record) => record.phase)).toEqual([
      'hitl', 'hitl', 'hitl', 'hitl', 'hitl', 'hitl',
      ...Array(9).fill('preflight'),
      ...Array(9).fill('supervisor'),
      ...Array(9).fill('outcome'),
    ]);
  }, 120_000);
});

class CertificationProvider {
  readonly resource: CertificationProviderResource;
  constructor(firstCalls: readonly ToolCallRequest[]) { this.resource = new CertificationProviderResource(firstCalls); }
  get inputs(): readonly ModelExchangeInput[] { return this.resource.inputs; }
  async openTask(): Promise<ModelProviderTaskResource> { return this.resource; }
}

class CertificationProviderResource implements ModelProviderTaskResource {
  readonly inputs: ModelExchangeInput[] = [];
  constructor(private readonly firstCalls: readonly ToolCallRequest[]) {}
  async exchange(input: ModelExchangeInput): Promise<ModelExchangeResponse> {
    this.inputs.push(structuredClone(input));
    const calls = this.inputs.length === 1 ? this.firstCalls : [{
      callId: 'complete', providerCallId: 'provider-complete', name: 'complete_task',
      input: { result: 'done', verificationSummary: 'certified' },
    }];
    return {
      text: '', calls, completion: { type: 'stream_complete', finishReason: 'stop' },
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

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), 'weave-wsl2-cert-'));
  await mkdir(join(workspace, 'src'));
  await mkdir(join(workspace, '.git'));
  await mkdir(join(workspace, 'node_modules'));
  await writeFile(join(workspace, 'src', 'alpha.ts'), 'const needle = "alpha";\n', 'utf8');
  await writeFile(join(workspace, 'src', 'hardlink-source.ts'), 'needle\n', 'utf8');
  await writeFile(join(workspace, 'src', 'binary.bin'), Buffer.from([0, 1, 2, 3]));
  await writeFile(join(workspace, '.git', 'secret.ts'), 'needle\n', 'utf8');
  await writeFile(join(workspace, 'node_modules', 'dependency.ts'), 'needle\n', 'utf8');
  await link(join(workspace, 'src', 'hardlink-source.ts'), join(workspace, 'src', 'hardlink.ts'));
  return workspace;
}

function calls(): readonly ToolCallRequest[] {
  return [
    { callId: 'read', providerCallId: 'provider-read', name: 'read_file', input: { path: 'src/alpha.ts' } },
    { callId: 'glob', providerCallId: 'provider-glob', name: 'glob', input: { path: '.', pattern: '**/*.ts' } },
    { callId: 'grep', providerCallId: 'provider-grep', name: 'grep', input: { path: '.', pattern: 'needle' } },
    { callId: 'create', providerCallId: 'provider-create', name: 'create_file', input: { path: 'created/new.txt', content: 'created by worker\n' } },
    { callId: 'edit', providerCallId: 'provider-edit', name: 'edit_file', input: { path: 'src/alpha.ts', edits: [
      { oldText: 'alpha', newText: 'edited' },
      { oldText: 'needle', newText: 'marker' },
    ] } },
    { callId: 'bash', providerCallId: 'provider-bash', name: 'bash', input: {
      command: "test -z \"${WSL_INTEROP-}\" && test ! -e /run/weave-control && test ! -e /run/weave-broker && ! command -v cmd.exe >/tmp/cmd-path 2>&1 && ! /usr/bin/bash -c 'exec 3<>/dev/tcp/1.1.1.1/80' 2>/tmp/network-error && printf 'from bash\\n' > bash.txt",
      cwd: '.',
    } },
    { callId: 'bash-nonzero', providerCallId: 'provider-bash-nonzero', name: 'bash', input: {
      command: "printf 'committed despite exit\\n' > nonzero.txt; exit 7", cwd: '.',
    } },
    { callId: 'bash-timeout', providerCallId: 'provider-bash-timeout', name: 'bash', input: {
      command: "printf 'discard me' > timeout.txt; sleep 2", cwd: '.', timeoutMs: 100,
    } },
    { callId: 'bash-output', providerCallId: 'provider-bash-output', name: 'bash', input: {
      command: "/usr/bin/python3 -c \"print('x' * 70000)\"", cwd: '.',
    } },
  ];
}

function taskInput(workspaceRoot: string): OpenActionTaskInput {
  return {
    schemaVersion: 1,
    taskId: 'cert-task',
    policySnapshotId: 'cert-policy',
    permissionMode: 'supervised',
    modelDestination: {
      profile: 'certification', protocol: 'openai-responses', model: 'fake-model',
      origin: 'https://provider.invalid', credentialRef: 'credential:certification',
    },
    pathBoundary: { readRoots: ['.'], writeRoots: ['.'] },
    workspaceRoot,
    authorizationEpoch: 1,
    toolsEnabled: true,
    modelContext: { messages: [], currentUserInput: 'Inspect the workspace', maxTokens: 100 },
  };
}
