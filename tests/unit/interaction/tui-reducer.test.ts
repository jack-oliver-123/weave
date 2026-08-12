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

  it('生成期间连续入队并以空行合并消费', () => {
    let state = reduceTuiState(initialTuiState(), { type: 'turn_event', event: start });
    state = reduceTuiState(state, { type: 'queue_message', value: '第一条' });
    state = reduceTuiState(state, { type: 'queue_message', value: '第二条' });
    expect(state.queuedMessages).toEqual(['第一条', '第二条']);
    expect(state.composer).toBe('');
    state = reduceTuiState(state, { type: 'consume_queue' });
    expect(state.pendingSubmission).toBe('第一条\n\n第二条');
    expect(state.queuedMessages).toEqual([]);
  });

  it.each(['truncated', 'refused'] as const)('%s 终态暂停队列', (status) => {
    let state = reduceTuiState(initialTuiState(), { type: 'turn_event', event: start });
    state = reduceTuiState(state, { type: 'queue_message', value: '补充' });
    state = reduceTuiState(state, { type: 'turn_event', event: {
      type: 'turn_complete', turnId: 't1', status,
      finishReason: status === 'truncated' ? 'max_tokens' : 'refusal', durationMs: 10,
    } });
    expect(state.queueStatus).toBe('paused');
  });

  it('取消和错误暂停队列且错误恢复不覆盖草稿', () => {
    let cancelled = reduceTuiState(initialTuiState(), { type: 'turn_event', event: start });
    cancelled = reduceTuiState(cancelled, { type: 'queue_message', value: '补充' });
    cancelled = reduceTuiState(cancelled, { type: 'turn_event', event: { type: 'turn_cancelled', turnId: 't1', durationMs: 10 } });
    expect(cancelled.queueStatus).toBe('paused');

    let failed = reduceTuiState(initialTuiState(), { type: 'turn_event', event: start });
    failed = reduceTuiState(failed, { type: 'set_composer', value: '新草稿' });
    failed = reduceTuiState(failed, { type: 'queue_message', value: '补充' });
    failed = reduceTuiState(failed, { type: 'set_composer', value: '新草稿' });
    failed = reduceTuiState(failed, { type: 'turn_event', event: {
      type: 'turn_error', turnId: 't1', error: { code: 'X', message: '失败', retryable: true }, restoreInput: '原问题', durationMs: 10,
    } });
    expect(failed).toMatchObject({ queueStatus: 'paused', composer: '原问题\n\n新草稿' });
  });

  it('Ctrl+Z 只撤回队尾且保留当前草稿', () => {
    let state = reduceTuiState(initialTuiState(), { type: 'queue_message', value: '第一条' });
    state = reduceTuiState(state, { type: 'queue_message', value: '第二条' });
    state = reduceTuiState(state, { type: 'set_composer', value: '当前草稿' });
    state = reduceTuiState(state, { type: 'undo_queue' });
    expect(state).toMatchObject({ queuedMessages: ['第一条'], composer: '第二条\n\n当前草稿' });
  });
});
