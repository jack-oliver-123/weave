import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface WorkspaceConfig {
  readonly root: string;
  readonly startupDirectory: string;
}

export async function resolveWorkspace(
  workspacePath: string | undefined,
  startupDirectory = process.cwd(),
): Promise<WorkspaceConfig> {
  const candidate = resolve(startupDirectory, workspacePath ?? '.');
  let info;
  try {
    info = await stat(candidate);
  } catch {
    throw new Error(`工作区不存在：${candidate}`);
  }
  if (!info.isDirectory()) throw new Error(`工作区不是目录：${candidate}`);
  return Object.freeze({ root: await realpath(candidate), startupDirectory: resolve(startupDirectory) });
}
