import { describe, expect, it } from 'vitest';
import { initialTuiState, reduceTuiState, selectElapsedMs } from '../../../src/interaction/tui-state.js';
import type { TurnEvent } from '../../../src/shared/types.js';

const start: TurnEvent = { type: 'turn_start', turnId: 't1', userText: '问题', startedAt: 100 };

describe('TUI reducer', () => {
  it('按 turn 生命周期创建记录、追加增量并保留 usage 与耗时', () => {
    let state = reduceTuiState(initialTuiState(), { type: 'turn_event', event: start });
    expect(state).toMatchObject({ activeTurnId: 't1', streamStatus: 'waiting' });
    expect(state.transcript[0]).toMatchObject({ userText: '问题', assistantText: '', phase: 'generating' });

    state = reduceTuiState(state, { type: 'turn_event', event: { type: 'text_delta', turnId: 't1', delta: '答' } });
    state = reduceTuiState(state, { type: 'turn_event', event: { type: 'text_delta', turnId: 't1', delta: '案' } });
    expect(state.transcript[0]?.assistantText).toBe('答案');
    expect(state.streamStatus).toBe('streaming');

    state = reduceTuiState(state, { type: 'turn_event', event: {
      type: 'turn_complete', turnId: 't1', status: 'completed', finishReason: 'stop',
      usage: { inputTokens: 8, outputTokens: 2 }, durationMs: 350,
    } });
    expect(state).toMatchObject({ activeTurnId: undefined, streamStatus: 'idle' });
    expect(state.transcript[0]).toMatchObject({ phase: 'completed', durationMs: 350, usage: { inputTokens: 8, outputTokens: 2 } });
  });

  it.each([
    ['truncated', 'truncated'],
    ['refused', 'refused'],
  ] as const)('映射 %s 完成状态', (status, phase) => {
    let state = reduceTuiState(initialTuiState(), { type: 'turn_event', event: start });
    state = reduceTuiState(state, { type: 'turn_event', event: {
      type: 'turn_complete', turnId: 't1', status, finishReason: status === 'truncated' ? 'max_tokens' : 'refusal', durationMs: 10,
    } });
    expect(state.transcript[0]?.phase).toBe(phase);
  });

  it('取消保留半截文本但不恢复输入', () => {
    let state = reduceTuiState(initialTuiState(), { type: 'turn_event', event: start });
    state = reduceTuiState(state, { type: 'turn_event', event: { type: 'text_delta', turnId: 't1', delta: '半截' } });
    state = reduceTuiState(state, { type: 'turn_event', event: { type: 'turn_cancelled', turnId: 't1', durationMs: 50 } });
    expect(state.transcript[0]).toMatchObject({ phase: 'cancelled', assistantText: '半截' });
    expect(state.composer).toBe('');
  });

  it('错误冻结半截文本、展示安全错误并恢复原始输入', () => {
    let state = reduceTuiState(initialTuiState(), { type: 'turn_event', event: start });
    state = reduceTuiState(state, { type: 'turn_event', event: { type: 'text_delta', turnId: 't1', delta: '半截' } });
    state = reduceTuiState(state, { type: 'turn_event', event: {
      type: 'turn_error', turnId: 't1', error: { code: 'NETWORK_ERROR', message: '连接失败', retryable: true },
      restoreInput: '问题', durationMs: 60,
    } });
    expect(state.transcript[0]).toMatchObject({ phase: 'error', assistantText: '半截', error: { code: 'NETWORK_ERROR' } });
    expect(state.composer).toBe('问题');
  });

  it('丢弃不匹配的迟到 turn_id', () => {
    const state = reduceTuiState(
      reduceTuiState(initialTuiState(), { type: 'turn_event', event: start }),
      { type: 'turn_event', event: { type: 'text_delta', turnId: 'old', delta: '污染' } },
    );
    expect(state.transcript[0]?.assistantText).toBe('');
  });

  it('单调计算生成耗时且不估算费用或上下文比例', () => {
    const state = reduceTuiState(initialTuiState(), { type: 'turn_event', event: start });
    expect(selectElapsedMs(state, 80)).toBe(0);
    expect(selectElapsedMs(state, 250)).toBe(150);
    expect(state).not.toHaveProperty('cost');
    expect(state).not.toHaveProperty('contextPercentage');
  });
});
