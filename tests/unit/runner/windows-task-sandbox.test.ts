import { mkdtemp, stat, writeFile } from 'node:fs/promises';
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
});
