import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { LlmProtocol, ProfileSummary } from '../shared/types.js';

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
  'api_key',
  'thinking',
  'max_tokens',
]);
const ROOT_KEYS = new Set(['default_profile', 'profiles']);
const ENV_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const FULL_ENDPOINT_PATH = /\/(?:v\d+\/)?(?:messages|chat\/completions|responses)\/?$/i;

export interface ResolvedProfile extends ProfileSummary {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly thinking: false;
  readonly maxTokens: number;
}

export interface LoadedConfig {
  readonly path: string;
  readonly defaultProfile: string;
  readonly profiles: readonly ResolvedProfile[];
  readonly selected: ResolvedProfile;
}

export interface LoadConfigOptions {
  readonly configPath?: string;
  readonly profileName?: string;
  readonly homeDirectory?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
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

  return { path, defaultProfile, profiles, selected };
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
  const apiKey = resolveApiKey(
    requireString(profile.api_key, `${prefix}.api_key`, path),
    environment,
    `${prefix}.api_key`,
    path,
  );
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

  return {
    name,
    protocol: protocolValue as LlmProtocol,
    model,
    baseUrl,
    apiKey,
    thinking: false,
    maxTokens: maxTokens as number,
  };
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

function resolveApiKey(
  value: string,
  environment: Readonly<Record<string, string | undefined>>,
  field: string,
  path: string,
): string {
  const match = ENV_REFERENCE.exec(value);
  if (match === null) {
    return value;
  }
  const environmentName = match[1];
  const resolved = environment[environmentName];
  if (resolved === undefined || resolved.length === 0) {
    throw new ConfigError(`环境变量 ${environmentName} 未设置`, field, path);
  }
  return resolved;
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
