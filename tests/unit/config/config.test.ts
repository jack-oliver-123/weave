import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../../src/config/index.js';

const tempDirs: string[] = [];

async function writeConfig(content: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'weave-config-'));
  tempDirs.push(directory);
  const path = join(directory, 'config.yaml');
  await writeFile(path, content, 'utf8');
  return path;
}

function validConfig(overrides = ''): string {
  return `
default_profile: claude
profiles:
  - name: claude
    protocol: anthropic-messages
    model: claude-test
    base_url: https://api.anthropic.com
    api_key: plain-secret-value
    thinking: false
${overrides}`;
}

afterEach(() => {
  tempDirs.length = 0;
});

describe('loadConfig', () => {
  it('loads the default user path and default profile', async () => {
    const home = await mkdtemp(join(tmpdir(), 'weave-home-'));
    tempDirs.push(home);
    const configDirectory = join(home, '.weave');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(configDirectory);
    await writeFile(join(configDirectory, 'config.yaml'), validConfig(), 'utf8');

    const loaded = await loadConfig({ homeDirectory: home });

    expect(loaded.path).toBe(join(home, '.weave', 'config.yaml'));
    expect(loaded.selected.name).toBe('claude');
    expect(loaded.selected.maxTokens).toBe(4096);
  });

  it('lets the command line select another unique profile', async () => {
    const path = await writeConfig(`${validConfig()}
  - name: responses
    protocol: openai-responses
    model: gpt-test
    base_url: https://api.openai.com/v1
    api_key: openai-secret
    thinking: false
    max_tokens: 8192
`);

    const loaded = await loadConfig({ configPath: path, profileName: 'responses' });

    expect(loaded.selected).toMatchObject({
      name: 'responses',
      protocol: 'openai-responses',
      maxTokens: 8192,
    });
  });

  it('resolves a complete environment variable reference', async () => {
    const path = await writeConfig(validConfig().replace('plain-secret-value', '${TEST_LLM_KEY}'));

    const loaded = await loadConfig({
      configPath: path,
      environment: { TEST_LLM_KEY: 'resolved-secret' },
    });

    expect(loaded.selected.apiKey).toBe('resolved-secret');
  });

  it.each([
    ['duplicate name', `${validConfig()}\n  - name: claude\n    protocol: openai-responses\n    model: gpt\n    base_url: https://api.openai.com/v1\n    api_key: secret\n    thinking: false\n`, 'profiles[1].name'],
    ['unknown default', validConfig().replace('default_profile: claude', 'default_profile: missing'), 'default_profile'],
    ['unknown protocol', validConfig().replace('anthropic-messages', 'custom-protocol'), 'profiles[0].protocol'],
    ['full endpoint URL', validConfig().replace('https://api.anthropic.com', 'https://api.anthropic.com/v1/messages'), 'profiles[0].base_url'],
  ])('rejects %s with a field-level diagnostic', async (_name, content, field) => {
    const path = await writeConfig(content);
    await expect(loadConfig({ configPath: path })).rejects.toMatchObject({ field });
  });

  it('rejects an unknown selected profile', async () => {
    const path = await writeConfig(validConfig());
    await expect(loadConfig({ configPath: path, profileName: 'missing' })).rejects.toMatchObject({
      field: 'profile',
    });
  });

  it('requires thinking=false until thinking is implemented', async () => {
    const path = await writeConfig(validConfig().replace('thinking: false', 'thinking: true'));
    await expect(loadConfig({ configPath: path })).rejects.toMatchObject({
      field: 'profiles[0].thinking',
      message: expect.stringContaining('暂未实现'),
    });
  });

  it.each(['0', '-1', '1.5', 'text'])('rejects invalid max_tokens %s', async (value) => {
    const path = await writeConfig(`${validConfig()}    max_tokens: ${value}\n`);
    await expect(loadConfig({ configPath: path })).rejects.toMatchObject({
      field: 'profiles[0].max_tokens',
    });
  });

  it('does not leak plaintext keys in diagnostics', async () => {
    const secret = 'never-print-this-secret';
    const path = await writeConfig(
      validConfig().replace('plain-secret-value', secret).replace('thinking: false', 'thinking: true'),
    );

    let thrown: unknown;
    try {
      await loadConfig({ configPath: path });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigError);
    expect(String(thrown)).not.toContain(secret);
  });
});
