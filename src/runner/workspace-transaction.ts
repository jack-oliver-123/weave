import { createHash, randomUUID } from 'node:crypto';
import {
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export type TransactionState = 'PREPARED' | 'APPLYING' | 'COMMITTED' | 'CLEANED' | 'RECOVERY_CONFLICT';

export interface FileSnapshot {
  readonly exists: boolean;
  readonly identity?: string;
  readonly digest?: string;
  readonly size?: number;
}

export interface WorkspaceChange {
  readonly path: string;
  readonly baseline: FileSnapshot;
  readonly postImage: Uint8Array | null;
}

export interface WorkspaceChangeSet {
  readonly actionId: string;
  readonly changes: readonly WorkspaceChange[];
}

export interface CommitResult {
  readonly transactionId: string;
  readonly state: 'CLEANED';
  readonly paths: readonly string[];
}

export interface CommitBrokerOptions {
  readonly workspaceRoot: string;
  readonly transactionRoot: string;
  readonly allowedPaths: readonly string[];
  readonly createId?: () => string;
  readonly fault?: (point: string) => void | Promise<void>;
}

interface JournalEntry {
  readonly path: string;
  readonly baseline: FileSnapshot;
  readonly postDigest?: string;
  readonly stage?: string;
  readonly backup?: string;
}

interface TransactionJournal {
  readonly schemaVersion: 1;
  readonly transactionId: string;
  readonly actionId: string;
  state: TransactionState;
  readonly entries: readonly JournalEntry[];
}

const EXCLUDED_NAMES = new Set(['.git', '.weave', 'node_modules']);

export class TaskWorkspaceView {
  readonly root: string;
  private readonly hostBaseline = new Map<string, FileSnapshot>();
  private readonly viewBaseline = new Map<string, FileSnapshot>();
  private readonly copiedHardlinks = new Map<string, string>();
  private closed = false;

  private constructor(readonly workspaceRoot: string, root: string) { this.root = root; }

  static async create(workspaceRoot: string, parent = tmpdir()): Promise<TaskWorkspaceView> {
    const source = await realpath(workspaceRoot);
    const root = await mkdtemp(join(parent, 'weave-task-workspace-'));
    const view = new TaskWorkspaceView(source, root);
    await view.copyTree(source, root, '');
    return view;
  }

  async extractChangeSet(actionId: string): Promise<WorkspaceChangeSet> {
    this.assertOpen();
    const current = new Map<string, FileSnapshot>();
    await collectSnapshots(this.root, this.root, current);
    const paths = [...new Set([...this.viewBaseline.keys(), ...current.keys()])].sort();
    const changes: WorkspaceChange[] = [];
    for (const path of paths) {
      const before = this.viewBaseline.get(path) ?? { exists: false };
      const after = current.get(path) ?? { exists: false };
      if (sameSnapshot(before, after)) continue;
      changes.push(Object.freeze({
        path,
        baseline: this.hostBaseline.get(path) ?? { exists: false },
        postImage: after.exists ? new Uint8Array(await readFile(resolveRelative(this.root, path))) : null,
      }));
    }
    return Object.freeze({ actionId, changes: Object.freeze(changes) });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await rm(this.root, { recursive: true, force: true });
  }

  private async copyTree(sourceRoot: string, targetRoot: string, current: string): Promise<void> {
    const sourceDirectory = resolveRelative(sourceRoot, current);
    for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
      if (EXCLUDED_NAMES.has(entry.name)) continue;
      const path = current === '' ? entry.name : `${current}/${entry.name}`;
      const source = resolveRelative(sourceRoot, path);
      const target = resolveRelative(targetRoot, path);
      const metadata = await lstat(source, { bigint: true });
      if (metadata.isDirectory()) {
        await mkdir(target);
        await this.copyTree(sourceRoot, targetRoot, path);
      } else if (metadata.isSymbolicLink()) {
        const resolved = await realpath(source);
        assertInside(sourceRoot, resolved);
        await symlink(await readlink(source), target, (await stat(resolved)).isDirectory() ? 'dir' : 'file');
      } else if (metadata.isFile()) {
        const baselineSnapshot = await snapshot(source);
        this.hostBaseline.set(path, baselineSnapshot);
        const hardlinkKey = `${metadata.dev}:${metadata.ino}`;
        const existing = metadata.nlink > 1n ? this.copiedHardlinks.get(hardlinkKey) : undefined;
        if (existing === undefined) {
          await copyFile(source, target);
          if (metadata.nlink > 1n) this.copiedHardlinks.set(hardlinkKey, target);
        } else {
          await link(existing, target);
        }
        this.viewBaseline.set(path, await snapshot(target));
      }
    }
  }

  private assertOpen(): void { if (this.closed) throw new Error('TASK_WORKSPACE_CLOSED'); }
}

export class WorkspaceCommitBroker {
  readonly workspaceRoot: string;
  readonly transactionRoot: string;
  private readonly allowedPaths: ReadonlySet<string>;
  private readonly createId: () => string;
  private readonly fault?: CommitBrokerOptions['fault'];
  private writeDisabled = false;

  private constructor(options: CommitBrokerOptions, workspaceRoot: string, transactionRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.transactionRoot = transactionRoot;
    this.allowedPaths = new Set(options.allowedPaths.map((path) => path === '.' ? '.' : normalizeRelative(path)));
    this.createId = options.createId ?? randomUUID;
    this.fault = options.fault;
  }

  static async create(options: CommitBrokerOptions): Promise<WorkspaceCommitBroker> {
    const workspaceRoot = await realpath(options.workspaceRoot);
    await mkdir(options.transactionRoot, { recursive: true });
    const transactionRoot = await realpath(options.transactionRoot);
    assertOutside(workspaceRoot, transactionRoot);
    const [workspaceDevice, transactionDevice] = await Promise.all([
      stat(workspaceRoot, { bigint: true }), stat(transactionRoot, { bigint: true }),
    ]);
    if (workspaceDevice.dev !== transactionDevice.dev) throw new Error('TRANSACTION_ROOT_NOT_SAME_VOLUME');
    const broker = new WorkspaceCommitBroker(options, workspaceRoot, transactionRoot);
    await broker.recover();
    return broker;
  }

  get writesAvailable(): boolean { return !this.writeDisabled; }

  async listRecoveryConflicts(): Promise<readonly string[]> {
    const conflicts: string[] = [];
    for (const item of await readdir(this.transactionRoot, { withFileTypes: true })) {
      if (!item.isDirectory()) continue;
      try {
        const journal = JSON.parse(await readFile(join(this.transactionRoot, item.name, 'journal.json'), 'utf8')) as TransactionJournal;
        if (journal.state === 'RECOVERY_CONFLICT') conflicts.push(journal.transactionId);
      } catch { conflicts.push(item.name); }
    }
    return Object.freeze(conflicts.sort());
  }

  async commit(changeSet: WorkspaceChangeSet): Promise<CommitResult> {
    if (this.writeDisabled) throw new Error('RECOVERY_CONFLICT');
    if (changeSet.changes.length === 0) return { transactionId: this.createId(), state: 'CLEANED', paths: [] };
    const planned = [];
    for (const change of changeSet.changes) {
      const path = normalizeRelative(change.path);
      this.assertAuthorized(path);
      const current = await snapshot(resolveRelative(this.workspaceRoot, path));
      if (!sameSnapshot(change.baseline, current)) throw new Error('FILE_CHANGED_DURING_EDIT');
      planned.push({ change, path, current });
    }
    const transactionId = this.createId();
    const directory = join(this.transactionRoot, transactionId);
    await mkdir(join(directory, 'stage'), { recursive: true });
    await mkdir(join(directory, 'backup'), { recursive: true });
    const entries: JournalEntry[] = [];
    for (const [index, item] of planned.entries()) {
      const { change, path, current } = item;
      const target = resolveRelative(this.workspaceRoot, path);
      const stage = change.postImage === null ? undefined : `stage/${index}`;
      const backup = current.exists ? `backup/${index}` : undefined;
      if (stage !== undefined) await durableWrite(join(directory, stage), change.postImage!);
      if (backup !== undefined) await copyFile(target, join(directory, backup));
      entries.push({
        path, baseline: current,
        ...(stage === undefined ? {} : { stage, postDigest: digest(change.postImage!) }),
        ...(backup === undefined ? {} : { backup }),
      });
    }
    const journal: TransactionJournal = {
      schemaVersion: 1, transactionId, actionId: changeSet.actionId, state: 'PREPARED', entries,
    };
    await writeJournal(directory, journal);
    await this.inject('after_prepared');
    for (const entry of entries) {
      if (!sameSnapshot(entry.baseline, await snapshot(resolveRelative(this.workspaceRoot, entry.path)))) {
        await this.cleanup(directory, journal);
        throw new Error('FILE_CHANGED_DURING_EDIT');
      }
    }
    journal.state = 'APPLYING';
    await writeJournal(directory, journal);
    await this.inject('after_applying');
    try {
      for (const [index, entry] of entries.entries()) {
        await this.applyEntry(directory, entry);
        await this.inject(`after_replace:${index}`);
      }
      journal.state = 'COMMITTED';
      await writeJournal(directory, journal);
      await this.inject('after_committed');
      await this.cleanup(directory, journal);
      return Object.freeze({ transactionId, state: 'CLEANED', paths: Object.freeze(entries.map((entry) => entry.path)) });
    } catch (error) {
      if (error instanceof SimulatedTransactionCrash) throw error;
      await this.rollback(directory, journal);
      await this.cleanup(directory, journal);
      throw error;
    }
  }

  async recover(): Promise<void> {
    this.writeDisabled = false;
    for (const item of await readdir(this.transactionRoot, { withFileTypes: true })) {
      if (!item.isDirectory()) continue;
      const directory = join(this.transactionRoot, item.name);
      let journal: TransactionJournal;
      try { journal = JSON.parse(await readFile(join(directory, 'journal.json'), 'utf8')) as TransactionJournal; }
      catch { this.writeDisabled = true; continue; }
      if (journal.state === 'RECOVERY_CONFLICT') { this.writeDisabled = true; continue; }
      if (journal.state === 'APPLYING') {
        try { await this.rollback(directory, journal); await this.cleanup(directory, journal); }
        catch { journal.state = 'RECOVERY_CONFLICT'; await writeJournal(directory, journal); this.writeDisabled = true; }
      } else if (journal.state === 'PREPARED' || journal.state === 'COMMITTED' || journal.state === 'CLEANED') {
        await this.cleanup(directory, journal);
      }
    }
  }

  async acknowledgeRecoveryConflict(transactionId: string): Promise<void> {
    const directory = resolveRelative(this.transactionRoot, transactionId);
    const journal = JSON.parse(await readFile(join(directory, 'journal.json'), 'utf8')) as TransactionJournal;
    if (journal.state !== 'RECOVERY_CONFLICT') throw new Error('RECOVERY_CONFLICT_NOT_FOUND');
    await rm(directory, { recursive: true, force: true });
    await this.recover();
  }

  private async applyEntry(directory: string, entry: JournalEntry): Promise<void> {
    const target = resolveRelative(this.workspaceRoot, entry.path);
    await mkdir(dirname(target), { recursive: true });
    if (entry.stage === undefined) await rm(target, { force: true });
    else await rename(join(directory, entry.stage), target);
  }

  private async rollback(directory: string, journal: TransactionJournal): Promise<void> {
    for (const entry of [...journal.entries].reverse()) {
      const target = resolveRelative(this.workspaceRoot, entry.path);
      const current = await snapshot(target);
      const isPost = entry.postDigest === undefined ? !current.exists : current.digest === entry.postDigest;
      if (matchesBaselineContent(current, entry.baseline)) continue;
      if (!isPost) throw new Error('RECOVERY_CONFLICT');
      if (entry.backup === undefined) await rm(target, { force: true });
      else await rename(join(directory, entry.backup), target);
    }
  }

  private async cleanup(directory: string, journal: TransactionJournal): Promise<void> {
    journal.state = 'CLEANED';
    await writeJournal(directory, journal);
    await rm(directory, { recursive: true, force: true });
  }

  private assertAuthorized(path: string): void {
    if (![...this.allowedPaths].some((allowed) => allowed === '.' || path === allowed || path.startsWith(`${allowed}/`))) {
      throw new Error('PERMISSION_DENIED');
    }
  }

  private async inject(point: string): Promise<void> { await this.fault?.(point); }
}

export class SimulatedTransactionCrash extends Error {
  constructor(readonly point: string) { super(`Simulated transaction crash at ${point}`); }
}

export async function captureFileSnapshot(workspaceRoot: string, path: string): Promise<FileSnapshot> {
  return snapshot(resolveRelative(workspaceRoot, normalizeRelative(path)));
}

export async function captureWorkspaceSnapshots(workspaceRoot: string): Promise<ReadonlyMap<string, FileSnapshot>> {
  const root = await realpath(workspaceRoot);
  const snapshots = new Map<string, FileSnapshot>();
  await collectSnapshots(root, root, snapshots);
  return snapshots;
}

export function defaultTransactionRoot(workspaceRoot: string): string {
  const key = createHash('sha256').update(resolve(workspaceRoot)).digest('hex').slice(0, 16);
  return join(dirname(resolve(workspaceRoot)), `.weave-transactions-${key}`);
}

async function collectSnapshots(root: string, directory: string, output: Map<string, FileSnapshot>): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (EXCLUDED_NAMES.has(entry.name)) continue;
    const absolute = join(directory, entry.name);
    const path = relative(root, absolute).split(sep).join('/');
    if (entry.isDirectory()) await collectSnapshots(root, absolute, output);
    else if (entry.isFile()) output.set(path, await snapshot(absolute));
  }
}

async function snapshot(path: string): Promise<FileSnapshot> {
  try {
    const metadata = await lstat(path, { bigint: true });
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('TARGET_IS_SYMLINK');
    const content = await readFile(path);
    return Object.freeze({
      exists: true,
      identity: `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeNs}`,
      digest: digest(content),
      size: Number(metadata.size),
    });
  } catch (error) {
    if (isMissing(error)) return Object.freeze({ exists: false });
    throw error;
  }
}

async function durableWrite(path: string, content: Uint8Array): Promise<void> {
  await writeFile(path, content, { flag: 'wx' });
  const handle = await open(path, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeJournal(directory: string, journal: TransactionJournal): Promise<void> {
  const target = join(directory, 'journal.json');
  const temporary = join(directory, 'journal.next');
  await writeFile(temporary, JSON.stringify(journal), 'utf8');
  const handle = await open(temporary, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, target);
}

function normalizeRelative(path: string): string {
  if (path.length === 0 || path.includes('\0') || isAbsolute(path) || path.includes('\\')) throw new Error('PATH_OUTSIDE_WORKSPACE');
  const parts = path.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) throw new Error('PATH_OUTSIDE_WORKSPACE');
  return parts.join('/');
}

function resolveRelative(root: string, path: string): string {
  const target = resolve(root, path);
  assertInside(root, target);
  return target;
}

function assertInside(root: string, target: string): void {
  const path = relative(root, target);
  if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error('PATH_OUTSIDE_WORKSPACE');
}

function assertOutside(workspace: string, target: string): void {
  const path = relative(workspace, target);
  if (path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))) throw new Error('TRANSACTION_ROOT_INSIDE_WORKSPACE');
}

function digest(content: Uint8Array): string { return createHash('sha256').update(content).digest('base64url'); }
function sameSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.exists === right.exists && (!left.exists || (left.digest === right.digest && left.identity === right.identity));
}
function matchesBaselineContent(left: FileSnapshot, baseline: FileSnapshot): boolean {
  return left.exists === baseline.exists && (!left.exists || left.digest === baseline.digest);
}
function isMissing(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'; }
