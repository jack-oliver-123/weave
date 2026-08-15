import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import type { ActionWorkerLaunchInput } from '../../../src/runner/supervisor.js';
import {
  WINDOWS_ACTION_WORKER_SCRIPT,
  WINDOWS_JOB_SUPERVISOR_SCRIPT,
  WindowsJobObjectWorker,
} from '../../../src/runner/windows-worker-supervisor.js';

describe('Windows Job Object worker supervisor', () => {
  it('uses a restricted low-integrity token and enforceable Job Object limits', () => {
    expect(WINDOWS_JOB_SUPERVISOR_SCRIPT).toContain('OpenProcessToken(GetCurrentProcess()');
    expect(WINDOWS_JOB_SUPERVISOR_SCRIPT).not.toContain('WTSQueryUserToken');
    expect(WINDOWS_JOB_SUPERVISOR_SCRIPT).toContain('CreateRestrictedToken');
    expect(WINDOWS_JOB_SUPERVISOR_SCRIPT).toContain('DISABLE_MAX_PRIVILEGE');
    expect(WINDOWS_JOB_SUPERVISOR_SCRIPT).not.toContain('LUA_TOKEN');
    expect(WINDOWS_JOB_SUPERVISOR_SCRIPT).toContain('S-1-16-4096');
    expect(WINDOWS_JOB_SUPERVISOR_SCRIPT).toContain('JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE');
    expect(WINDOWS_JOB_SUPERVISOR_SCRIPT).toContain('JOB_OBJECT_LIMIT_ACTIVE_PROCESS');
    expect(WINDOWS_JOB_SUPERVISOR_SCRIPT).toContain('JOB_OBJECT_LIMIT_JOB_MEMORY');
    expect(WINDOWS_JOB_SUPERVISOR_SCRIPT).toContain('JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP');
    expect(WINDOWS_JOB_SUPERVISOR_SCRIPT).toContain('AssignProcessToJobObject');
    expect(WINDOWS_JOB_SUPERVISOR_SCRIPT).toContain('false, CREATE_SUSPENDED');
    expect(WINDOWS_ACTION_WORKER_SCRIPT).not.toContain('Credential');
  });

  it.runIf(process.platform === 'win32')('compiles the native supervisor bridge with Windows PowerShell', async () => {
    const source = /\$source = @'\r?\n([\s\S]*?)\r?\n'@/.exec(WINDOWS_JOB_SUPERVISOR_SCRIPT)?.[1];
    expect(source).toBeDefined();
    const encoded = Buffer.from(source!, 'utf8').toString('base64');
    await promisify(execFile)('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); Add-Type -TypeDefinition $source -Language CSharp`,
    ], { windowsHide: true });
  });

  it('passes only a contentless request and validates the bound result envelope', async () => {
    const cow = await mkdtemp(join(tmpdir(), 'weave-windows-worker-unit-'));
    const exec = vi.fn(async () => {
      await writeFile(join(cow, '.weave', 'windows-actions', 'action-1', 'result.json'), `\uFEFF${JSON.stringify({
        callId: 'call-1', providerCallId: 'provider-1', toolName: 'read_file', isError: false,
        content: { summary: 'File read', data: { content: 'safe' } },
      })}`, 'utf8');
    });
    const worker = new WindowsJobObjectWorker({
      vm: { exec } as never,
      cowHostRoot: cow,
      guestWorkspaceRoot: 'C:\\Weave\\Cow',
      input: workerInput(),
      createId: () => 'action-1',
    });
    const outcome = await worker.execute(new AbortController().signal);
    expect(outcome.result).toMatchObject({ callId: 'call-1', isError: false });
    expect(exec).toHaveBeenCalledWith(expect.stringContaining('supervisor.ps1'), 'ExistingLogin', 'C:\\Weave\\Cow', expect.any(AbortSignal));
    const request = await readFile(join(cow, '.weave', 'windows-actions', 'action-1', 'request.json'), 'utf8');
    expect(request).not.toContain('ticket');
    expect(request).not.toContain('credential');
    await worker.close();
  });

  it('does not launch an already-cancelled action', async () => {
    const cow = await mkdtemp(join(tmpdir(), 'weave-windows-worker-cancel-'));
    const exec = vi.fn();
    const worker = new WindowsJobObjectWorker({
      vm: { exec } as never,
      cowHostRoot: cow,
      input: workerInput(),
      createId: () => 'action-2',
    });
    const controller = new AbortController();
    controller.abort();
    const outcome = await worker.execute(controller.signal);
    expect(outcome.result.content.error?.code).toBe('TOOL_CANCELLED');
    expect(exec).not.toHaveBeenCalled();
    await worker.close();
  });
});

function workerInput(): ActionWorkerLaunchInput {
  return {
    taskId: 'task-1', runId: 'run-1',
    call: { callId: 'call-1', providerCallId: 'provider-1', name: 'read_file', input: { path: 'safe.txt' } },
    action: {
      schemaVersion: 1, actionId: 'action-1', actionType: 'read_file', input: { path: 'safe.txt' }, digest: 'digest',
      manifest: { schemaVersion: 1, requirements: [{ type: 'FilesystemRead', paths: ['safe.txt'] }] },
    },
    profile: {
      cpuCores: 1, memoryBytes: 256 * 1024 ** 2, pids: 4, actionTimeoutMs: 5_000,
      taskProcessTimeoutMs: 60_000, diskBytes: 1024 ** 2, stdoutBytes: 64 * 1024,
      stderrBytes: 64 * 1024, batchOutputBytes: 512 * 1024, networkBytes: 1024,
      filesystemRead: ['safe.txt'], filesystemWrite: [], networkEnabled: false,
      environment: {}, controlChannelVisible: false, ticketVisible: false,
    },
  };
}
