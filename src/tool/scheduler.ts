import type { ToolCallRequest, ToolCallResult, ToolDefinition } from '../shared/types.js';

const MAX_PER_RESPONSE = 32;
const MAX_PER_TURN = 100;
const RESULT_BUDGET = 512 * 1024;
const READ_CONCURRENCY = 8;

export class ToolCallLimitError extends Error {
  constructor(message: string) { super(message); this.name = 'ToolCallLimitError'; }
}

export interface ToolDispatcher {
  readonly definitions: readonly ToolDefinition[];
  dispatch(request: ToolCallRequest, signal: AbortSignal): Promise<ToolCallResult>;
}

export interface ToolScheduleResult {
  readonly results: readonly ToolCallResult[];
  readonly totalCalls: number;
  readonly finalTextOnly: boolean;
}

export interface ToolScheduleHooks {
  readonly onStart?: (call: ToolCallRequest) => void;
}

export class ToolCallScheduler {
  private readonly definitions: ReadonlyMap<string, ToolDefinition>;
  constructor(private readonly dispatcher: ToolDispatcher) {
    this.definitions = new Map(dispatcher.definitions.map((definition) => [definition.name, definition]));
  }

  async execute(
    calls: readonly ToolCallRequest[], signal: AbortSignal, previousCalls = 0, hooks: ToolScheduleHooks = {},
  ): Promise<ToolScheduleResult> {
    if (calls.length > MAX_PER_RESPONSE) throw new ToolCallLimitError('单个模型响应最多包含 32 个工具调用。');
    const totalCalls = previousCalls + calls.length;
    const accepted = Math.max(0, Math.min(calls.length, MAX_PER_TURN - previousCalls));
    const results: ToolCallResult[] = [];
    let index = 0;
    let writeFailed = false;
    while (index < accepted) {
      if (signal.aborted) {
        for (; index < accepted; index++) results.push(errorResult(calls[index]!, 'TURN_CANCELLED', '用户已取消当前 turn。'));
        break;
      }
      if (writeFailed) {
        results.push(errorResult(calls[index]!, 'PRIOR_WRITE_FAILED', '前序写入调用失败，本调用未执行。'));
        index += 1;
        continue;
      }
      const current = calls[index]!;
      const definition = this.definitions.get(current.name);
      if (definition === undefined) {
        results.push(errorResult(current, 'UNKNOWN_TOOL', '请求的工具不存在。'));
        writeFailed = true;
        index += 1;
        continue;
      }
      if (definition.executionMode === 'write_exclusive') {
        hooks.onStart?.(current);
        const result = await this.dispatcher.dispatch(current, signal);
        results.push(result);
        if (result.isError) writeFailed = true;
        index += 1;
        continue;
      }
      const start = index;
      while (index < accepted) {
        const next = this.definitions.get(calls[index]!.name);
        if (next?.executionMode !== 'read_shared') break;
        index += 1;
      }
      const batch = calls.slice(start, index);
      const batchResults = await runPool(batch, READ_CONCURRENCY, async (request) => {
        if (signal.aborted) return errorResult(request, 'TURN_CANCELLED', '用户已取消当前 turn，工具未开始执行。');
        hooks.onStart?.(request);
        return this.dispatcher.dispatch(request, signal);
      });
      results.push(...batchResults);
    }
    for (let over = accepted; over < calls.length; over++) {
      results.push(errorResult(calls[over]!, 'TOOL_CALL_LIMIT_REACHED', '本次用户请求已达到 100 个工具调用。'));
    }
    return {
      results: enforceBudget(results), totalCalls: Math.min(totalCalls, MAX_PER_TURN),
      finalTextOnly: totalCalls >= MAX_PER_TURN,
    };
  }
}

async function runPool<T, R>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!);
    }
  }));
  return results;
}

function errorResult(call: ToolCallRequest, code: string, message: string): ToolCallResult {
  return {
    callId: call.callId, providerCallId: call.providerCallId, toolName: call.name, isError: true,
    content: { summary: message, error: { code, message, retryable: false } },
  };
}

function enforceBudget(results: readonly ToolCallResult[]): readonly ToolCallResult[] {
  const minimum = results.map((result) => result.isError ? result : truncatedShell(result));
  let remaining = RESULT_BUDGET - serializedArrayBytes(minimum);
  if (remaining < 0) throw new ToolCallLimitError('工具结果的必要关联信息超过 512 KiB 回传预算。');
  return results.map((result, index) => {
    if (result.isError) return result;
    const shell = minimum[index]!;
    const shellBytes = byteLength(shell);
    const bytes = byteLength(result);
    const extraBytes = bytes - shellBytes;
    if (extraBytes <= remaining) {
      remaining -= extraBytes;
      return result;
    }
    const original = JSON.stringify(result.content.data);
    const fitted = fitPreview(shell, original, shellBytes + remaining);
    remaining -= byteLength(fitted) - shellBytes;
    return fitted;
  });
}

function byteLength(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }
function serializedArrayBytes(values: readonly ToolCallResult[]): number { return byteLength(values); }
function truncatedShell(result: ToolCallResult): ToolCallResult {
  return { ...result, content: { ...result.content, data: { truncated: true, preview: '' } } };
}
function fitPreview(shell: ToolCallResult, value: string, maxBytes: number): ToolCallResult {
  let low = 0;
  let high = value.length;
  let best = shell;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = {
      ...shell,
      content: { ...shell.content, data: { truncated: true, preview: value.slice(0, middle) } },
    } satisfies ToolCallResult;
    if (byteLength(candidate) <= maxBytes) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}
