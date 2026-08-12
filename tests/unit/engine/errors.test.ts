import { describe, expect, it } from 'vitest';
import { mapClientError } from '../../../src/engine/llm/errors.js';

describe('安全错误映射', () => {
  it.each([
    [401, 'AUTH_FAILED', false],
    [403, 'AUTH_FAILED', false],
    [429, 'RATE_LIMITED', true],
    [408, 'PROVIDER_UNAVAILABLE', true],
    [500, 'PROVIDER_UNAVAILABLE', true],
    [400, 'PROVIDER_ERROR', false],
    [undefined, 'NETWORK_ERROR', true],
  ])('映射状态 %s 且不泄露原始消息', (status, code, retryable) => {
    const secret = 'sk-private-secret';
    const error = Object.assign(new Error(`provider body ${secret}`), status === undefined ? {} : { status });
    const safe = mapClientError(error);
    expect(safe).toMatchObject({ code, retryable });
    expect(JSON.stringify(safe)).not.toContain(secret);
  });

  it('单独映射上下文窗口超限且不暴露 Provider 文本', () => {
    expect(mapClientError({ status: 400, error: { code: 'context_length_exceeded', message: 'secret' } })).toEqual({
      code: 'CONTEXT_LIMIT_EXCEEDED', message: '完整对话历史超过了模型上下文上限。', retryable: false,
    });
  });
});
