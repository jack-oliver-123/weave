import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('AgentLoop ActionTask boundary', () => {
  it('does not import or retain direct model clients and raw conversation history', async () => {
    const source = await readFile(new URL('../../../src/engine/agent-loop.ts', import.meta.url), 'utf8');

    expect(source).not.toMatch(/\bLlmClient\b/);
    expect(source).not.toMatch(/\bLlmRequest\b/);
    expect(source).not.toMatch(/\bChatMessage\b/);
    expect(source).not.toMatch(/\bToolExecutor\b/);
    expect(source).not.toMatch(/\bToolRegistry\b/);
    expect(source).not.toMatch(/readonly messages:/);
    expect(source).not.toMatch(/\.stream\(/);
    expect(source).not.toMatch(/\.execute\(/);
  });
});
