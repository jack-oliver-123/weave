import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('CLI 启动入口', () => {
  beforeAll(async () => {
    await execFileAsync(process.execPath, ['node_modules/typescript/bin/tsc'], { cwd: process.cwd() });
  }, 60_000);

  it('在普通终端输出帮助且不包含未实现命令', { timeout: 30_000 }, async () => {
    const result = await execFileAsync(process.execPath, ['dist/main.js', '--help'], { cwd: process.cwd() });
    expect(result.stdout).toContain('Weave - 多协议终端对话');
    expect(result.stdout).not.toMatch(/\/model|\/clear|\/mcp/);
    expect(result.stdout).not.toContain('\u001b[?1049h');
  });

  it('输出版本', { timeout: 30_000 }, async () => {
    const result = await execFileAsync(process.execPath, ['dist/main.js', '--version'], { cwd: process.cwd() });
    expect(result.stdout.trim()).toBe('0.1.0');
  });

  it('配置失败时非零退出且不进入 alternate screen', { timeout: 30_000 }, async () => {
    await expect(execFileAsync(process.execPath, ['dist/main.js', '--config', 'missing.yaml'], { cwd: process.cwd() }))
      .rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('配置文件不存在'),
        stdout: expect.not.stringContaining('\u001b[?1049h'),
      });
  });
});
