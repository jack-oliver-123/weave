import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('security architecture source scan', () => {
  it('keeps AgentLoop separated from model, tools, Runner, and raw payloads', async () => {
    const source = await sourceOf('src/engine/agent-loop.ts');
    expect(source).not.toMatch(/\bLlmClient\b|\bToolExecutor\b|\bToolRegistry\b|\bRunnerSupervisor\b|\.stream\(|\.execute\(/);
  });

  it('keeps production free from host tool fallback and plaintext credential fields', async () => {
    const source = await sourceOf('src/main.ts');
    expect(source).not.toMatch(/from ['"]\.\/tool\/|createCoreToolRegistry|ToolCallScheduler|apiKey\s*:/);
    expect(source).toMatch(/createPlatformCredentialStore/);
    expect(source).toMatch(/createCertifiedReadRunnerRuntime/);
  });

  it('keeps host bash and raw network out of production adapters', async () => {
    const files = await Promise.all([
      sourceOf('src/main.ts'), sourceOf('src/engine/model-action-gateway.ts'), sourceOf('src/runner/runtime.ts'),
    ]);
    const source = files.join('\n');
    expect(source).not.toMatch(/spawn\(\s*['"](?:bash|bash\.exe)['"]|net\.connect|createConnection\(/);
    expect(source).not.toMatch(/--unsafe|full_access/);
  });

  it('rejects plaintext api_key in the example and retains only the warned migration parser', async () => {
    expect(await sourceOf('config.example.yaml')).not.toMatch(/api_key\s*:/);
    const parser = await sourceOf('src/config/index.ts');
    expect(parser).toMatch(/api_key plaintext is forbidden/);
    expect(parser).toMatch(/credential migration is deprecated/);
  });
});

async function sourceOf(path: string): Promise<string> {
  return readFile(new URL(`../../../${path}`, import.meta.url), 'utf8');
}
