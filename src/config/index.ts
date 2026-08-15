import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { LlmProtocol, ProfileSummary } from '../shared/types.js';
import type { AuditRetentionPolicy } from '../security/audit.js';

const PROTOCOLS = new Set<LlmProtocol>([
  'anthropic-messages',
  'openai-chat-completions',
  'openai-responses',
]);
const PROFILE_KEYS = new Set([
  'name',
  'protocol',
  'model',
  'base_url',
  'credential',
  'api_key',
  'thinking',
  'max_tokens',
  'tools',
  'chat_system_mode',
]);
const ROOT_KEYS = new Set(['default_profile', 'profiles', 'tools', 'security']);
const TOOL_KEYS = new Set(['enabled']);
const SECURITY_KEYS = new Set(['audit', 'sandbox']);
const AUDIT_KEYS = new Set(['retention_days', 'max_mib']);
const SANDBOX_KEYS = new Set(['backend']);
const ENV_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const FULL_ENDPOINT_PATH = /\/(?:v\d+\/)?(?:messages|chat\/completions|responses)\/?$/i;

export interface ResolvedProfile extends ProfileSummary {
  readonly baseUrl: string;
  readonly credentialRef?: string;
  readonly apiKey?: string;
  readonly thinking: false;
  readonly maxTokens: number;
  readonly toolsEnabled?: boolean;
  readonly chatSystemMode?: ChatSystemMode;
}

export type ChatSystemMode = 'multiple' | 'single';

export interface LoadedConfig {
  readonly path: string;
  readonly defaultProfile: string;
  readonly profiles: readonly ResolvedProfile[];
  readonly selected: ResolvedProfile;
  readonly toolsEnabled: boolean;
  readonly auditRetention: AuditRetentionPolicy;
  readonly sandboxBackend?: 'wsl2' | 'windows-sandbox';
  readonly warnings: readonly string[];
}

export interface LoadConfigOptions {
  readonly configPath?: string;
  readonly profileName?: string;
  readonly homeDirectory?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly toolsEnabled?: boolean;
}

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly field?: string,
    readonly path?: string,
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function defaultConfigPath(homeDirectory = homedir()): string {
  return join(homeDirectory, '.weave', 'config.yaml');
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const path = options.configPath ?? defaultConfigPath(options.homeDirectory);
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    const code = isRecord(error) ? error.code : undefined;
    if (code === 'ENOENT') {
      throw new ConfigError(`配置文件不存在：${path}`, undefined, path);
    }
    throw new ConfigError(`无法读取配置文件：${path}`, undefined, path);
  }

  let document: unknown;
  try {
    document = parse(source);
  } catch {
    throw new ConfigError(`YAML 配置无法解析：${path}`, undefined, path);
  }

  const root = requireRecord(document, '配置根节点', undefined, path);
  rejectUnknownKeys(root, ROOT_KEYS, '配置根节点', path);
  const rootToolsEnabled = parseTools(root.tools, 'tools', path);
  const auditRetention = parseAuditRetention(root.security, path);
  const sandboxBackend = parseSandboxBackend(root.security, path);
  const defaultProfile = requireString(root.default_profile, 'default_profile', path);
  if (!Array.isArray(root.profiles) || root.profiles.length === 0) {
    throw new ConfigError('profiles 必须是非空列表', 'profiles', path);
  }

  const environment = options.environment ?? process.env;
  const seenNames = new Set<string>();
  const profiles = root.profiles.map((value, index) =>
    parseProfile(value, index, path, environment, seenNames),
  );

  if (!seenNames.has(defaultProfile)) {
    throw new ConfigError(`default_profile 引用不存在的 profile：${defaultProfile}`, 'default_profile', path);
  }

  const selectedName = options.profileName ?? defaultProfile;
  const selected = profiles.find((profile) => profile.name === selectedName);
  if (selected === undefined) {
    throw new ConfigError(`未找到 profile：${selectedName}`, 'profile', path);
  }

  const toolsEnabled = options.toolsEnabled ?? selected.toolsEnabled ?? rootToolsEnabled ?? true;
  const warnings = profiles.some((profile) => profile.credentialRef?.startsWith('env:'))
    ? ['${ENV} credential migration is deprecated; use `weave credential set` and a profile credential reference.']
    : [];
  return {
    path, defaultProfile, profiles, selected, toolsEnabled, auditRetention,
    ...(sandboxBackend === undefined ? {} : { sandboxBackend }),
    warnings: Object.freeze(warnings),
  };
}

function parseSandboxBackend(value: unknown, path: string): LoadedConfig['sandboxBackend'] {
  if (value === undefined) return undefined;
  const security = requireRecord(value, 'security', 'security', path);
  if (security.sandbox === undefined) return undefined;
  const sandbox = requireRecord(security.sandbox, 'security.sandbox', 'security.sandbox', path);
  rejectUnknownKeys(sandbox, SANDBOX_KEYS, 'security.sandbox', path);
  if (sandbox.backend !== 'wsl2' && sandbox.backend !== 'windows-sandbox') {
    throw new ConfigError('security.sandbox.backend 必须是 wsl2 或 windows-sandbox', 'security.sandbox.backend', path);
  }
  return sandbox.backend;
}

function parseAuditRetention(value: unknown, path: string): AuditRetentionPolicy {
  if (value === undefined) return Object.freeze({ days: 30, maxBytes: 100 * 1024 * 1024 });
  const security = requireRecord(value, 'security', 'security', path);
  rejectUnknownKeys(security, SECURITY_KEYS, 'security', path);
  if (security.audit === undefined) return Object.freeze({ days: 30, maxBytes: 100 * 1024 * 1024 });
  const audit = requireRecord(security.audit, 'security.audit', 'security.audit', path);
  rejectUnknownKeys(audit, AUDIT_KEYS, 'security.audit', path);
  const days = audit.retention_days ?? 30;
  const maxMib = audit.max_mib ?? 100;
  if (!Number.isInteger(days) || (days as number) < 1 || (days as number) > 365) {
    throw new ConfigError('security.audit.retention_days 必须是 1 至 365 的整数', 'security.audit.retention_days', path);
  }
  if (!Number.isInteger(maxMib) || (maxMib as number) < 1 || (maxMib as number) > 1024) {
    throw new ConfigError('security.audit.max_mib 必须是 1 至 1024 的整数，最大 1 GiB', 'security.audit.max_mib', path);
  }
  return Object.freeze({ days: days as number, maxBytes: (maxMib as number) * 1024 * 1024 });
}

function parseProfile(
  value: unknown,
  index: number,
  path: string,
  environment: Readonly<Record<string, string | undefined>>,
  seenNames: Set<string>,
): ResolvedProfile {
  const prefix = `profiles[${index}]`;
  const profile = requireRecord(value, prefix, prefix, path);
  rejectUnknownKeys(profile, PROFILE_KEYS, prefix, path);
  const name = requireString(profile.name, `${prefix}.name`, path);
  if (seenNames.has(name)) {
    throw new ConfigError(`profile 名称重复：${name}`, `${prefix}.name`, path);
  }
  seenNames.add(name);

  const protocolValue = requireString(profile.protocol, `${prefix}.protocol`, path);
  if (!PROTOCOLS.has(protocolValue as LlmProtocol)) {
    throw new ConfigError(`不支持的 protocol：${protocolValue}`, `${prefix}.protocol`, path);
  }

  const model = requireString(profile.model, `${prefix}.model`, path);
  const baseUrl = validateBaseUrl(
    requireString(profile.base_url, `${prefix}.base_url`, path),
    `${prefix}.base_url`,
    path,
  );
  const credential = parseCredential(profile, environment, prefix, path);
  if (profile.thinking !== false) {
    if (profile.thinking === true) {
      throw new ConfigError('thinking 暂未实现，首版必须配置为 false', `${prefix}.thinking`, path);
    }
    throw new ConfigError('thinking 必须是布尔值 false', `${prefix}.thinking`, path);
  }

  const maxTokens = profile.max_tokens === undefined ? 4096 : profile.max_tokens;
  if (!Number.isInteger(maxTokens) || (maxTokens as number) <= 0) {
    throw new ConfigError('max_tokens 必须是正整数', `${prefix}.max_tokens`, path);
  }

  const chatSystemMode = parseChatSystemMode(profile.chat_system_mode, protocolValue as LlmProtocol, `${prefix}.chat_system_mode`, path);

  return {
    name,
    protocol: protocolValue as LlmProtocol,
    model,
    baseUrl,
    ...credential,
    thinking: false,
    maxTokens: maxTokens as number,
    ...(chatSystemMode === undefined ? {} : { chatSystemMode }),
    ...(parseTools(profile.tools, `${prefix}.tools`, path) === undefined
      ? {}
      : { toolsEnabled: parseTools(profile.tools, `${prefix}.tools`, path) }),
  };
}

function parseChatSystemMode(value: unknown, protocol: LlmProtocol, field: string, path: string): ChatSystemMode | undefined {
  if (value === undefined) return undefined;
  if (protocol !== 'openai-chat-completions') {
    throw new ConfigError('chat_system_mode 仅适用于 openai-chat-completions 协议', field, path);
  }
  if (value !== 'multiple' && value !== 'single') {
    throw new ConfigError('chat_system_mode 必须是 multiple 或 single', field, path);
  }
  return value;
}

function parseTools(value: unknown, field: string, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  const tools = requireRecord(value, field, field, path);
  rejectUnknownKeys(tools, TOOL_KEYS, field, path);
  if (typeof tools.enabled !== 'boolean') {
    throw new ConfigError(`${field}.enabled 必须是布尔值`, `${field}.enabled`, path);
  }
  return tools.enabled;
}

function validateBaseUrl(value: string, field: string, path: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError('base_url 必须是有效 URL', field, path);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new ConfigError('base_url 只支持 http 或 https', field, path);
  }
  if (FULL_ENDPOINT_PATH.test(parsed.pathname)) {
    throw new ConfigError('base_url 必须是 API 根地址，不能包含完整接口路径', field, path);
  }
  return value.replace(/\/$/, '');
}

function parseCredential(
  profile: Record<string, unknown>,
  environment: Readonly<Record<string, string | undefined>>,
  prefix: string,
  path: string,
): { readonly credentialRef: string } {
  if (profile.credential !== undefined && profile.api_key !== undefined) {
    throw new ConfigError('credential and api_key cannot be configured together', `${prefix}.credential`, path);
  }
  if (profile.credential !== undefined) {
    const reference = requireString(profile.credential, `${prefix}.credential`, path);
    if (!/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(reference)) {
      throw new ConfigError('credential reference is invalid', `${prefix}.credential`, path);
    }
    return { credentialRef: reference };
  }
  const field = `${prefix}.api_key`;
  const value = requireString(profile.api_key, field, path);
  const match = ENV_REFERENCE.exec(value);
  if (match === null) {
    throw new ConfigError('api_key plaintext is forbidden; use a credential reference', field, path);
  }
  const environmentName = match[1];
  const resolved = environment[environmentName];
  if (resolved === undefined || resolved.length === 0) {
    throw new ConfigError(`环境变量 ${environmentName} 未设置`, field, path);
  }
  return { credentialRef: `env:${environmentName}` };
}

function requireString(value: unknown, field: string, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ConfigError(`${field} 必须是非空字符串`, field, path);
  }
  return value.trim();
}

function requireRecord(
  value: unknown,
  label: string,
  field: string | undefined,
  path: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ConfigError(`${label} 必须是对象`, field, path);
  }
  return value;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
  path: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) {
    const field = label === '配置根节点' ? unknown : `${label}.${unknown}`;
    throw new ConfigError(`不支持的配置字段：${field}`, field, path);
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
