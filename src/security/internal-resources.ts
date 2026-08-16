import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { NormalizedAction } from './domain.js';

export interface SecurityInternalResourceAssessment {
  readonly allowed: boolean;
  readonly code?: 'SECURITY_INTERNAL_RESOURCE';
}

export class SecurityInternalResourceRegistry {
  private readonly roots: readonly string[];

  constructor(roots: readonly string[]) {
    this.roots = Object.freeze(roots.map((root) => normalize(resolve(root))));
  }

  assess(action: NormalizedAction): SecurityInternalResourceAssessment {
    for (const requirement of action.manifest.requirements) {
      if (requirement.type !== 'FilesystemRead' && requirement.type !== 'FilesystemWrite') continue;
      if (requirement.paths.some((path) => this.isInternal(path))) {
        return Object.freeze({ allowed: false, code: 'SECURITY_INTERNAL_RESOURCE' });
      }
    }
    return Object.freeze({ allowed: true });
  }

  isInternal(path: string): boolean {
    const target = normalize(resolve(path));
    return this.roots.some((root) => {
      const result = relative(root, target);
      return result === '' || (!result.startsWith('..') && !isAbsolute(result));
    });
  }
}

export function defaultSecurityInternalRoots(homeDirectory = homedir()): readonly string[] {
  const securityRoot = join(homeDirectory, '.weave', 'security');
  return Object.freeze([
    join(securityRoot, 'audit'),
    join(securityRoot, 'journal'),
    join(securityRoot, 'backups'),
    join(homeDirectory, '.weave', 'security.yaml'),
  ]);
}

function normalize(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}
