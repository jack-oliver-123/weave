import { describe, expect, it } from 'vitest';
import { mapClientError } from '../../../src/engine/llm/errors.js';

describe('安全错误映射', () => {
  it.each([
    [401, 'AUTH_FAILED', false],
    [403, 'AUTH_FAILED', false],
    [429, 'RATE_LIMITED', true],
    [408, 'PROVIDER_UNAVAILABLE', true],
    [500, 'PROVIDER_UNAVAILABLE', true],
    [undefined, 'NETWORK_ERROR', true],
  ])('映射状态 %s 且不泄露原始消息', (status, code, retryable) => {
    const secret = 'sk-private-secret';
    const error = Object.assign(new Error(`provider body ${secret}`), status === undefined ? {} : { status });
    const safe = mapClientError(error);
    expect(safe).toMatchObject({ code, retryable });
    expect(JSON.stringify(safe)).not.toContain(secret);
  });
});
