import { createHash } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { spawn } from 'node:child_process';
import { minimatch } from 'minimatch';
import type { JsonSchema, ToolDefinition } from '../shared/types.js';
import { sanitizeTerminalText } from '../shared/sanitize-terminal-text.js';
import { atomicCreate, atomicReplace } from './atomic-write.js';
import { BaseTool, type ToolExecutionContext } from './base-tool.js';
import { ToolError } from './errors.js';
import { ToolRegistry } from './registry.js';
import { decodeUtf8, encodeUtf8, sliceLines } from './text-file.js';
import { walkFiles } from './walker.js';
import type { Workspace } from './workspace.js';
import { createToolGuidance, editToolGuidance } from '../engine/prompt-rules.js';

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_RESULTS = 1_000;

export interface CoreToolHooks {
  readonly beforeEditCommit?: (path: string) => void | Promise<void>;
}

export function createCoreToolRegistry(workspace: Workspace, hooks: CoreToolHooks = {}): ToolRegistry {
  return new ToolRegistry([
    new ReadFileTool(workspace),
    new CreateFileTool(workspace),
    new EditFileTool(workspace, hooks),
    new BashTool(workspace),
    new GlobTool(workspace),
    new GrepTool(workspace),
  ]);
}

class ReadFileTool extends BaseTool<
  { path: string; startLine?: number; lineCount?: number },
  { path: string; content: string; startLine: number; endLine: number; totalLines: number; truncated: boolean; nextStartLine?: number }
> {
  constructor(private readonly workspace: Workspace) { super(readFileDefinition()); }
  protected async run(input: { path: string; startLine?: number; lineCount?: number }, context: ToolExecutionContext) {
    return withTimeout(context.signal, 10_000, async (signal) => {
      checkCancelled(signal);
      const target = await this.workspace.existingFile(input.path);
      const raw = await readFile(target.absolutePath);
      const { text } = decodeUtf8(raw);
      const range = sliceLines(text, input.startLine, input.lineCount);
      const bounded = truncateUtf8Lines(range.content, MAX_OUTPUT_BYTES);
      const truncated = bounded.truncated;
      return {
        ...range, path: target.relativePath, content: bounded.value, truncated,
        ...(truncated && bounded.completeLines > 0 ? { nextStartLine: range.startLine + bounded.completeLines } : {}),
      };
    });
  }
  protected successSummary(data: { path: string }): string { return `已读取 ${data.path}`; }
}

class CreateFileTool extends BaseTool<
  { path: string; content: string },
  { path: string; bytesWritten: number; createdDirectories: string[] }
> {
  constructor(private readonly workspace: Workspace) { super(createFileDefinition()); }
  protected async run(input: { path: string; content: string }, context: ToolExecutionContext) {
    checkCancelled(context.signal);
    const content = encodeUtf8(input.content);
    if (content.length > MAX_FILE_BYTES) throw new ToolError('FILE_TOO_LARGE', '文件内容超过 1 MiB。', false);
    const target = await this.workspace.newFile(input.path);
    const parent = dirname(target.absolutePath);
    const existing = await nearestExisting(parent);
    const missing = relative(existing, parent).split(/[\\/]/).filter(Boolean);
    const createdDirectories: string[] = [];
    let current = existing;
    for (const part of missing) {
      checkCancelled(context.signal);
      current = `${current}${current.endsWith('/') || current.endsWith('\\') ? '' : process.platform === 'win32' ? '\\' : '/'}${part}`;
      await mkdir(current);
      createdDirectories.push(this.workspace.toRelative(current));
    }
    try {
      await atomicCreate(target.absolutePath, content);
    } catch (error) {
      for (const directory of [...createdDirectories].reverse()) {
        const { rmdir } = await import('node:fs/promises');
        await rmdir(`${this.workspace.root}/${directory}`).catch(() => undefined);
      }
      throw error;
    }
    return { path: target.relativePath, bytesWritten: content.length, createdDirectories };
  }
  protected successSummary(data: { path: string }): string { return `已创建 ${data.path}`; }
}

interface EditInput { path: string; edits: { oldText: string; newText: string }[] }
class EditFileTool extends BaseTool<EditInput, { path: string; replacements: number; beforeBytes: number; afterBytes: number }> {
  constructor(private readonly workspace: Workspace, private readonly hooks: CoreToolHooks) { super(editFileDefinition()); }
  protected async run(input: EditInput, context: ToolExecutionContext) {
    checkCancelled(context.signal);
    const target = await this.workspace.existingFile(input.path);
    const beforeStat = await stat(target.absolutePath);
    if (beforeStat.size > MAX_FILE_BYTES) throw new ToolError('FILE_TOO_LARGE', '文件超过 1 MiB。', false);
    const beforeBuffer = await readFile(target.absolutePath);
    const decoded = decodeUtf8(beforeBuffer);
    let edited = decoded.text;
    for (const edit of input.edits) {
      checkCancelled(context.signal);
      if (edit.oldText.length === 0 || edit.oldText === edit.newText) {
        throw new ToolError('INVALID_ARGUMENT', 'oldText 必须非空且不能与 newText 相同。', false);
      }
      const first = edited.indexOf(edit.oldText);
      if (first < 0) throw new ToolError('TEXT_NOT_FOUND', '未找到要替换的精确文本。', false);
      if (edited.indexOf(edit.oldText, first + edit.oldText.length) >= 0) {
        throw new ToolError('AMBIGUOUS_MATCH', '要替换的文本出现多次。', false);
      }
      edited = `${edited.slice(0, first)}${edit.newText}${edited.slice(first + edit.oldText.length)}`;
    }
    const afterBuffer = encodeUtf8(edited, decoded.bom);
    if (afterBuffer.length > MAX_FILE_BYTES) throw new ToolError('FILE_TOO_LARGE', '编辑后文件超过 1 MiB。', false);
    await this.hooks.beforeEditCommit?.(target.absolutePath);
    const currentBuffer = await readFile(target.absolutePath).catch(() => undefined);
    const currentStat = await stat(target.absolutePath).catch(() => undefined);
    if (
      currentBuffer === undefined || currentStat === undefined
      || beforeStat.dev !== currentStat.dev || beforeStat.ino !== currentStat.ino
      || beforeStat.size !== currentStat.size || beforeStat.mtimeMs !== currentStat.mtimeMs
      || hash(beforeBuffer) !== hash(currentBuffer)
    ) throw new ToolError('FILE_CHANGED_DURING_EDIT', '文件在编辑期间已发生变化。', false, { path: target.relativePath });
    await atomicReplace(target.absolutePath, afterBuffer, beforeStat.mode);
    return { path: target.relativePath, replacements: input.edits.length, beforeBytes: beforeBuffer.length, afterBytes: afterBuffer.length };
  }
  protected successSummary(data: { path: string; replacements: number }): string { return `已编辑 ${data.path}（${data.replacements} 处）`; }
}

class GlobTool extends BaseTool<
  { pattern: string; path?: string },
  { files: string[]; truncated: boolean; reason?: string }
> {
  constructor(private readonly workspace: Workspace) { super(globDefinition()); }
  protected async run(input: { pattern: string; path?: string }, context: ToolExecutionContext) {
    validatePattern(input.pattern);
    return withTimeout(context.signal, 30_000, async (signal) => {
      const walked = await walkFiles(this.workspace, input.path ?? '.', signal);
      const base = input.path === undefined || input.path === '.' ? '' : input.path.replaceAll('\\', '/').replace(/\/$/, '');
      const matched = walked.files.filter((file) => {
        const candidate = base.length > 0 && file.startsWith(`${base}/`) ? file.slice(base.length + 1) : file;
        return minimatch(candidate, input.pattern, { dot: false, nocase: false });
      });
      const truncated = walked.truncated || matched.length > MAX_RESULTS;
      return {
        files: matched.slice(0, MAX_RESULTS), truncated,
        ...(truncated ? { reason: walked.truncated ? 'scan_limit' : 'result_limit' } : {}),
      };
    });
  }
  protected successSummary(data: { files: string[]; truncated: boolean }): string { return `匹配 ${data.files.length} 个文件${data.truncated ? '（已截断）' : ''}`; }
}

class GrepTool extends BaseTool<
  { pattern: string; path?: string; glob?: string; caseSensitive?: boolean },
  { matches: { path: string; line: number; text: string }[]; warnings: { path: string; code: string }[]; truncated: boolean; reason?: string }
> {
  constructor(private readonly workspace: Workspace) { super(grepDefinition()); }
  protected async run(input: { pattern: string; path?: string; glob?: string; caseSensitive?: boolean }, context: ToolExecutionContext) {
    if (input.pattern.length === 0 || input.pattern.length > 4096 || /[\r\n]/.test(input.pattern)) {
      throw new ToolError('INVALID_ARGUMENT', 'pattern 必须是 1 至 4096 字符的单行文本。', false);
    }
    return withTimeout(context.signal, 30_000, async (signal) => {
      const walked = await walkFiles(this.workspace, input.path ?? '.', signal);
      const matches: { path: string; line: number; text: string }[] = [];
      const warnings: { path: string; code: string }[] = [];
      const needle = input.caseSensitive === false ? fold(input.pattern) : input.pattern;
      for (const path of walked.files) {
        checkCancelled(signal);
        if (input.glob !== undefined && !minimatch(path, input.glob, { dot: false })) continue;
        try {
          const target = await this.workspace.existingFile(path);
          const { text } = decodeUtf8(await readFile(target.absolutePath));
          const lines = text.split(/\r\n|\n|\r/);
          for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index]!;
            const haystack = input.caseSensitive === false ? fold(line) : line;
            if (haystack.includes(needle)) {
              matches.push({ path, line: index + 1, text: truncateChars(line, 500) });
              if (matches.length >= MAX_RESULTS) break;
            }
          }
        } catch (error) {
          const code = error instanceof ToolError ? error.code : 'FILE_UNREADABLE';
          warnings.push({ path, code });
        }
        if (matches.length >= MAX_RESULTS) break;
      }
      matches.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
      const truncated = walked.truncated || matches.length >= MAX_RESULTS;
      return { matches, warnings, truncated, ...(truncated ? { reason: walked.truncated ? 'scan_limit' : 'result_limit' } : {}) };
    });
  }
  protected successSummary(data: { matches: unknown[]; truncated: boolean }): string { return `找到 ${data.matches.length} 条匹配${data.truncated ? '（已截断）' : ''}`; }
}

class BashTool extends BaseTool<
  { command: string; cwd?: string; timeoutMs?: number },
  { stdout: string; stderr: string; exitCode: number; durationMs: number; timedOut: boolean; truncated: boolean }
> {
  constructor(private readonly workspace: Workspace) { super(bashDefinition()); }
  protected async run(input: { command: string; cwd?: string; timeoutMs?: number }, context: ToolExecutionContext) {
    const timeoutMs = input.timeoutMs ?? 120_000;
    if (timeoutMs > 600_000) throw new ToolError('INVALID_ARGUMENT', 'timeoutMs 不能超过 600000。', false);
    const cwd = await this.workspace.existingDirectory(input.cwd ?? '.');
    const started = performance.now();
    const result = await runBash(input.command, cwd.absolutePath, timeoutMs, context.signal);
    const durationMs = Math.max(0, performance.now() - started);
    const { cancelled, ...publicResult } = result;
    const data = { ...publicResult, durationMs };
    if (result.timedOut) throw new ToolError('TOOL_TIMEOUT', 'Bash 执行超时。', true, data);
    if (cancelled) throw new ToolError('TOOL_CANCELLED', 'Bash 执行已取消。', false, data);
    if (result.exitCode !== 0) throw new ToolError('COMMAND_FAILED', `Bash 以状态 ${result.exitCode} 退出。`, false, data);
    return data;
  }
  protected successSummary(data: { exitCode: number }): string { return `Bash 执行完成（exit ${data.exitCode}）`; }
}

async function runBash(command: string, cwd: string, timeoutMs: number, signal: AbortSignal): Promise<{
  stdout: string; stderr: string; exitCode: number; timedOut: boolean; cancelled: boolean; truncated: boolean;
}> {
  return new Promise((resolve, reject) => {
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let truncated = false; let timedOut = false; let cancelled = false;
    const child = spawn(process.platform === 'win32' ? 'bash.exe' : 'bash', ['--noprofile', '--norc', '-c', command], {
      cwd, env: { ...process.env, PWD: cwd, CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
      if (current.length >= MAX_OUTPUT_BYTES) { truncated = true; return current; }
      const combined = Buffer.concat([current, chunk]);
      if (combined.length > MAX_OUTPUT_BYTES) { truncated = true; return combined.subarray(0, MAX_OUTPUT_BYTES); }
      return combined;
    };
    child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const kill = () => {
      if (child.pid === undefined) return;
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const abort = () => { cancelled = true; kill(); };
    signal.addEventListener('abort', abort, { once: true });
    child.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (error.code === 'ENOENT') reject(new ToolError('SHELL_NOT_FOUND', '找不到 Bash 可执行文件。', false)); else reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      resolve({
        stdout: sanitizeTerminalText(stdout.toString('utf8')), stderr: sanitizeTerminalText(stderr.toString('utf8')),
        exitCode: code ?? (timedOut || cancelled ? -1 : 1), timedOut, cancelled, truncated,
      });
    });
  });
}

function definition(
  name: string, purpose: string, executionMode: 'read_shared' | 'write_exclusive',
  inputSchema: JsonSchema, resultSchema: JsonSchema, worksWith: ToolDefinition['worksWith'], guidance?: string,
): ToolDefinition {
  return { name, purpose, executionMode, inputSchema, resultSchema, worksWith,
    useWhen: [`需要使用 ${name} 完成其专用操作时`, ...(guidance === undefined ? [] : [guidance])],
    avoidWhen: ['存在更精确的专用工具或无需访问工作区时'] };
}
const string = (maxLength?: number) => ({ type: 'string', ...(maxLength === undefined ? {} : { maxLength }) });
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const resultBase = (properties: Record<string, unknown>, required: string[]) => object(properties, required);
function readFileDefinition() { return definition('read_file', '读取工作区内 UTF-8 文本文件或指定行范围', 'read_shared', object({ path: string(), startLine: { type: 'integer', minimum: 1 }, lineCount: { type: 'integer', minimum: 1 } }, ['path']), resultBase({ path: string(), content: string(), startLine: { type: 'integer' }, endLine: { type: 'integer' }, totalLines: { type: 'integer' }, truncated: { type: 'boolean' }, nextStartLine: { type: 'integer' } }, ['path', 'content', 'startLine', 'endLine', 'totalLines', 'truncated']), [{ toolName: 'grep', usage: '先定位匹配再读取上下文' }, { toolName: 'edit_file', usage: '编辑前读取精确原文' }]); }
function createFileDefinition() { return definition('create_file', '创建新的 UTF-8 文本文件且绝不覆盖已有文件', 'write_exclusive', object({ path: string(), content: string(1024 * 1024) }, ['path', 'content']), resultBase({ path: string(), bytesWritten: { type: 'integer' }, createdDirectories: { type: 'array', items: string() } }, ['path', 'bytesWritten', 'createdDirectories']), [{ toolName: 'glob', usage: '创建前确认目标路径' }], createToolGuidance()); }
function editFileDefinition() { return definition('edit_file', '通过唯一精确匹配原子编辑 UTF-8 文本文件', 'write_exclusive', object({ path: string(), edits: { type: 'array', minItems: 1, maxItems: 100, items: object({ oldText: string(), newText: string() }, ['oldText', 'newText']) } }, ['path', 'edits']), resultBase({ path: string(), replacements: { type: 'integer' }, beforeBytes: { type: 'integer' }, afterBytes: { type: 'integer' } }, ['path', 'replacements', 'beforeBytes', 'afterBytes']), [{ toolName: 'read_file', usage: '获取唯一精确匹配文本' }], editToolGuidance()); }
function globDefinition() { return definition('glob', '按 glob 模式查找工作区普通文件', 'read_shared', object({ pattern: string(4096), path: string() }, ['pattern']), resultBase({ files: { type: 'array', items: string() }, truncated: { type: 'boolean' }, reason: string() }, ['files', 'truncated']), [{ toolName: 'read_file', usage: '读取匹配文件' }]); }
function grepDefinition() { return definition('grep', '逐行执行字面量文本搜索', 'read_shared', object({ pattern: string(4096), path: string(), glob: string(), caseSensitive: { type: 'boolean' } }, ['pattern']), resultBase({ matches: { type: 'array', items: object({ path: string(), line: { type: 'integer' }, text: string() }, ['path', 'line', 'text']) }, warnings: { type: 'array', items: object({ path: string(), code: string() }, ['path', 'code']) }, truncated: { type: 'boolean' }, reason: string() }, ['matches', 'warnings', 'truncated']), [{ toolName: 'read_file', usage: '读取匹配位置上下文' }]); }
function bashDefinition() { return definition('bash', '在工作区 cwd 中运行独立非交互 Bash 命令', 'write_exclusive', object({ command: string(), cwd: string(), timeoutMs: { type: 'integer', minimum: 1, maximum: 600000 } }, ['command']), resultBase({ stdout: string(), stderr: string(), exitCode: { type: 'integer' }, durationMs: { type: 'number' }, timedOut: { type: 'boolean' }, truncated: { type: 'boolean' } }, ['stdout', 'stderr', 'exitCode', 'durationMs', 'timedOut', 'truncated']), [{ toolName: 'read_file', usage: '检查命令产生的文件' }]); }

async function nearestExisting(path: string): Promise<string> { try { await stat(path); return path; } catch { const parent = dirname(path); if (parent === path) throw new ToolError('PATH_OUTSIDE_WORKSPACE', '找不到有效父目录。', false); return nearestExisting(parent); } }
function hash(buffer: Buffer): string { return createHash('sha256').update(buffer).digest('hex'); }
function checkCancelled(signal: AbortSignal): void { if (signal.aborted) throw new ToolError('TOOL_CANCELLED', '工具调用已取消。', false); }
function validatePattern(pattern: string): void { if (pattern.length === 0 || pattern.length > 4096 || pattern.includes('\\') || pattern.startsWith('/') || pattern.split('/').includes('..')) throw new ToolError('INVALID_ARGUMENT', 'glob pattern 无效。', false); }
function fold(value: string): string { return value.toLocaleLowerCase('und'); }
function truncateChars(value: string, max: number): string { return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 8))}...[截断]`; }
function truncateUtf8Lines(value: string, maxBytes: number): { value: string; truncated: boolean; completeLines: number } {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.length <= maxBytes) return { value, truncated: false, completeLines: 0 };
  const lines = value.match(/.*?(?:\r\n|\n|\r|$)/g)?.filter((line, index, all) => line.length > 0 || index < all.length - 1) ?? [];
  let bytes = 0;
  let completeLines = 0;
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, 'utf8');
    if (bytes + lineBytes > maxBytes) break;
    bytes += lineBytes;
    completeLines += 1;
  }
  if (completeLines > 0) return { value: lines.slice(0, completeLines).join(''), truncated: true, completeLines };
  return {
    value: encoded.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD$/, ''),
    truncated: true,
    completeLines: 0,
  };
}
async function withTimeout<T>(parent: AbortSignal, timeoutMs: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> { const timeout = AbortSignal.timeout(timeoutMs); const signal = AbortSignal.any([parent, timeout]); try { return await operation(signal); } catch (error) { if (timeout.aborted && !parent.aborted) throw new ToolError('TOOL_TIMEOUT', '工具执行超时。', true); throw error; } }
