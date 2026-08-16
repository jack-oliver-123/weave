import { describe, expect, it } from 'vitest';
import { SecurityInternalResourceRegistry } from '../../../src/security/index.js';
import type { NormalizedAction } from '../../../src/security/index.js';

describe('security internal resource registry', () => {
  it('hard-denies audit, journal, backup, and security configuration descendants', () => {
    const registry = new SecurityInternalResourceRegistry([
      'C:/Users/test/.weave/security/audit',
      'C:/Users/test/.weave/security/journal',
      'C:/Users/test/.weave/security/backups',
      'C:/Users/test/.weave/security.yaml',
    ]);
    for (const path of [
      'C:/Users/test/.weave/security/audit/2026-08-14.jsonl',
      'C:/Users/test/.weave/security/journal/action-1.json',
      'C:/Users/test/.weave/security/backups/file.bak',
      'C:/Users/test/.weave/security.yaml',
    ]) {
      expect(registry.assess(action(path))).toEqual({ allowed: false, code: 'SECURITY_INTERNAL_RESOURCE' });
    }
  });

  it('does not block an unrelated workspace path', () => {
    const registry = new SecurityInternalResourceRegistry(['C:/Users/test/.weave/security']);
    expect(registry.assess(action('C:/Code/weave/src/main.ts'))).toEqual({ allowed: true });
  });
});

function action(path: string): NormalizedAction {
  return {
    schemaVersion: 1, actionId: 'action-1', actionType: 'read_file', input: { path }, digest: 'action:v1:test',
    manifest: { schemaVersion: 1, requirements: [{ type: 'FilesystemRead', paths: [path] }] },
  };
}
