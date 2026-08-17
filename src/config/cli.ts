export type CliOptions =
  | { readonly action: 'help' }
  | { readonly action: 'version' }
  | { readonly action: 'credential'; readonly operation: 'set' | 'delete'; readonly reference: string }
  | { readonly action: 'credential'; readonly operation: 'list' }
  | {
      readonly action: 'run';
      readonly configPath?: string;
      readonly profileName?: string;
      readonly workspacePath?: string;
      readonly toolsEnabled?: boolean;
    };

export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

export function parseCliArgs(args: readonly string[]): CliOptions {
  if (args[0] === 'credential') return parseCredentialArgs(args.slice(1));
  let configPath: string | undefined;
  let profileName: string | undefined;
  let workspacePath: string | undefined;
  let toolsEnabled: boolean | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') {
      if (args.length !== 1) throw new CliError('--help 不能与其他参数同时使用');
      return { action: 'help' };
    }
    if (argument === '--version' || argument === '-v') {
      if (args.length !== 1) throw new CliError('--version 不能与其他参数同时使用');
      return { action: 'version' };
    }
    if (argument === '--config') {
      configPath = requireValue(args, ++index, '--config');
      continue;
    }
    if (argument === '--profile') {
      profileName = requireValue(args, ++index, '--profile');
      continue;
    }
    if (argument === '--workspace') {
      workspacePath = requireValue(args, ++index, '--workspace');
      continue;
    }
    if (argument === '--tools' || argument === '--no-tools') {
      const requested = argument === '--tools';
      if (toolsEnabled !== undefined && toolsEnabled !== requested) {
        throw new CliError('--tools 与 --no-tools 互斥');
      }
      toolsEnabled = requested;
      continue;
    }
    throw new CliError(`未知参数：${argument}`);
  }

  return {
    action: 'run',
    ...(configPath === undefined ? {} : { configPath }),
    ...(profileName === undefined ? {} : { profileName }),
    ...(workspacePath === undefined ? {} : { workspacePath }),
    ...(toolsEnabled === undefined ? {} : { toolsEnabled }),
  };
}

export function assertSupportedNodeVersion(version = process.versions.node): void {
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  if (!Number.isInteger(major) || major < 22) {
    throw new CliError(`Weave 需要 Node.js 22 或更高版本，当前版本为 ${version}`);
  }
}

export function helpText(): string {
  return [
    'Weave - 多协议终端对话',
    '       weave credential set <reference>',
    '       weave credential delete <reference>',
    '       weave credential list',
    '',
    '用法: weave [--config <path>] [--profile <name>] [--workspace <path>] [--tools|--no-tools]',
    '',
    '选项:',
    '  --config <path>   指定 YAML 配置文件',
    '  --profile <name>  覆盖 default_profile',
    '  --workspace <path> 固定本次会话工作区',
    '  --tools            启用核心工具',
    '  --no-tools         禁用核心工具并使用纯文本模式',
    '  --help, -h        显示帮助',
    '  --version, -v     显示版本',
  ].join('\n');
}

function parseCredentialArgs(args: readonly string[]): CliOptions {
  const operation = args[0];
  if (operation === 'list' && args.length === 1) return { action: 'credential', operation };
  if ((operation === 'set' || operation === 'delete') && args.length === 2) {
    const reference = args[1]!;
    if (!/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(reference)) throw new CliError('credential reference is invalid');
    return { action: 'credential', operation, reference };
  }
  throw new CliError('Usage: weave credential set|delete|list');
}

function requireValue(args: readonly string[], index: number, option: string): string {
  const value = args[index];
  if (value === undefined || value.startsWith('--')) {
    throw new CliError(`${option} 缺少参数值`);
  }
  return value;
}
