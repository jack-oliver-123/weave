import { describe, expect, it } from 'vitest';
import { PendingAuthorization } from '../../../src/security/index.js';

const request = {
  taskId: 'task-1', runId: 'run-1', authorizationRequestId: 'auth-1', authorizationEpoch: 3,
  items: [
    { callId: 'call-1', actionDigest: 'digest-1', toolName: 'edit_file', summary: 'edit', capabilityTypes: ['FilesystemWrite'], risks: [] },
    { callId: 'call-2', actionDigest: 'digest-2', toolName: 'bash', summary: 'run', capabilityTypes: ['ProcessSpawn'], risks: ['RAW_SHELL'] },
  ],
} as const;

describe('PendingAuthorization', () => {
  it('publishes one batch and accepts an exact per-item decision set', async () => {
    const pending = new PendingAuthorization(request);
    const waiting = pending.wait(new AbortController().signal);
    pending.resolve({
      taskId: 'task-1', runId: 'run-1', authorizationRequestId: 'auth-1', authorizationEpoch: 3,
      decisions: [
        { actionDigest: 'digest-1', choice: 'allow_once' },
        { actionDigest: 'digest-2', choice: 'deny' },
      ],
    });
    await expect(waiting).resolves.toEqual([
      { actionDigest: 'digest-1', choice: 'allow_once' },
      { actionDigest: 'digest-2', choice: 'deny' },
    ]);
  });

  it.each([
    ['missing', [{ actionDigest: 'digest-1', choice: 'allow_once' }]],
    ['extra', [
      { actionDigest: 'digest-1', choice: 'allow_once' },
      { actionDigest: 'digest-2', choice: 'deny' },
      { actionDigest: 'digest-3', choice: 'deny' },
    ]],
    ['duplicate', [
      { actionDigest: 'digest-1', choice: 'allow_once' },
      { actionDigest: 'digest-1', choice: 'deny' },
    ]],
  ] as const)('keeps waiting after %s decisions', async (_name, decisions) => {
    const pending = new PendingAuthorization(request);
    const waiting = pending.wait(new AbortController().signal);
    expect(() => pending.resolve({
      taskId: 'task-1', runId: 'run-1', authorizationRequestId: 'auth-1', authorizationEpoch: 3,
      decisions,
    })).toThrow('AUTHORIZATION_DECISIONS_INCOMPLETE');
    pending.resolve({
      taskId: 'task-1', runId: 'run-1', authorizationRequestId: 'auth-1', authorizationEpoch: 3,
      decisions: [
        { actionDigest: 'digest-1', choice: 'allow_for_task' },
        { actionDigest: 'digest-2', choice: 'cancel' },
      ],
    });
    await expect(waiting).resolves.toHaveLength(2);
  });

  it('keeps waiting after stale identifiers and rejects a second resolution', async () => {
    const pending = new PendingAuthorization(request);
    const waiting = pending.wait(new AbortController().signal);
    expect(() => pending.resolve({
      taskId: 'task-1', runId: 'other-run', authorizationRequestId: 'auth-1', authorizationEpoch: 3,
      decisions: request.items.map((item) => ({ actionDigest: item.actionDigest, choice: 'deny' as const })),
    })).toThrow('STALE_AUTHORIZATION_REQUEST');
    const valid = {
      taskId: 'task-1', runId: 'run-1', authorizationRequestId: 'auth-1', authorizationEpoch: 3,
      decisions: request.items.map((item) => ({ actionDigest: item.actionDigest, choice: 'deny' as const })),
    };
    pending.resolve(valid);
    await waiting;
    expect(() => pending.resolve(valid)).toThrow('STALE_AUTHORIZATION_REQUEST');
  });
});
