import { describe, expect, it } from 'vitest';
import { defaultResourceBudget, deriveActionSandboxProfile, resolveResourceBudget } from '../../../src/runner/index.js';
import type { NormalizedAction } from '../../../src/security/index.js';

const GIB = 1024 ** 3;

describe('Runner resource profiles', () => {
  it('derives the documented defaults from host limits', () => {
    expect(defaultResourceBudget({ cpuCores: 16, memoryBytes: 32 * GIB })).toEqual({
      cpuCores: 4, memoryBytes: 4 * GIB, pids: 128, actionTimeoutMs: 120_000,
      taskProcessTimeoutMs: 3_600_000, diskBytes: 4 * GIB,
      stdoutBytes: 64 * 1024, stderrBytes: 64 * 1024, batchOutputBytes: 512 * 1024,
      networkBytes: 512 * 1024 ** 2,
    });
  });

  it('accepts user limits within product caps and permits project policy only to tighten', () => {
    const host = { cpuCores: 16, memoryBytes: 32 * GIB };
    expect(resolveResourceBudget(host, { cpuCores: 8, memoryBytes: 16 * GIB }, { cpuCores: 2 })).toMatchObject({
      cpuCores: 2, memoryBytes: 16 * GIB,
    });
    expect(() => resolveResourceBudget(host, { cpuCores: 9 })).toThrow('cpuCores');
    expect(() => resolveResourceBudget(host, {}, { pids: 129 })).toThrow('only tighten pids');
  });

  it('derives a minimal profile and never exposes environment, control IPC, or ticket', () => {
    const action: NormalizedAction = {
      schemaVersion: 1, actionId: 'a', actionType: 'read_file', input: {}, digest: 'digest',
      manifest: { schemaVersion: 1, requirements: [{ type: 'FilesystemRead', paths: ['src/a.ts'] }] },
    };
    const profile = deriveActionSandboxProfile(action, defaultResourceBudget({ cpuCores: 4, memoryBytes: 8 * GIB }));
    expect(profile).toMatchObject({
      filesystemRead: ['src/a.ts'], filesystemWrite: [], networkEnabled: false,
      environment: {}, controlChannelVisible: false, ticketVisible: false,
    });
  });
});
