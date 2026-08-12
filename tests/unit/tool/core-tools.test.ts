import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCoreToolRegistry } from '../../../src/tool/core-tools.js';
import { Workspace } from '../../../src/tool/workspace.js';

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'weave-tools-'));
  const registry = createCoreToolRegistry(await Workspace.create(root));
  let id = 0;
  const call = (name: string, input: unknown, signal = new AbortController().signal) => registry.dispatch({
    callId: `c${++id}`, providerCallId: `p${id}`, name, input,
  }, { signal });
  return { root, registry, call };
}

describe('six core tools', () => {
  it('registers exactly the fixed six tools with expected execution modes', async () => {
    const { registry } = await setup();
    expect(registry.listDefinitions().map(({ name, executionMode }) => [name, executionMode])).toEqual([
      ['read_file', 'read_shared'], ['create_file', 'write_exclusive'], ['edit_file', 'write_exclusive'],
      ['bash', 'write_exclusive'], ['glob', 'read_shared'], ['grep', 'read_shared'],
    ]);
  });

  it('read_file supports ranges, BOM and bounded continuation metadata', async () => {
    const { root, call } = await setup();
    await writeFile(join(root, 'a.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('one\r\ntwo\nthree')]));
    await expect(call('read_file', { path: 'a.txt', startLine: 2, lineCount: 1 })).resolves.toMatchObject({
      isError: false, content: { data: { path: 'a.txt', content: 'two\n', startLine: 2, endLine: 2, totalLines: 3, truncated: false } },
    });
    await writeFile(join(root, 'large.txt'), `${'x'.repeat(40 * 1024)}\n${'y'.repeat(40 * 1024)}\ntail`);
    await expect(call('read_file', { path: 'large.txt' })).resolves.toMatchObject({
      isError: false, content: { data: { truncated: true, nextStartLine: 2 } },
    });
    await writeFile(join(root, 'long-line.txt'), 'x'.repeat(70 * 1024));
    const longLine = await call('read_file', { path: 'long-line.txt' });
    expect(longLine).toMatchObject({ isError: false, content: { data: { truncated: true } } });
    expect((longLine.content.data as Record<string, unknown>)).not.toHaveProperty('nextStartLine');
  });

  it('create_file creates parents and never overwrites', async () => {
    const { root, call } = await setup();
    const first = await call('create_file', { path: 'a/b.txt', content: 'hello' });
    expect(first).toMatchObject({ isError: false, content: { data: { path: 'a/b.txt', bytesWritten: 5, createdDirectories: ['a'] } } });
    expect(await readFile(join(root, 'a', 'b.txt'), 'utf8')).toBe('hello');
    await expect(call('create_file', { path: 'a/b.txt', content: 'replace' })).resolves.toMatchObject({
      isError: true, content: { error: { code: 'FILE_ALREADY_EXISTS' } },
    });
    await expect(call('create_file', { path: 'large.txt', content: 'x'.repeat(1024 * 1024 + 1) })).resolves.toMatchObject({
      isError: true, content: { error: { code: 'INVALID_ARGUMENT' } },
    });
  });

  it('edit_file applies sequential unique replacements atomically and detects ambiguity', async () => {
    const { root, call } = await setup();
    await writeFile(join(root, 'a.txt'), 'alpha beta');
    await expect(call('edit_file', { path: 'a.txt', edits: [
      { oldText: 'alpha', newText: 'gamma' }, { oldText: 'gamma beta', newText: 'done' },
    ] })).resolves.toMatchObject({ isError: false, content: { data: { replacements: 2 } } });
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('done');
    await writeFile(join(root, 'a.txt'), 'x x');
    await expect(call('edit_file', { path: 'a.txt', edits: [{ oldText: 'x', newText: 'y' }] })).resolves.toMatchObject({
      isError: true, content: { error: { code: 'AMBIGUOUS_MATCH' } },
    });
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('x x');
  });

  it('edit_file detects an external change before atomic commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'weave-edit-race-'));
    await writeFile(join(root, 'a.txt'), 'before');
    const workspace = await Workspace.create(root);
    const registry = createCoreToolRegistry(workspace, {
      beforeEditCommit: async (path) => { await writeFile(path, 'external-change'); },
    });
    const result = await registry.dispatch({
      callId: 'c', providerCallId: 'p', name: 'edit_file',
      input: { path: 'a.txt', edits: [{ oldText: 'before', newText: 'after' }] },
    }, { signal: new AbortController().signal });
    expect(result).toMatchObject({ isError: true, content: { error: { code: 'FILE_CHANGED_DURING_EDIT' } } });
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('external-change');
  });

  it('glob matches stable paths and always excludes fixed directories', async () => {
    const { root, call } = await setup();
    await mkdir(join(root, 'src')); await mkdir(join(root, 'node_modules'));
    await writeFile(join(root, 'src', 'b.ts'), 'b'); await writeFile(join(root, 'src', 'a.ts'), 'a');
    await writeFile(join(root, 'node_modules', 'hidden.ts'), 'x');
    await mkdir(join(root, '.github')); await writeFile(join(root, '.github', 'ci.yml'), 'x');
    await expect(call('glob', { pattern: '**/*.ts' })).resolves.toMatchObject({
      isError: false, content: { data: { files: ['src/a.ts', 'src/b.ts'], truncated: false } },
    });
    await expect(call('glob', { pattern: '.github/**/*.yml' })).resolves.toMatchObject({
      isError: false, content: { data: { files: ['.github/ci.yml'] } },
    });
  });

  it('grep performs literal line search with warnings and stable output', async () => {
    const { root, call } = await setup();
    await mkdir(join(root, 'src')); await writeFile(join(root, 'src', 'a.txt'), 'Alpha\nalpha alpha\n');
    await writeFile(join(root, 'src', 'binary.bin'), Buffer.from([0, 1, 2]));
    await expect(call('grep', { pattern: 'alpha', path: 'src', caseSensitive: false })).resolves.toMatchObject({
      isError: false, content: { data: { matches: [
        { path: 'src/a.txt', line: 1, text: 'Alpha' }, { path: 'src/a.txt', line: 2, text: 'alpha alpha' },
      ] } },
    });
  });

  it('bash returns output and treats nonzero exit as valuable error feedback', { timeout: 15_000 }, async () => {
    const { call } = await setup();
    await expect(call('bash', { command: 'printf ok' })).resolves.toMatchObject({
      isError: false, content: { data: { stdout: 'ok', exitCode: 0, timedOut: false } },
    });
    await expect(call('bash', { command: 'printf bad >&2; exit 7' })).resolves.toMatchObject({
      isError: true, content: { error: { code: 'COMMAND_FAILED', details: { exitCode: 7, stderr: 'bad' } } },
    });
    await expect(call('bash', { command: 'printf "x%.0s" {1..70000}' })).resolves.toMatchObject({
      isError: false, content: { data: { truncated: true } },
    });
    await expect(call('bash', { command: 'sleep 1', timeoutMs: 20 })).resolves.toMatchObject({
      isError: true, content: { error: { code: 'TOOL_TIMEOUT' } },
    });
    const controller = new AbortController(); controller.abort();
    await expect(call('bash', { command: 'printf never' }, controller.signal)).resolves.toMatchObject({
      isError: true, content: { error: { code: 'TOOL_CANCELLED' } },
    });
  });
});
