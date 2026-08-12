import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Workspace } from './workspace.js';
import { ToolError } from './errors.js';

export interface WalkResult { readonly files: readonly string[]; readonly truncated: boolean; }

export async function walkFiles(
  workspace: Workspace,
  inputPath: string,
  signal: AbortSignal,
  maxFiles = 100_000,
): Promise<WalkResult> {
  const start = await workspace.existingDirectory(inputPath);
  const files: string[] = [];
  const pending = [start.absolutePath];
  let truncated = false;
  while (pending.length > 0) {
    if (signal.aborted) throw new ToolError('TOOL_CANCELLED', '工具调用已取消。', false);
    const directory = pending.pop()!;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (signal.aborted) throw new ToolError('TOOL_CANCELLED', '工具调用已取消。', false);
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.isSymbolicLink()) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile()) {
        files.push(workspace.toRelative(absolute));
        if (files.length >= maxFiles) { truncated = true; pending.length = 0; break; }
      }
    }
  }
  files.sort((a, b) => a.localeCompare(b));
  return { files, truncated };
}
