import { describe, expect, it } from 'vitest';
import { executionActionDigest, normalizeToolCall, summarizeToolCall } from '../../../src/security/index.js';
import { defaultResourceBudget, deriveActionSandboxProfile } from '../../../src/runner/index.js';
import type { ToolCallRequest } from '../../../src/shared/types.js';

describe('Bash capability manifest', () => {
  it('uses a fixed executable/argv and conservatively declares the whole workspace for raw shell', () => {
    const call: ToolCallRequest = {
      callId: 'bash-1', providerCallId: 'provider-1', name: 'bash',
      input: { command: 'printf ok', cwd: 'src' },
    };
    const action = normalizeToolCall(call, executionActionDigest(call));
    expect(action?.manifest.requirements).toEqual([
      { type: 'FilesystemRead', paths: ['.'] },
      { type: 'FilesystemWrite', paths: ['.'] },
      {
        type: 'ProcessSpawn', executable: 'bash', argv: ['--noprofile', '--norc', '-c', 'printf ok'],
        cwd: 'src', lifetime: 'action', rawShell: true,
      },
    ]);
    const profile = deriveActionSandboxProfile(action!, defaultResourceBudget({ cpuCores: 8, memoryBytes: 16 * 1024 ** 3 }));
    expect(profile).toMatchObject({
      filesystemRead: ['.'], filesystemWrite: ['.'], networkEnabled: false,
      environment: {}, controlChannelVisible: false, ticketVisible: false,
      stdoutBytes: 64 * 1024, stderrBytes: 64 * 1024, actionTimeoutMs: 120_000,
    });
  });

  it('keeps Task-lifetime processes explicit so authorization always asks and the registry can revoke them', () => {
    const call: ToolCallRequest = {
      callId: 'bash-task', providerCallId: 'provider-task', name: 'bash',
      input: { command: 'serve', lifetime: 'task' },
    };
    const action = normalizeToolCall(call, executionActionDigest(call));
    expect(action?.manifest.requirements).toContainEqual(expect.objectContaining({
      type: 'ProcessSpawn', lifetime: 'task', rawShell: true,
    }));
  });

  it('shows the bounded command and target without allowing terminal control characters', () => {
    const summary = summarizeToolCall({
      callId: 'bash-summary', providerCallId: 'provider-summary', name: 'bash',
      input: { command: `printf secret\u001b[31m${'x'.repeat(300)}`, cwd: 'src\nother' },
    });
    expect(summary).toContain('printf secret [31m');
    expect(summary).toContain('cwd: src other');
    expect(summary.length).toBeLessThanOrEqual(180);
    expect(summary).not.toContain('\u001b');
  });
});
