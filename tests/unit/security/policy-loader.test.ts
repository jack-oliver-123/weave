import { describe, expect, it, vi } from 'vitest';
import {
  SecurityPolicyLoader,
  parsePolicy,
  type SecurityPolicyFileSystem,
} from '../../../src/security/index.js';

describe('security policy schema', () => {
  it('accepts typed declarative rules and rejects code, regex, negation, and unknown fields', () => {
    const policy = parsePolicy(`
schemaVersion: 1
rules:
  - id: allow-read-src
    effect: allow
    target:
      capability: FilesystemRead
      pathPrefix: src
`, 'user');
    expect(policy).toEqual([{
      schemaVersion: 1, id: 'allow-read-src', effect: 'allow', source: 'user',
      target: { capability: 'FilesystemRead', pathPrefix: 'src' },
    }]);

    for (const field of ['code: process.exit()', 'regex: ".*"', 'not: true', 'priority: 1']) {
      expect(() => parsePolicy(`
schemaVersion: 1
rules:
  - id: invalid
    effect: deny
    target:
      capability: FilesystemRead
      ${field}
`, 'user')).toThrow('unknown field');
    }
  });

  it('requires allow to cover one capability and forbids project allow', () => {
    expect(() => parsePolicy(`
schemaVersion: 1
rules:
  - id: broad
    effect: allow
    target: { actionType: bash }
`, 'user')).toThrow('allow must target one explicit capability');
    expect(() => parsePolicy(`
schemaVersion: 1
rules:
  - id: project-escalation
    effect: allow
    target: { capability: FilesystemWrite }
`, 'project')).toThrow('project policy cannot allow');
  });
});

describe('SecurityPolicyLoader trust boundary', () => {
  it('loads a trusted user policy outside the workspace and a tightening project policy', async () => {
    const fileSystem = fakeFileSystem({
      '/home/user/.weave/security.yaml': userPolicy(),
      '/repo/.weave-policy.yaml': projectPolicy(),
    });
    const loader = new SecurityPolicyLoader({
      workspaceRoot: '/repo', platform: 'posix', currentUid: 1000, fileSystem,
    });
    const snapshot = await loader.load({
      userPolicyPath: '/home/user/.weave/security.yaml',
      projectPolicyPath: '/repo/.weave-policy.yaml',
    });
    expect(snapshot.version).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.userRules.map((rule) => rule.effect)).toEqual(['allow']);
    expect(snapshot.projectRules.map((rule) => rule.effect)).toEqual(['deny']);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it.each([
    ['wrong owner', { uid: 2000, mode: 0o100600 }, 'SECURITY_POLICY_OWNER_UNTRUSTED'],
    ['group writable', { uid: 1000, mode: 0o100620 }, 'SECURITY_POLICY_PERMISSIONS_UNTRUSTED'],
  ])('rejects a POSIX user policy with %s', async (_name, metadata, code) => {
    const fileSystem = fakeFileSystem({ '/home/user/.weave/security.yaml': userPolicy() }, metadata);
    const loader = new SecurityPolicyLoader({ workspaceRoot: '/repo', platform: 'posix', currentUid: 1000, fileSystem });
    await expect(loader.load({ userPolicyPath: '/home/user/.weave/security.yaml' })).rejects.toThrow(code);
  });

  it('requires a regular file and a verified Windows ACL', async () => {
    const fileSystem = fakeFileSystem({ 'C:\\Users\\me\\.weave\\security.yaml': userPolicy() }, {
      uid: 1000, mode: 0o100600, isFile: false,
    });
    const loader = new SecurityPolicyLoader({
      workspaceRoot: 'C:\\repo', platform: 'win32', fileSystem, verifyWindowsAcl: vi.fn(async () => true),
    });
    await expect(loader.load({ userPolicyPath: 'C:\\Users\\me\\.weave\\security.yaml' }))
      .rejects.toThrow('SECURITY_POLICY_NOT_REGULAR_FILE');

    const regular = fakeFileSystem({ 'C:\\Users\\me\\.weave\\security.yaml': userPolicy() });
    const untrusted = new SecurityPolicyLoader({
      workspaceRoot: 'C:\\repo', platform: 'win32', fileSystem: regular, verifyWindowsAcl: async () => false,
    });
    await expect(untrusted.load({ userPolicyPath: 'C:\\Users\\me\\.weave\\security.yaml' }))
      .rejects.toThrow('SECURITY_POLICY_ACL_UNTRUSTED');
  });

  it('rejects user policy inside the workspace and project policy outside it', async () => {
    const fileSystem = fakeFileSystem({
      '/repo/security.yaml': userPolicy(),
      '/tmp/.weave-policy.yaml': projectPolicy(),
    });
    const loader = new SecurityPolicyLoader({ workspaceRoot: '/repo', platform: 'posix', currentUid: 1000, fileSystem });
    await expect(loader.load({ userPolicyPath: '/repo/security.yaml' })).rejects.toThrow('USER_POLICY_MUST_BE_OUTSIDE_WORKSPACE');
    await expect(loader.load({ projectPolicyPath: '/tmp/.weave-policy.yaml' })).rejects.toThrow('PROJECT_POLICY_MUST_BE_INSIDE_WORKSPACE');
  });
});

function userPolicy(): string {
  return `schemaVersion: 1\nrules:\n  - id: read\n    effect: allow\n    target: { capability: FilesystemRead }\n`;
}

function projectPolicy(): string {
  return `schemaVersion: 1\nrules:\n  - id: no-shell\n    effect: deny\n    target: { capability: ProcessSpawn, rawShell: true }\n`;
}

function fakeFileSystem(
  files: Readonly<Record<string, string>>,
  metadata: { readonly uid: number; readonly mode: number; readonly isFile?: boolean } = { uid: 1000, mode: 0o100600 },
): SecurityPolicyFileSystem {
  const canonical = new Map(Object.entries(files).map(([path, contents]) => [normalize(path), contents]));
  return {
    realpath: async (path) => normalize(path),
    readFile: async (path) => {
      const contents = canonical.get(normalize(path));
      if (contents === undefined) throw new Error(`ENOENT: ${path}`);
      return contents;
    },
    stat: async (path) => {
      if (!canonical.has(normalize(path))) throw new Error(`ENOENT: ${path}`);
      return { isFile: () => metadata.isFile ?? true, uid: metadata.uid, mode: metadata.mode };
    },
  };
}

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/^([A-Z]):/, (_match, drive: string) => `${drive.toLowerCase()}:`);
}
