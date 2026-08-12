import { chmod, link, open, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ToolError } from './errors.js';

export async function atomicCreate(path: string, content: Buffer): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temp, 'wx');
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    await link(temp, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new ToolError('FILE_ALREADY_EXISTS', '目标文件已存在。', false);
    }
    throw error;
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

export async function atomicReplace(path: string, content: Buffer, mode?: number): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temp, 'wx');
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    const resolvedMode = mode ?? (await stat(path)).mode;
    await chmod(temp, resolvedMode);
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}
