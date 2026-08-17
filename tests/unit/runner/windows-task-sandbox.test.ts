import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WindowsTaskSandbox } from '../../../src/runner/windows-task-sandbox.js';
import type { WindowsSandboxCli } from '../../../src/runner/windows-backend.js';

describe('Windows Task Sandbox lifecycle', () => {
  it('stops the Task VM before deleting host views that are still mapped', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'weave-windows-task-unit-'));
    await writeFile(join(workspace, 'safe.txt'), 'safe', 'utf8');
    let baselinePath = '';
    let cowPath = '';
    const cli: WindowsSandboxCli = {
      async run(args) {
        if (args[0] === 'start') {
          const config = args[args.indexOf('--config') + 1]!;
          const mappings = [...config.matchAll(/<HostFolder>(.*?)<\/HostFolder>/g)].map((match) => match[1]!);
          baselinePath = mappings[0]!;
          cowPath = mappings[1]!;
          expect(baselinePath).not.toBe(workspace);
          expect(cowPath).not.toBe(workspace);
          expect(baselinePath).not.toBe(cowPath);
          return { status: 0, stdout: '{"id":"sandbox-1"}', stderr: '' };
        }
        if (args[0] === 'stop') {
          await expect(stat(baselinePath)).resolves.toBeDefined();
          await expect(stat(cowPath)).resolves.toBeDefined();
          return { status: 0, stdout: '{}', stderr: '' };
        }
        if (args[0] === 'connect' || args[0] === 'exec') return { status: 0, stdout: '', stderr: '' };
        throw new Error(`Unexpected command: ${args[0]}`);
      },
    };
    const sandbox = await WindowsTaskSandbox.create({
      taskId: 'task-1', sandboxId: 'sandbox-1', workspaceRoot: workspace, cli,
      certifiedCapabilities: ['FilesystemRead'],
      budget: {
        cpuCores: 1, memoryBytes: 256 * 1024 ** 2, pids: 4, actionTimeoutMs: 5_000,
        taskProcessTimeoutMs: 60_000, diskBytes: 1024 ** 2, stdoutBytes: 64 * 1024,
        stderrBytes: 64 * 1024, batchOutputBytes: 512 * 1024, networkBytes: 1024,
      },
    });
    await sandbox.close('completed');
    await expect(stat(baselinePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(cowPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('provisions the worker runtime once and removes each structured-write action view', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'weave-windows-task-write-unit-'));
    await writeFile(join(workspace, 'safe.txt'), 'before', 'utf8');
    let cowPath = '';
    const commands: string[] = [];
    const cli: WindowsSandboxCli = {
      async run(args) {
        if (args[0] === 'start') {
          const config = args[args.indexOf('--config') + 1]!;
          cowPath = [...config.matchAll(/<HostFolder>(.*?)<\/HostFolder>/g)].map((match) => match[1]!)[1]!;
          return { status: 0, stdout: '{"id":"sandbox-1"}', stderr: '' };
        }
        if (args[0] === 'exec') {
          const command = args[args.indexOf('--command') + 1]!;
          commands.push(command);
          const requestPath = /-RequestPath "([^"]+)"/.exec(command)?.[1];
          const resultPath = /-ResultPath "([^"]+)"/.exec(command)?.[1];
          if (requestPath !== undefined && resultPath !== undefined) {
            const requestHostPath = guestPath(cowPath, requestPath);
            const resultHostPath = guestPath(cowPath, resultPath);
            const request = JSON.parse(await readFile(requestHostPath, 'utf8')) as {
              call: { callId: string; providerCallId: string; name: string; input: { path: string } };
              workspaceRoot: string;
            };
            await writeFile(guestPath(cowPath, `${request.workspaceRoot}\\${request.call.input.path}`), 'after', 'utf8');
            await writeFile(resultHostPath, JSON.stringify({
              callId: request.call.callId,
              providerCallId: request.call.providerCallId,
              toolName: request.call.name,
              isError: false,
              content: { summary: 'File edited' },
            }), 'utf8');
          }
          return { status: 0, stdout: '', stderr: '' };
        }
        if (args[0] === 'connect' || args[0] === 'stop') return { status: 0, stdout: '{}', stderr: '' };
        throw new Error(`Unexpected command: ${args[0]}`);
      },
    };
    const sandbox = await WindowsTaskSandbox.create({
      taskId: 'task-1', sandboxId: 'sandbox-1', workspaceRoot: workspace, cli,
      certifiedCapabilities: ['FilesystemRead', 'FilesystemWrite'], budget: testBudget(),
      createId: () => 'action-1',
    });
    const worker = await sandbox.openWorker(writeInput());
    const outcome = await worker.execute(new AbortController().signal);
    await worker.close('action_completed');

    expect(outcome.result.isError).toBe(false);
    expect(await readFile(join(workspace, 'safe.txt'), 'utf8')).toBe('after');
    expect(await readFile(join(cowPath, 'safe.txt'), 'utf8')).toBe('after');
    expect(await readdir(join(cowPath, '.weave', 'action-views'))).toEqual([]);
    expect(commands.filter((command) => command.includes('/setintegritylevel'))).toHaveLength(1);
    expect(commands.filter((command) => command.includes('supervisor.ps1'))).toHaveLength(1);
    expect(commands.some((command) => command.includes('share'))).toBe(false);
    await sandbox.close('completed');
  });
});

function guestPath(cowPath: string, guestPath: string): string {
  const prefix = 'C:\\Weave\\Cow';
  if (!guestPath.toLowerCase().startsWith(prefix.toLowerCase())) throw new Error(`Unexpected guest path: ${guestPath}`);
  const relative = guestPath.slice(prefix.length).replace(/^\\+/, '').split('\\').filter(Boolean);
  return join(cowPath, ...relative);
}

function testBudget() {
  return {
    cpuCores: 1, memoryBytes: 256 * 1024 ** 2, pids: 4, actionTimeoutMs: 5_000,
    taskProcessTimeoutMs: 60_000, diskBytes: 1024 ** 2, stdoutBytes: 64 * 1024,
    stderrBytes: 64 * 1024, batchOutputBytes: 512 * 1024, networkBytes: 1024,
  };
}

function writeInput() {
  return {
    taskId: 'task-1', runId: 'run-1',
    call: {
      callId: 'call-1', providerCallId: 'provider-1', name: 'edit_file',
      input: { path: 'safe.txt', edits: [{ oldText: 'before', newText: 'after' }] },
    },
    action: {
      schemaVersion: 1 as const, actionId: 'action-1', actionType: 'edit_file' as const,
      input: { path: 'safe.txt', edits: [{ oldText: 'before', newText: 'after' }] }, digest: 'digest',
      manifest: { schemaVersion: 1 as const, requirements: [{ type: 'FilesystemWrite' as const, paths: ['safe.txt'] }] },
    },
    profile: {
      ...testBudget(), filesystemRead: ['safe.txt'], filesystemWrite: ['safe.txt'], networkEnabled: false,
      environment: {}, controlChannelVisible: false as const, ticketVisible: false as const,
    },
  };
}
