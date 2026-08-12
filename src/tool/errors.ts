import type { ToolErrorContent } from '../shared/types.js';

export class ToolDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolDefinitionError';
  }
}

export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

export function safeToolError(error: unknown): ToolErrorContent {
  if (error instanceof ToolError) {
    return {
      code: error.code,
      message: truncate(error.message, 2 * 1024),
      retryable: error.retryable,
      ...(error.details === undefined ? {} : { details: truncateDetails(error.details) }),
    };
  }
  return { code: 'INTERNAL_TOOL_ERROR', message: '工具执行发生内部错误。', retryable: false };
}

export function truncate(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.length <= maxBytes) return value;
  const suffix = '...[已截断]';
  const allowed = Math.max(0, maxBytes - Buffer.byteLength(suffix, 'utf8'));
  return `${encoded.subarray(0, allowed).toString('utf8').replace(/\uFFFD$/, '')}${suffix}`;
}

function truncateDetails(details: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const serialized = safeStringify(details);
  if (Buffer.byteLength(serialized, 'utf8') <= 8 * 1024) return details;
  return { truncated: true, preview: truncate(serialized, 8 * 1024) };
}

function safeStringify(value: unknown): string {
  try { return JSON.stringify(value); } catch { return '{}'; }
}
