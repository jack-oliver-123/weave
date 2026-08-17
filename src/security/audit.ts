import { execFile } from 'node:child_process';
import { mkdir, open, readdir, stat, unlink, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { CapabilityPrimitive, DataClassification, PermissionMode } from './domain.js';

const execFileAsync = promisify(execFile);
const DAY_MS = 24 * 60 * 60 * 1_000;
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const AUDIT_KEYS = new Set([
  'schemaVersion', 'eventId', 'occurredAt', 'phase', 'taskId', 'runId', 'callId',
  'actionId', 'actionDigest', 'actionSummary', 'capabilityTypes', 'risks',
  'classification', 'ruleIds', 'permissionMode', 'userDecision', 'ticketId',
  'sandboxBackend', 'outcome', 'errorCategory',
]);

export type SecurityAuditPhase = 'hitl' | 'preflight' | 'supervisor' | 'outcome' | 'integrity';

export interface SecurityAuditRecord {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly occurredAt: number;
  readonly phase: SecurityAuditPhase;
  readonly taskId: string;
  readonly runId?: string;
  readonly callId?: string;
  readonly actionId?: string;
  readonly actionDigest?: string;
  readonly actionSummary?: string;
  readonly capabilityTypes?: readonly CapabilityPrimitive[];
  readonly risks?: readonly string[];
  readonly classification?: DataClassification;
  readonly ruleIds?: readonly string[];
  readonly permissionMode?: PermissionMode;
  readonly userDecision?: 'allow_once' | 'allow_for_task' | 'deny' | 'cancel' | 'not_required';
  readonly ticketId?: string;
  readonly sandboxBackend?: string;
  readonly outcome?: 'allowed' | 'denied' | 'succeeded' | 'failed' | 'cancelled' | 'blocked';
  readonly errorCategory?: string;
}

export interface SecurityAuditTaskResource {
  append(records: readonly SecurityAuditRecord[]): Promise<void>;
  close(reason: string): Promise<void>;
}

export interface SecurityAuditParticipant {
  openTask(input: { readonly taskId: string; readonly workspaceRoot?: string }): Promise<SecurityAuditTaskResource>;
}

export interface AuditRetentionPolicy {
  readonly days: number;
  readonly maxBytes: number;
}

export const DEFAULT_AUDIT_RETENTION: AuditRetentionPolicy = Object.freeze({
  days: 30,
  maxBytes: 100 * MIB,
});

export function validateAuditRetention(value: Partial<AuditRetentionPolicy> = {}): AuditRetentionPolicy {
  const days = value.days ?? DEFAULT_AUDIT_RETENTION.days;
  const maxBytes = value.maxBytes ?? DEFAULT_AUDIT_RETENTION.maxBytes;
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new TypeError('Audit retention days must be an integer from 1 to 365');
  }
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > GIB) {
    throw new TypeError('Audit retention size must be an integer from 1 byte to 1 GiB');
  }
  return Object.freeze({ days, maxBytes });
}

export function defaultAuditDirectory(homeDirectory = homedir()): string {
  return join(homeDirectory, '.weave', 'security', 'audit');
}

export interface PrivateAccessControl {
  hardenDirectory(path: string): Promise<void>;
  hardenFile(path: string): Promise<void>;
}

export class HostPrivateAccessControl implements PrivateAccessControl {
  async hardenDirectory(path: string): Promise<void> {
    if (process.platform === 'win32') {
      await hardenWindows(path, true);
      return;
    }
    await chmod(path, 0o700);
    await assertPosixPrivate(path, 0o077);
  }

  async hardenFile(path: string): Promise<void> {
    if (process.platform === 'win32') {
      await hardenWindows(path, false);
      return;
    }
    await chmod(path, 0o600);
    await assertPosixPrivate(path, 0o077);
  }
}

export class AuditRetentionManager {
  constructor(
    private readonly root: string,
    private readonly policy: AuditRetentionPolicy = DEFAULT_AUDIT_RETENTION,
    private readonly now: () => number = Date.now,
  ) {}

  async enforce(): Promise<void> {
    const entries = await auditFiles(this.root);
    const cutoff = this.now() - this.policy.days * DAY_MS;
    const retained: AuditFile[] = [];
    for (const entry of entries) {
      if (entry.mtimeMs < cutoff) await unlink(entry.path);
      else retained.push(entry);
    }
    let total = retained.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of retained.sort((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path))) {
      if (total <= this.policy.maxBytes) break;
      await unlink(entry.path);
      total -= entry.size;
    }
  }
}

export interface DailyJsonlAuditSinkOptions {
  readonly root?: string;
  readonly retention?: Partial<AuditRetentionPolicy>;
  readonly now?: () => number;
  readonly accessControl?: PrivateAccessControl;
}

export class DailyJsonlAuditSink implements SecurityAuditParticipant {
  readonly root: string;
  private readonly retention: AuditRetentionPolicy;
  private readonly now: () => number;
  private readonly accessControl: PrivateAccessControl;

  constructor(options: DailyJsonlAuditSinkOptions = {}) {
    this.root = resolve(options.root ?? defaultAuditDirectory());
    this.retention = validateAuditRetention(options.retention);
    this.now = options.now ?? Date.now;
    this.accessControl = options.accessControl ?? new HostPrivateAccessControl();
  }

  async openTask(input: { readonly taskId: string; readonly workspaceRoot?: string }): Promise<SecurityAuditTaskResource> {
    if (input.workspaceRoot !== undefined && contains(input.workspaceRoot, this.root)) {
      throw new Error('AUDIT_STORAGE_INSIDE_WORKSPACE');
    }
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.accessControl.hardenDirectory(this.root);
    await new AuditRetentionManager(this.root, this.retention, this.now).enforce();
    return new DailyJsonlAuditTaskResource(input.taskId, this.root, this.now, this.accessControl, this.retention);
  }
}

class DailyJsonlAuditTaskResource implements SecurityAuditTaskResource {
  private closed = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly taskId: string,
    private readonly root: string,
    private readonly now: () => number,
    private readonly accessControl: PrivateAccessControl,
    private readonly retention: AuditRetentionPolicy,
  ) {}

  async append(records: readonly SecurityAuditRecord[]): Promise<void> {
    if (this.closed) throw new Error('AUDIT_RESOURCE_CLOSED');
    const encoded = records.map((record) => validateAuditRecord(record, this.taskId));
    if (encoded.length === 0) return this.queue;
    const operation = this.queue.then(async () => {
      const path = join(this.root, `${utcDay(this.now())}.jsonl`);
      const handle = await open(path, 'a', 0o600);
      try {
        await this.accessControl.hardenFile(path);
        await handle.writeFile(`${encoded.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await new AuditRetentionManager(this.root, this.retention, this.now).enforce();
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.queue;
  }
}

function validateAuditRecord(value: SecurityAuditRecord, taskId: string): SecurityAuditRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Audit record must be an object');
  const record = value as unknown as Record<string, unknown>;
  const unknown = Object.keys(record).find((key) => !AUDIT_KEYS.has(key));
  if (unknown !== undefined) throw new TypeError(`Audit record contains forbidden field: ${unknown}`);
  if (value.schemaVersion !== 1) throw new TypeError('Unsupported audit schema version');
  if (value.taskId !== taskId) throw new TypeError('Audit record task binding mismatch');
  for (const [name, item] of Object.entries(record)) {
    if (typeof item === 'string' && (item.length === 0 || item.length > 512)) throw new TypeError(`Invalid audit field: ${name}`);
  }
  return Object.freeze(structuredClone(value));
}

interface AuditFile { readonly path: string; readonly size: number; readonly mtimeMs: number }

async function auditFiles(root: string): Promise<AuditFile[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: AuditFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name)) continue;
    const path = join(root, entry.name);
    const info = await stat(path);
    files.push({ path, size: info.size, mtimeMs: info.mtimeMs });
  }
  return files;
}

function utcDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function contains(parent: string, child: string): boolean {
  const parentPath = normalize(resolve(parent));
  const childPath = normalize(resolve(child));
  const result = relative(parentPath, childPath);
  return result === '' || (!result.startsWith('..') && !isAbsolute(result));
}

function normalize(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

async function assertPosixPrivate(path: string, forbidden: number): Promise<void> {
  const info = await stat(path);
  if ((info.mode & forbidden) !== 0) throw new Error(`AUDIT_ACCESS_CONTROL_INVALID: ${path}`);
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error(`AUDIT_OWNER_INVALID: ${path}`);
}

async function hardenWindows(path: string, directory: boolean): Promise<void> {
  const account = [process.env.USERDOMAIN, process.env.USERNAME].filter(Boolean).join('\\') || process.env.USERNAME;
  if (account === undefined) throw new Error('AUDIT_WINDOWS_IDENTITY_UNAVAILABLE');
  const permission = directory ? '(OI)(CI)F' : 'F';
  await execFileAsync('icacls.exe', [path, '/inheritance:r', '/grant:r', `${account}:${permission}`, '/remove:g', '*S-1-1-0', '*S-1-5-32-545']);
}
