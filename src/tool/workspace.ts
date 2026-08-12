import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { ToolError } from './errors.js';

export interface ResolvedWorkspacePath {
  readonly absolutePath: string;
  readonly relativePath: string;
}

export class Workspace {
  private constructor(readonly root: string) {}

  static async create(root: string): Promise<Workspace> {
    const resolved = await realpath(root);
    const info = await lstat(resolved);
    if (!info.isDirectory()) throw new ToolError('INVALID_ARGUMENT', '工作区必须是目录。', false);
    return new Workspace(resolved);
  }

  async existingFile(input: string): Promise<ResolvedWorkspacePath> {
    const candidate = this.syntax(input);
    const info = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') throw new ToolError('FILE_NOT_FOUND', '文件不存在。', false, { path: normalize(input) });
      throw error;
    });
    if (info.isSymbolicLink()) throw new ToolError('TARGET_IS_SYMLINK', '目标不能是符号链接或 Junction。', false);
    const actual = await realpath(candidate);
    this.assertInside(actual);
    if (!info.isFile()) throw new ToolError('NOT_A_FILE', '目标不是普通文件。', false, { path: normalize(input) });
    return { absolutePath: actual, relativePath: this.toRelative(actual) };
  }

  async existingDirectory(input = '.'): Promise<ResolvedWorkspacePath> {
    const candidate = this.syntax(input);
    const info = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') throw new ToolError('FILE_NOT_FOUND', '目录不存在。', false, { path: normalize(input) });
      throw error;
    });
    if (info.isSymbolicLink()) throw new ToolError('TARGET_IS_SYMLINK', '目标不能是符号链接或 Junction。', false);
    const actual = await realpath(candidate);
    this.assertInside(actual);
    if (!info.isDirectory()) throw new ToolError('INVALID_ARGUMENT', '目标不是目录。', false);
    return { absolutePath: actual, relativePath: this.toRelative(actual) };
  }

  async newFile(input: string): Promise<ResolvedWorkspacePath> {
    const candidate = this.syntax(input);
    let parent = resolve(candidate, '..');
    while (true) {
      try {
        const actualParent = await realpath(parent);
        this.assertInside(actualParent);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const next = resolve(parent, '..');
        if (next === parent) throw new ToolError('PATH_OUTSIDE_WORKSPACE', '路径不在工作区内。', false);
        parent = next;
      }
    }
    try {
      const info = await lstat(candidate);
      if (info.isSymbolicLink()) throw new ToolError('TARGET_IS_SYMLINK', '目标不能是符号链接或 Junction。', false);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return { absolutePath: candidate, relativePath: this.toRelative(candidate) };
  }

  toRelative(absolutePath: string): string {
    const value = relative(this.root, absolutePath);
    return value.length === 0 ? '.' : normalize(value);
  }

  private syntax(input: string): string {
    if (input.length === 0 || input.includes('\0') || isAbsolute(input) || /^[a-zA-Z]:/.test(input) || /^[/\\]{2}/.test(input)) {
      throw new ToolError('INVALID_ARGUMENT', '路径必须是工作区相对路径。', false);
    }
    if (process.platform === 'win32' && input.split(/[\\/]/).some((part) => part.includes(':'))) {
      throw new ToolError('INVALID_ARGUMENT', '路径不能包含 NTFS Alternate Data Stream。', false);
    }
    const candidate = resolve(this.root, input);
    this.assertInside(candidate);
    return candidate;
  }

  private assertInside(candidate: string): void {
    const root = process.platform === 'win32' ? this.root.toLowerCase() : this.root;
    const target = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
    const rel = relative(root, target);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new ToolError('PATH_OUTSIDE_WORKSPACE', '路径不在工作区内。', false);
    }
  }
}

function normalize(path: string): string { return path.replaceAll('\\', '/'); }
