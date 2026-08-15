import { link, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SimulatedTransactionCrash,
  TaskWorkspaceView,
  WorkspaceCommitBroker,
  type WorkspaceChangeSet,
} from '../../../src/runner/index.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('TaskWorkspaceView', () => {
  it('keeps the host baseline read-only and extracts creates and edits from a private copy', async () => {
    const fixture = await setup();
    await writeFile(join(fixture.workspace, 'linked-source.txt'), 'linked', 'utf8');
    await link(join(fixture.workspace, 'linked-source.txt'), join(fixture.workspace, 'linked-peer.txt'));
    const view = await TaskWorkspaceView.create(fixture.workspace, fixture.root);
    try {
      await writeFile(join(view.root, 'alpha.txt'), 'after', 'utf8');
      await writeFile(join(view.root, 'created.txt'), 'created', 'utf8');
      await writeFile(join(view.root, 'linked-source.txt'), 'private', 'utf8');
      const changes = await view.extractChangeSet('action-1');
      expect(changes.changes.map((change) => change.path)).toEqual(['alpha.txt', 'created.txt', 'linked-peer.txt', 'linked-source.txt']);
      expect(await readFile(join(fixture.workspace, 'alpha.txt'), 'utf8')).toBe('before');
      expect(await readFile(join(fixture.workspace, 'linked-peer.txt'), 'utf8')).toBe('linked');
    } finally {
      await view.close();
    }
  });

  it('forks a private action view and limits structured change extraction to candidate paths', async () => {
    const fixture = await setup();
    const taskView = await TaskWorkspaceView.create(fixture.workspace, fixture.root);
    const actionView = await taskView.fork(fixture.root, ['alpha.txt']);
    try {
      await expect(readFile(join(actionView.root, 'beta.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await writeFile(join(actionView.root, 'alpha.txt'), 'after', 'utf8');
      await writeFile(join(actionView.root, 'beta.txt'), 'unlisted', 'utf8');

      const changes = await actionView.extractChangeSet('action-1', ['alpha.txt']);

      expect(changes.changes.map((change) => change.path)).toEqual(['alpha.txt']);
      expect(await readFile(join(taskView.root, 'alpha.txt'), 'utf8')).toBe('before');
      expect(await readFile(join(taskView.root, 'beta.txt'), 'utf8')).toBe('base');
    } finally {
      await actionView.close();
      await taskView.close();
    }
  });
});

describe('WorkspaceCommitBroker', () => {
  it('commits an authorized multi-file change set and removes recovery material', async () => {
    const fixture = await setup();
    const changeSet = await changes(fixture, [['alpha.txt', 'after'], ['created.txt', 'created']]);
    const broker = await createBroker(fixture, changeSet);
    const result = await broker.commit(changeSet);
    expect(result).toMatchObject({ state: 'CLEANED', paths: ['alpha.txt', 'created.txt'] });
    expect(await readFile(join(fixture.workspace, 'alpha.txt'), 'utf8')).toBe('after');
    expect(await readFile(join(fixture.workspace, 'created.txt'), 'utf8')).toBe('created');
    expect(await readdir(fixture.transactions)).toEqual([]);
  });

  it.each(['after_prepared', 'after_applying', 'after_replace:0', 'after_replace:1'])
  ('rolls back the complete action after a simulated crash at %s', async (point) => {
    const fixture = await setup();
    const changeSet = await changes(fixture, [['alpha.txt', 'after'], ['beta.txt', 'changed']]);
    const crashing = await createBroker(fixture, changeSet, point);
    await expect(crashing.commit(changeSet)).rejects.toBeInstanceOf(SimulatedTransactionCrash);
    const recovered = await createBroker(fixture, changeSet);
    expect(recovered.writesAvailable).toBe(true);
    expect(await readFile(join(fixture.workspace, 'alpha.txt'), 'utf8')).toBe('before');
    expect(await readFile(join(fixture.workspace, 'beta.txt'), 'utf8')).toBe('base');
    expect(await readdir(fixture.transactions)).toEqual([]);
  });

  it('keeps committed post-images when cleanup crashes after COMMITTED', async () => {
    const fixture = await setup();
    const changeSet = await changes(fixture, [['alpha.txt', 'after']]);
    const crashing = await createBroker(fixture, changeSet, 'after_committed');
    await expect(crashing.commit(changeSet)).rejects.toBeInstanceOf(SimulatedTransactionCrash);
    const recovered = await createBroker(fixture, changeSet);
    expect(recovered.writesAvailable).toBe(true);
    expect(await readFile(join(fixture.workspace, 'alpha.txt'), 'utf8')).toBe('after');
    expect(await readdir(fixture.transactions)).toEqual([]);
  });

  it('enters RECOVERY_CONFLICT without overwriting an external edit', async () => {
    const fixture = await setup();
    const changeSet = await changes(fixture, [['alpha.txt', 'after'], ['beta.txt', 'changed']]);
    const crashing = await createBroker(fixture, changeSet, 'after_replace:0');
    await expect(crashing.commit(changeSet)).rejects.toBeInstanceOf(SimulatedTransactionCrash);
    await writeFile(join(fixture.workspace, 'alpha.txt'), 'external', 'utf8');

    const recovered = await createBroker(fixture, changeSet);
    expect(recovered.writesAvailable).toBe(false);
    await expect(recovered.commit(changeSet)).rejects.toThrow('RECOVERY_CONFLICT');
    expect(await readFile(join(fixture.workspace, 'alpha.txt'), 'utf8')).toBe('external');
    await recovered.acknowledgeRecoveryConflict('transaction-1');
    expect(recovered.writesAvailable).toBe(true);
    expect(await readFile(join(fixture.workspace, 'alpha.txt'), 'utf8')).toBe('external');
  });

  it('rejects unauthorized paths and stale baselines before applying anything', async () => {
    const fixture = await setup();
    const changeSet = await changes(fixture, [['alpha.txt', 'after'], ['beta.txt', 'changed']]);
    const restricted = await WorkspaceCommitBroker.create({
      workspaceRoot: fixture.workspace, transactionRoot: fixture.transactions, allowedPaths: ['alpha.txt'],
    });
    await expect(restricted.commit(changeSet)).rejects.toThrow('PERMISSION_DENIED');
    expect(await readFile(join(fixture.workspace, 'alpha.txt'), 'utf8')).toBe('before');

    const broker = await createBroker(fixture, changeSet);
    await writeFile(join(fixture.workspace, 'alpha.txt'), 'external', 'utf8');
    await expect(broker.commit(changeSet)).rejects.toThrow('FILE_CHANGED_DURING_EDIT');
    expect(await readFile(join(fixture.workspace, 'beta.txt'), 'utf8')).toBe('base');
  });

  it('rejects a change set that deletes the complete workspace', async () => {
    const fixture = await setup();
    const view = await TaskWorkspaceView.create(fixture.workspace, fixture.root);
    let changeSet: WorkspaceChangeSet;
    try {
      await Promise.all([
        rm(join(view.root, 'alpha.txt')),
        rm(join(view.root, 'beta.txt')),
        writeFile(join(view.root, 'replacement.txt'), 'replacement', 'utf8'),
      ]);
      changeSet = await view.extractChangeSet('delete-root');
    } finally {
      await view.close();
    }
    const broker = await createBroker(fixture, changeSet);
    await expect(broker.commit(changeSet)).rejects.toThrow('WORKSPACE_ROOT_DELETE');
    expect(await readFile(join(fixture.workspace, 'alpha.txt'), 'utf8')).toBe('before');
    expect(await readFile(join(fixture.workspace, 'beta.txt'), 'utf8')).toBe('base');
  });
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'weave-transaction-test-'));
  temporaryRoots.push(root);
  const workspace = join(root, 'workspace');
  const transactions = join(root, 'transactions');
  await mkdir(workspace);
  await mkdir(transactions);
  await writeFile(join(workspace, 'alpha.txt'), 'before', 'utf8');
  await writeFile(join(workspace, 'beta.txt'), 'base', 'utf8');
  return { root, workspace, transactions };
}

async function changes(fixture: Awaited<ReturnType<typeof setup>>, edits: readonly (readonly [string, string])[]): Promise<WorkspaceChangeSet> {
  const view = await TaskWorkspaceView.create(fixture.workspace, fixture.root);
  try {
    for (const [path, content] of edits) await writeFile(join(view.root, path), content, 'utf8');
    return await view.extractChangeSet('action-1');
  } finally {
    await view.close();
  }
}

async function createBroker(
  fixture: Awaited<ReturnType<typeof setup>>,
  changeSet: WorkspaceChangeSet,
  crashPoint?: string,
) {
  return WorkspaceCommitBroker.create({
    workspaceRoot: fixture.workspace,
    transactionRoot: fixture.transactions,
    allowedPaths: changeSet.changes.map((change) => change.path),
    createId: () => 'transaction-1',
    ...(crashPoint === undefined ? {} : {
      fault: (point: string) => { if (point === crashPoint) throw new SimulatedTransactionCrash(point); },
    }),
  });
}
