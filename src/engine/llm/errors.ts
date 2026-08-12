import type { SafeError } from '../../shared/types.js';
import { StreamTimeoutError } from './stream-guard.js';

export class ProtocolError extends Error {
  constructor() {
    super('invalid provider stream');
    this.name = 'ProtocolError';
  }
}

export class InternalLlmError extends Error {
  constructor() {
    super('internal LLM boundary error');
    this.name = 'InternalLlmError';
  }
}

export function protocolError(): SafeError {
  return {
    code: 'PROTOCOL_ERROR',
    message: '供应商返回了无法识别的流式响应。',
    retryable: false,
  };
}

export function providerEventError(code?: string): SafeError {
  return {
    code: code === 'rate_limit_exceeded' ? 'RATE_LIMITED' : 'PROVIDER_ERROR',
    message: code === 'rate_limit_exceeded' ? '请求过于频繁，请稍后重试。' : '模型服务返回了错误。',
    retryable: code === 'rate_limit_exceeded' || code === 'server_error',
  };
}

export function mapClientError(error: unknown): SafeError {
  if (error instanceof InternalLlmError) {
    return { code: 'INTERNAL_ERROR', message: '模型协议边界处理失败。', retryable: false };
  }
  if (error instanceof ProtocolError) {
    return protocolError();
  }
  if (error instanceof StreamTimeoutError) {
    return { code: 'LLM_TIMEOUT', message: '等待模型响应超时。', retryable: true };
  }

  const status = readNumber(error, 'status');
  const providerCode = readString(error, 'code') ?? readString(readRecord(error, 'error'), 'code');
  if (providerCode === 'context_length_exceeded' || providerCode === 'context_window_exceeded') {
    return { code: 'CONTEXT_LIMIT_EXCEEDED', message: '完整对话历史超过了模型上下文上限。', retryable: false };
  }
  if (status === 401 || status === 403) {
    return { code: 'AUTH_FAILED', message: '模型服务身份验证失败。', retryable: false };
  }
  if (status === 429) {
    return { code: 'RATE_LIMITED', message: '请求过于频繁，请稍后重试。', retryable: true };
  }
  if (status === 408 || status === 409 || (status !== undefined && status >= 500)) {
    return { code: 'PROVIDER_UNAVAILABLE', message: '模型服务暂时不可用。', retryable: true };
  }
  if (status !== undefined && status >= 400) {
    return { code: 'PROVIDER_ERROR', message: '模型服务拒绝了请求。', retryable: false };
  }
  return { code: 'NETWORK_ERROR', message: '无法连接模型服务。', retryable: true };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const child = value[key];
  return isRecord(child) ? child : undefined;
}

export function readString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const child = value[key];
  return typeof child === 'string' ? child : undefined;
}

export function readNumber(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const child = value[key];
  return typeof child === 'number' && Number.isFinite(child) ? child : undefined;
}
