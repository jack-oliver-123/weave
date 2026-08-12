import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { atomicCreate, atomicReplace } from '../../../src/tool/atomic-write.js';
import { decodeUtf8, sliceLines } from '../../../src/tool/text-file.js';
import { walkFiles } from '../../../src/tool/walker.js';
import { Workspace } from '../../../src/tool/workspace.js';

async function fixture(): Promise<{ root: string; outside: string; workspace: Workspace }> {
  const root = await mkdtemp(join(tmpdir(), 'weave-workspace-'));
  const outside = await mkdtemp(join(tmpdir(), 'weave-outside-'));
  return { root, outside, workspace: await Workspace.create(root) };
}

describe('Workspace infrastructure', () => {
  it('resolves existing and new relative targets but rejects escapes and absolute paths', async () => {
    const { root, workspace } = await fixture();
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'a.txt'), 'ok');
    expect((await workspace.existingFile('src/a.txt')).relativePath).toBe('src/a.txt');
    expect((await workspace.newFile('src/b.txt')).relativePath).toBe('src/b.txt');
    await expect(workspace.existingFile('../outside.txt')).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
    await expect(workspace.existingFile(join(root, 'src', 'a.txt'))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('rejects link parents that escape the workspace', async () => {
    const { root, outside, workspace } = await fixture();
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await symlink(outside, join(root, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(workspace.existingFile('external/secret.txt')).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
  });

  it('rejects a final symlink or Junction', async () => {
    const { root, outside, workspace } = await fixture();
    await writeFile(join(outside, 'secret.txt'), 'secret');
    if (process.platform === 'win32') {
      await symlink(outside, join(root, 'link-target'), 'junction');
      await expect(workspace.existingDirectory('link-target')).rejects.toMatchObject({ code: 'TARGET_IS_SYMLINK' });
    } else {
      await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'), 'file');
      await expect(workspace.existingFile('link.txt')).rejects.toMatchObject({ code: 'TARGET_IS_SYMLINK' });
    }
  });

  it('decodes UTF-8 BOM, preserves line endings and rejects invalid bytes', () => {
    expect(decodeUtf8(Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a, 0x62]))).toEqual({ text: 'a\r\nb', bom: true });
    expect(sliceLines('a\r\nb\n', 2, 1)).toMatchObject({ content: 'b\n', startLine: 2, endLine: 2, totalLines: 2 });
    expect(() => decodeUtf8(Buffer.from([0xc3, 0x28]))).toThrowError('UTF-8');
  });

  it('creates exclusively and atomically replaces while preserving complete content', async () => {
    const { root } = await fixture();
    const path = join(root, 'a.txt');
    await atomicCreate(path, Buffer.from('first'));
    await expect(atomicCreate(path, Buffer.from('second'))).rejects.toMatchObject({ code: 'FILE_ALREADY_EXISTS' });
    await atomicReplace(path, Buffer.from('replacement'));
    expect(await readFile(path, 'utf8')).toBe('replacement');
  });

  it('walks ordinary files, skips fixed directories and observes cancellation', async () => {
    const { root, workspace } = await fixture();
    await mkdir(join(root, 'src'));
    await mkdir(join(root, 'node_modules'));
    await writeFile(join(root, 'src', 'a.txt'), 'a');
    await writeFile(join(root, 'node_modules', 'hidden.txt'), 'x');
    const walked = await walkFiles(workspace, '.', new AbortController().signal);
    expect(walked.files).toEqual(['src/a.txt']);
    const controller = new AbortController(); controller.abort();
    await expect(walkFiles(workspace, '.', controller.signal)).rejects.toMatchObject({ code: 'TOOL_CANCELLED' });
  });
});
