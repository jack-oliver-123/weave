import { lstat, mkdir, realpath, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsRoot = path.join(repoRoot, 'docs');
const linkPath = path.join(docsRoot, 'openspec');
const targetPath = path.join(repoRoot, 'openspec');

await mkdir(docsRoot, { recursive: true });

let existing;
try {
  existing = await lstat(linkPath);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

if (existing !== undefined) {
  if (!existing.isSymbolicLink()) {
    throw new Error('docs/openspec 已存在且不是符号链接或 Windows junction');
  }
  try {
    if (await realpath(linkPath) === await realpath(targetPath)) {
      process.stdout.write('docs/openspec 链接有效\n');
      process.exit(0);
    }
  } catch {
    // A broken link is safe to replace because only the link itself is removed.
  }
  await unlink(linkPath);
}

if (process.platform === 'win32') {
  await symlink(targetPath, linkPath, 'junction');
} else {
  await symlink('../openspec', linkPath, 'dir');
}

if (await realpath(linkPath) !== await realpath(targetPath)) {
  throw new Error('docs/openspec 链接目标校验失败');
}

process.stdout.write('docs/openspec 链接已创建\n');
