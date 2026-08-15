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
    credential: provider:claude-test
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
    expect(loaded.permissionMode).toBe('supervised');
    expect(loaded.auditRetention).toEqual({ days: 30, maxBytes: 100 * 1024 * 1024 });
  });

  it('loads an explicit permission mode and rejects unsafe unknown values', async () => {
    const path = await writeConfig(validConfig(`security:
  permission_mode: autonomous
`));
    await expect(loadConfig({ configPath: path })).resolves.toMatchObject({ permissionMode: 'autonomous' });

    const invalid = await writeConfig(validConfig(`security:
  permission_mode: full_access
`));
    await expect(loadConfig({ configPath: invalid })).rejects.toMatchObject({ field: 'security.permission_mode' });
  });

  it('loads bounded security audit retention settings', async () => {
    const path = await writeConfig(validConfig(`security:
  audit:
    retention_days: 365
    max_mib: 1024
`));
    await expect(loadConfig({ configPath: path })).resolves.toMatchObject({
      auditRetention: { days: 365, maxBytes: 1024 ** 3 },
    });
  });

  it('loads an explicit Windows Sandbox backend without permitting fallback', async () => {
    const path = await writeConfig(validConfig(`security:
  sandbox:
    backend: windows-sandbox
`));
    await expect(loadConfig({ configPath: path })).resolves.toMatchObject({ sandboxBackend: 'windows-sandbox' });
  });

  it('rejects an unknown sandbox backend', async () => {
    const path = await writeConfig(validConfig(`security:
  sandbox:
    backend: host-process
`));
    await expect(loadConfig({ configPath: path })).rejects.toMatchObject({ field: 'security.sandbox.backend' });
  });

  it.each([
    ['retention_days', 0, 'security.audit.retention_days'],
    ['retention_days', 366, 'security.audit.retention_days'],
    ['max_mib', 1025, 'security.audit.max_mib'],
  ])('rejects out-of-range audit %s=%s', async (name, value, field) => {
    const path = await writeConfig(validConfig(`security:
  audit:
    ${name}: ${value}
`));
    await expect(loadConfig({ configPath: path })).rejects.toMatchObject({ field });
  });

  it('lets the command line select another unique profile', async () => {
    const path = await writeConfig(`${validConfig()}
  - name: responses
    protocol: openai-responses
    model: gpt-test
    base_url: https://api.openai.com/v1
    credential: provider:openai-test
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

  it('preserves a complete environment variable reference for use-time migration', async () => {
    const path = await writeConfig(
      validConfig().replace('credential: provider:claude-test', 'api_key: ${TEST_LLM_KEY}'),
    );

    const loaded = await loadConfig({
      configPath: path,
      environment: { TEST_LLM_KEY: 'resolved-secret' },
    });

    expect(loaded.selected.apiKey).toBeUndefined();
    expect(loaded.selected.credentialRef).toBe('env:TEST_LLM_KEY');
    expect(loaded.warnings).toHaveLength(1);
    expect(JSON.stringify(loaded.warnings)).not.toContain('resolved-secret');
  });

  it.each([
    ['duplicate name', `${validConfig()}\n  - name: claude\n    protocol: openai-responses\n    model: gpt\n    base_url: https://api.openai.com/v1\n    credential: provider:gpt\n    thinking: false\n`, 'profiles[1].name'],
    ['unknown default', validConfig().replace('default_profile: claude', 'default_profile: missing'), 'default_profile'],
    ['unknown protocol', validConfig().replace('anthropic-messages', 'custom-protocol'), 'profiles[0].protocol'],
    ['plaintext provider URL', validConfig().replace('https://api.anthropic.com', 'http://api.anthropic.com'), 'profiles[0].base_url'],
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
      validConfig().replace('credential: provider:claude-test', `api_key: ${secret}`),
    );

    let thrown: unknown;
    try {
      await loadConfig({ configPath: path });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigError);
    expect(thrown).toMatchObject({ field: 'profiles[0].api_key' });
    expect(String(thrown)).not.toContain(secret);
  });

  it('resolves tools.enabled using profile, root, CLI and default precedence', async () => {
    const defaults = await loadConfig({ configPath: await writeConfig(validConfig()) });
    expect(defaults.toolsEnabled).toBe(true);

    const root = await loadConfig({ configPath: await writeConfig(`tools:\n  enabled: false\n${validConfig()}`) });
    expect(root.toolsEnabled).toBe(false);

    const profilePath = await writeConfig(`tools:\n  enabled: false\n${validConfig('    tools:\n      enabled: true\n')}`);
    expect((await loadConfig({ configPath: profilePath })).toolsEnabled).toBe(true);
    expect((await loadConfig({ configPath: profilePath, toolsEnabled: false })).toolsEnabled).toBe(false);
  });

  it('accepts explicit Chat system-message compatibility mode', async () => {
    const path = await writeConfig(validConfig()
      .replace('anthropic-messages', 'openai-chat-completions')
      .replace('thinking: false', 'thinking: false\n    chat_system_mode: single'));
    expect((await loadConfig({ configPath: path })).selected.chatSystemMode).toBe('single');
  });

  it.each([
    ['invalid value', validConfig().replace('thinking: false', 'thinking: false\n    chat_system_mode: auto')],
    ['non-chat protocol', validConfig().replace('thinking: false', 'thinking: false\n    chat_system_mode: single')],
  ])('rejects invalid Chat system-message mode: %s', async (_name, content) => {
    const source = _name === 'invalid value' ? content.replace('anthropic-messages', 'openai-chat-completions') : content;
    await expect(loadConfig({ configPath: await writeConfig(source) })).rejects.toMatchObject({ field: 'profiles[0].chat_system_mode' });
  });

  it.each([
    ['root unknown', `tools:\n  enabled: true\n  timeout: 1\n${validConfig()}`, 'tools.timeout'],
    ['profile non-boolean', validConfig('    tools:\n      enabled: yes\n'), 'profiles[0].tools.enabled'],
  ])('rejects invalid tools config: %s', async (_name, content, field) => {
    await expect(loadConfig({ configPath: await writeConfig(content) })).rejects.toMatchObject({ field });
  });
});
