import { mkdtemp, readFile, rm, utimes, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AuditRetentionManager,
  DailyJsonlAuditSink,
  validateAuditRetention,
  type PrivateAccessControl,
  type SecurityAuditRecord,
} from '../../../src/security/index.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('security audit sink', () => {
  it('writes one durable daily JSONL batch containing metadata only', async () => {
    const root = await temporaryRoot();
    const access: PrivateAccessControl = {
      hardenDirectory: vi.fn(async () => undefined),
      hardenFile: vi.fn(async () => undefined),
    };
    const sink = new DailyJsonlAuditSink({ root, now: () => Date.UTC(2026, 7, 14), accessControl: access });
    const task = await sink.openTask({ taskId: 'task-1', workspaceRoot: join(root, '..', 'workspace') });
    await task.append([
      record('event-1', 'call-1', 'action:v1:opaque-1'),
      record('event-2', 'call-2', 'action:v1:opaque-2'),
    ]);
    await task.close('completed');

    const text = await readFile(join(root, '2026-08-14.jsonl'), 'utf8');
    const lines = text.trim().split('\n').map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => line.callId)).toEqual(['call-1', 'call-2']);
    expect(text).not.toMatch(/prompt|command|stdout|stderr|fileContent|credential/i);
    expect(access.hardenDirectory).toHaveBeenCalledWith(root);
    expect(access.hardenFile).toHaveBeenCalledWith(join(root, '2026-08-14.jsonl'));
  });

  it('rejects arbitrary fields instead of serializing sensitive content', async () => {
    const root = await temporaryRoot();
    const sink = new DailyJsonlAuditSink({ root, accessControl: noOpAccess() });
    const task = await sink.openTask({ taskId: 'task-1' });
    const malicious = { ...record('event-1', 'call-1', 'action:v1:opaque'), prompt: 'canary-secret' } as SecurityAuditRecord;
    await expect(task.append([malicious])).rejects.toThrow('forbidden field: prompt');
  });

  it('rejects audit storage located inside the workspace', async () => {
    const root = await temporaryRoot();
    const auditRoot = join(root, 'workspace', '.audit');
    const sink = new DailyJsonlAuditSink({ root: auditRoot, accessControl: noOpAccess() });
    await expect(sink.openTask({ taskId: 'task-1', workspaceRoot: join(root, 'workspace') }))
      .rejects.toThrow('AUDIT_STORAGE_INSIDE_WORKSPACE');
  });

  it('validates retention product bounds', () => {
    expect(validateAuditRetention()).toEqual({ days: 30, maxBytes: 100 * 1024 * 1024 });
    expect(validateAuditRetention({ days: 1, maxBytes: 1 })).toEqual({ days: 1, maxBytes: 1 });
    expect(validateAuditRetention({ days: 365, maxBytes: 1024 ** 3 })).toEqual({ days: 365, maxBytes: 1024 ** 3 });
    expect(() => validateAuditRetention({ days: 0 })).toThrow('1 to 365');
    expect(() => validateAuditRetention({ days: 366 })).toThrow('1 to 365');
    expect(() => validateAuditRetention({ maxBytes: 5 * 1024 ** 3 })).toThrow('1 GiB');
  });

  it('removes expired files and then oldest files until under the capacity limit', async () => {
    const root = await temporaryRoot();
    await mkdir(root, { recursive: true });
    const now = Date.UTC(2026, 7, 14);
    await fileAt(root, '2026-06-01.jsonl', 'old', now - 40 * 86_400_000);
    await fileAt(root, '2026-08-12.jsonl', '12345', now - 2 * 86_400_000);
    await fileAt(root, '2026-08-13.jsonl', '67890', now - 86_400_000);
    await new AuditRetentionManager(root, { days: 30, maxBytes: 5 }, () => now).enforce();
    await expect(readFile(join(root, '2026-06-01.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(root, '2026-08-12.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(root, '2026-08-13.jsonl'), 'utf8')).resolves.toBe('67890');
  });
});

function record(eventId: string, callId: string, actionDigest: string): SecurityAuditRecord {
  return {
    schemaVersion: 1, eventId, occurredAt: Date.UTC(2026, 7, 14), phase: 'preflight',
    taskId: 'task-1', runId: 'run-1', callId, actionDigest,
    actionSummary: '调用 read_file', capabilityTypes: ['FilesystemRead'],
    risks: [], classification: 'ordinary', ruleIds: [], permissionMode: 'read_only',
    userDecision: 'not_required', outcome: 'allowed',
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'weave-audit-'));
  roots.push(root);
  return root;
}

function noOpAccess(): PrivateAccessControl {
  return { hardenDirectory: async () => undefined, hardenFile: async () => undefined };
}

async function fileAt(root: string, name: string, content: string, mtimeMs: number): Promise<void> {
  const path = join(root, name);
  await writeFile(path, content);
  const date = new Date(mtimeMs);
  await utimes(path, date, date);
}
