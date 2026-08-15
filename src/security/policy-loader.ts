import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import { parse } from 'yaml';
import type { PermissionRule, PermissionRuleTarget } from './authorization.js';
import type { CapabilityPrimitive } from './domain.js';

export interface SecurityPolicySnapshot {
  readonly schemaVersion: 1;
  readonly version: string;
  readonly userRules: readonly PermissionRule[];
  readonly projectRules: readonly PermissionRule[];
}

export interface SecurityPolicyFileSystem {
  readFile(path: string): Promise<string>;
  stat(path: string): Promise<{ isFile(): boolean; readonly uid?: number; readonly mode?: number }>;
  realpath(path: string): Promise<string>;
}

export interface SecurityPolicyLoaderOptions {
  readonly workspaceRoot: string;
  readonly platform?: 'win32' | 'posix';
  readonly currentUid?: number;
  readonly verifyWindowsAcl?: (path: string) => Promise<boolean>;
  readonly fileSystem?: SecurityPolicyFileSystem;
}

const defaultFileSystem: SecurityPolicyFileSystem = {
  readFile: async (path) => readFile(path, 'utf8'),
  stat,
  realpath,
};

const CAPABILITIES: readonly CapabilityPrimitive[] = [
  'FilesystemRead', 'FilesystemWrite', 'ProcessSpawn', 'NetworkEgress',
  'CredentialUse', 'DataDisclose', 'MemoryPersist',
];

const DESTINATIONS = ['model', 'terminal', 'history', 'file', 'network', 'audit'] as const;

export class SecurityPolicyLoader {
  private readonly fileSystem: SecurityPolicyFileSystem;
  private readonly platform: 'win32' | 'posix';
  private readonly path: typeof posix;

  constructor(private readonly options: SecurityPolicyLoaderOptions) {
    this.fileSystem = options.fileSystem ?? defaultFileSystem;
    this.platform = options.platform ?? (process.platform === 'win32' ? 'win32' : 'posix');
    this.path = this.platform === 'win32' ? win32 : posix;
  }

  async load(input: { readonly userPolicyPath?: string; readonly projectPolicyPath?: string }): Promise<SecurityPolicySnapshot> {
    const user = input.userPolicyPath === undefined ? undefined : await this.loadOne(input.userPolicyPath, 'user');
    const project = input.projectPolicyPath === undefined ? undefined : await this.loadOne(input.projectPolicyPath, 'project');
    const version = createHash('sha256')
      .update('weave.security-policy.v1\0')
      .update(user?.source ?? '')
      .update('\0')
      .update(project?.source ?? '')
      .digest('hex');
    return Object.freeze({
      schemaVersion: 1,
      version,
      userRules: Object.freeze(user?.rules ?? []),
      projectRules: Object.freeze(project?.rules ?? []),
    });
  }

  private async loadOne(path: string, source: 'user' | 'project'): Promise<{ source: string; rules: PermissionRule[] }> {
    const resolvedPath = await this.fileSystem.realpath(this.path.resolve(path));
    const workspace = await this.fileSystem.realpath(this.path.resolve(this.options.workspaceRoot));
    const insideWorkspace = containsPath(workspace, resolvedPath, this.platform, this.path);
    if (source === 'user' && insideWorkspace) throw new Error('USER_POLICY_MUST_BE_OUTSIDE_WORKSPACE');
    if (source === 'project' && !insideWorkspace) throw new Error('PROJECT_POLICY_MUST_BE_INSIDE_WORKSPACE');
    const metadata = await this.fileSystem.stat(resolvedPath);
    if (!metadata.isFile()) throw new Error('SECURITY_POLICY_NOT_REGULAR_FILE');
    if (source === 'user') await this.verifyTrustedUserPolicy(resolvedPath, metadata);
    const contents = await this.fileSystem.readFile(resolvedPath);
    const rules = parsePolicy(contents, source);
    return { source: contents, rules };
  }

  private async verifyTrustedUserPolicy(
    path: string,
    metadata: { readonly uid?: number; readonly mode?: number },
  ): Promise<void> {
    if (this.platform === 'win32') {
      if (this.options.verifyWindowsAcl === undefined || !(await this.options.verifyWindowsAcl(path))) {
        throw new Error('SECURITY_POLICY_ACL_UNTRUSTED');
      }
      return;
    }
    const expectedUid = this.options.currentUid ?? process.getuid?.();
    if (expectedUid === undefined || metadata.uid !== expectedUid) throw new Error('SECURITY_POLICY_OWNER_UNTRUSTED');
    if (metadata.mode === undefined || (metadata.mode & 0o022) !== 0) throw new Error('SECURITY_POLICY_PERMISSIONS_UNTRUSTED');
  }
}

export function parsePolicy(contents: string, source: 'user' | 'project'): PermissionRule[] {
  const root = exactObject(parse(contents), '$', ['schemaVersion', 'rules']);
  if (root.schemaVersion !== 1) throw new Error('$.schemaVersion: unsupported security policy version');
  if (!Array.isArray(root.rules)) throw new Error('$.rules: expected array');
  return root.rules.map((value, index) => parseRule(value, source, `$.rules[${index}]`));
}

function parseRule(value: unknown, source: 'user' | 'project', path: string): PermissionRule {
  const rule = exactObject(value, path, ['id', 'effect', 'target']);
  const id = stringValue(rule.id, `${path}.id`);
  const effect = enumValue(rule.effect, `${path}.effect`, ['allow', 'ask', 'deny'] as const);
  if (source === 'project' && effect === 'allow') throw new Error(`${path}.effect: project policy cannot allow`);
  const targetValue = exactObject(rule.target, `${path}.target`, [
    'actionType', 'capability', 'pathPrefix', 'executable', 'host', 'destination', 'rawShell',
  ]);
  const target: PermissionRuleTarget = {
    ...(targetValue.actionType === undefined ? {} : { actionType: stringValue(targetValue.actionType, `${path}.target.actionType`) }),
    ...(targetValue.capability === undefined ? {} : { capability: enumValue(targetValue.capability, `${path}.target.capability`, CAPABILITIES) }),
    ...(targetValue.pathPrefix === undefined ? {} : { pathPrefix: relativePath(targetValue.pathPrefix, `${path}.target.pathPrefix`) }),
    ...(targetValue.executable === undefined ? {} : { executable: stringValue(targetValue.executable, `${path}.target.executable`) }),
    ...(targetValue.host === undefined ? {} : { host: stringValue(targetValue.host, `${path}.target.host`) }),
    ...(targetValue.destination === undefined ? {} : { destination: enumValue(targetValue.destination, `${path}.target.destination`, DESTINATIONS) }),
    ...(targetValue.rawShell === undefined ? {} : { rawShell: booleanValue(targetValue.rawShell, `${path}.target.rawShell`) }),
  };
  if (target.actionType === undefined && target.capability === undefined) throw new Error(`${path}.target: actionType or capability is required`);
  if (effect === 'allow' && target.capability === undefined) throw new Error(`${path}: allow must target one explicit capability`);
  return Object.freeze({ schemaVersion: 1, id, effect, target: Object.freeze(target), source });
}

function exactObject(value: unknown, path: string, fields: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${path}: expected object`);
  const record = value as Record<string, unknown>;
  const allowed = new Set(fields);
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new Error(`${path}.${key}: unknown field`);
  return record;
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${path}: expected non-empty string`);
  return value;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${path}: expected boolean`);
  return value;
}

function enumValue<const T extends string>(value: unknown, path: string, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new Error(`${path}: unsupported value`);
  return value as T;
}

function relativePath(value: unknown, path: string): string {
  const result = stringValue(value, path).replace(/\\/g, '/');
  if (posix.isAbsolute(result) || win32.isAbsolute(result) || result.split('/').includes('..')) throw new Error(`${path}: expected safe relative path`);
  return result;
}

function containsPath(root: string, target: string, platform: 'win32' | 'posix', path: typeof posix): boolean {
  const fold = (value: string): string => platform === 'win32' ? value.toLocaleLowerCase('en-US') : value;
  const difference = path.relative(fold(root), fold(target));
  return difference === '' || (!difference.startsWith('..') && !path.isAbsolute(difference));
}
