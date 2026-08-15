import { lstat, realpath } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import type { PathBoundaryAssessment } from './authorization.js';

export interface PathBoundaryFileSystem {
  realpath(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
}

export interface PathCapabilityBoundaryOptions {
  readonly workspaceRoot: string;
  readonly readRoots: readonly string[];
  readonly writeRoots: readonly string[];
  readonly platform?: 'win32' | 'posix';
  readonly fileSystem?: PathBoundaryFileSystem;
}

const defaultFileSystem: PathBoundaryFileSystem = {
  realpath,
  exists: async (path) => {
    try { await lstat(path); return true; } catch { return false; }
  },
};

export class PathCapabilityBoundary {
  private readonly platform: 'win32' | 'posix';
  private readonly fileSystem: PathBoundaryFileSystem;
  private readonly path: typeof posix;

  constructor(private readonly options: PathCapabilityBoundaryOptions) {
    this.platform = options.platform ?? (process.platform === 'win32' ? 'win32' : 'posix');
    this.fileSystem = options.fileSystem ?? defaultFileSystem;
    this.path = this.platform === 'win32' ? win32 : posix;
  }

  async check(operation: 'read' | 'write', candidate: string): Promise<PathBoundaryAssessment> {
    const lexicalFailure = this.checkLexical(candidate);
    if (lexicalFailure !== undefined) return lexicalFailure;

    const root = this.path.resolve(this.options.workspaceRoot);
    const target = this.path.resolve(root, candidate);
    const roots = operation === 'read' ? this.options.readRoots : this.options.writeRoots;
    if (roots.length === 0) return denied('PATH_CAPABILITY_MISSING', `No ${operation} path capability is available`);
    const resolvedTarget = await this.resolveExistingPrefix(target);
    for (const allowed of roots) {
      const allowedPath = await this.resolveExistingPrefix(this.path.resolve(root, allowed));
      if (containsPath(allowedPath, resolvedTarget, this.platform, this.path)) return { allowed: true };
    }
    return denied('PATH_OUTSIDE_BOUNDARY', 'Path resolves outside the task capability boundary');
  }

  private checkLexical(candidate: string): PathBoundaryAssessment | undefined {
    if (candidate.length === 0 || candidate.includes('\0')) return denied('PATH_INVALID', 'Path must be non-empty and contain no NUL');
    const normalized = candidate.replace(/\\/g, '/');
    if (posix.isAbsolute(candidate) || win32.isAbsolute(candidate) || normalized.startsWith('//')) {
      return denied('ABSOLUTE_PATH_DENIED', 'Model paths must be workspace-relative');
    }
    if (normalized.split('/').some((segment) => segment === '..')) return denied('PATH_TRAVERSAL_DENIED', 'Parent traversal is not allowed');
    if (this.platform === 'win32') {
      if (/^(?:\\\\\?\\|\\\\\.\\|\/\/\?\/|\/\/\.\/)/.test(candidate)) return denied('DEVICE_PATH_DENIED', 'Windows device paths are not allowed');
      if (normalized.includes(':')) return denied('NTFS_ADS_DENIED', 'NTFS alternate data streams are not allowed');
    }
    return undefined;
  }

  private async resolveExistingPrefix(target: string): Promise<string> {
    const missing: string[] = [];
    let current = target;
    while (!(await this.fileSystem.exists(current))) {
      const parent = this.path.dirname(current);
      if (parent === current) break;
      missing.unshift(current.slice(parent.length + (parent.endsWith(this.path.sep) ? 0 : 1)));
      current = parent;
    }
    const resolved = await this.fileSystem.realpath(current);
    return missing.length === 0 ? resolved : this.path.join(resolved, ...missing);
  }
}

function containsPath(root: string, target: string, platform: 'win32' | 'posix', path: typeof posix): boolean {
  const normalizeCase = (value: string): string => platform === 'win32' ? value.toLocaleLowerCase('en-US') : value;
  const difference = path.relative(normalizeCase(root), normalizeCase(target));
  return difference === '' || (!difference.startsWith('..') && !path.isAbsolute(difference));
}

function denied(code: string, message: string): PathBoundaryAssessment {
  return { allowed: false, code, message };
}
