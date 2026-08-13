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

  it('按 callId 保持工具顺序并原位更新等待、执行、成功、失败与跳过状态', () => {
    let state = reduceTuiState(initialTuiState(), { type: 'turn_event', event: start });
    state = reduceTuiState(state, { type: 'turn_event', event: {
      type: 'tool_call_queued', turnId: 't1', callId: 'c1', toolName: 'read_file', summary: '等待读取',
    } });
    state = reduceTuiState(state, { type: 'turn_event', event: {
      type: 'tool_call_queued', turnId: 't1', callId: 'c2', toolName: 'edit_file', summary: '等待编辑',
    } });
    state = reduceTuiState(state, { type: 'turn_event', event: {
      type: 'tool_call_start', turnId: 't1', callId: 'c1', toolName: 'read_file', summary: '正在读取',
    } });
    state = reduceTuiState(state, { type: 'turn_event', event: {
      type: 'tool_call_complete', turnId: 't1', callId: 'c1', toolName: 'read_file', summary: '读取完成', isError: false,
    } });
    state = reduceTuiState(state, { type: 'turn_event', event: {
      type: 'tool_call_skipped', turnId: 't1', callId: 'c2', toolName: 'edit_file', summary: '前序失败', isError: true,
      error: { code: 'PRIOR_WRITE_FAILED', message: '未执行', retryable: false },
    } });
    expect(state.transcript[0]?.activities).toEqual([
      { type: 'tool', callId: 'c1', toolName: 'read_file', status: 'success', summary: '读取完成' },
      { type: 'tool', callId: 'c2', toolName: 'edit_file', status: 'skipped', summary: '前序失败', errorCode: 'PRIOR_WRITE_FAILED', errorMessage: '未执行' },
    ]);
  });

  it('在工具活动前后保留模型文本的真实显示顺序并保存完成统计', () => {
    let state = reduceTuiState(initialTuiState(), { type: 'turn_event', event: start });
    state = reduceTuiState(state, { type: 'turn_event', event: { type: 'text_delta', turnId: 't1', delta: '先检查' } });
    state = reduceTuiState(state, { type: 'turn_event', event: {
      type: 'tool_call_queued', turnId: 't1', callId: 'c1', toolName: 'grep', summary: '等待搜索',
    } });
    state = reduceTuiState(state, { type: 'turn_event', event: { type: 'text_delta', turnId: 't1', delta: '最终回答' } });
    state = reduceTuiState(state, { type: 'turn_event', event: {
      type: 'turn_complete', turnId: 't1', status: 'completed', finishReason: 'stop', durationMs: 10,
      modelTurnCount: 2, toolCallCount: 1, toolErrorCount: 0,
    } });
    expect(state.transcript[0]?.activities.map((activity) => activity.type === 'text' ? activity.text : activity.toolName))
      .toEqual(['先检查', 'grep', '最终回答']);
    expect(state.transcript[0]).toMatchObject({ modelTurnCount: 2, toolCallCount: 1, toolErrorCount: 0 });
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

  it('在同一 transcript 保存 Plan、步骤进度与审批决策', () => {
    const plan = { planId: 'p1', version: 1, goal: '交付', successCriteria: ['全量通过'], steps: [
      { id: 's1', description: '实现', dependencies: [], successCriteria: ['单测通过'], status: 'pending' as const, evidence: [] },
    ] };
    let state = reduceTuiState(initialTuiState(), { type: 'turn_event', event: start });
    state = reduceTuiState(state, { type: 'turn_event', event: { type: 'plan_ready', turnId: 't1', taskId: 'task-1', plan } });
    state = reduceTuiState(state, { type: 'turn_event', event: { type: 'task_state', turnId: 't1', taskId: 'task-1', state: 'awaiting_approval', summary: '等待审批' } });
    state = reduceTuiState(state, { type: 'turn_event', event: { type: 'turn_complete', turnId: 't1', status: 'completed', finishReason: 'stop', durationMs: 1 } });
    expect(state.taskDecision).toEqual({ kind: 'plan_approval', taskId: 'task-1', planId: 'p1', version: 1 });
    expect(state.transcript[0]?.activities).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'plan', plan })]));
  });

  it('从结构化 turn 事件投影 ReAct 与 Plan 模式阶段，不解析转录文本', () => {
    let state = initialTuiState();
    expect(state.taskDisplay).toEqual({ mode: 'react', phase: 'idle' });

    state = reduceTuiState(state, { type: 'turn_event', event: {
      type: 'turn_start', turnId: 'p1', userText: '这里没有命令前缀', startedAt: 0,
      taskMode: 'plan', taskPhase: 'plan_draft',
    } });
    expect(state.taskDisplay).toEqual({ mode: 'plan', phase: 'planning' });

    const plan = { planId: 'plan-1', version: 1, goal: '交付', successCriteria: ['通过'], steps: [
      { id: 's1', description: '第一步', dependencies: [], successCriteria: ['通过'], status: 'pending' as const, evidence: [] },
      { id: 's2', description: '第二步', dependencies: ['s1'], successCriteria: ['通过'], status: 'pending' as const, evidence: [] },
    ] };
    state = reduceTuiState(state, { type: 'turn_event', event: { type: 'plan_ready', turnId: 'p1', taskId: 'task-1', plan } });
    expect(state.taskDisplay).toMatchObject({ mode: 'plan', phase: 'awaiting_approval', totalSteps: 2 });
    state = reduceTuiState(state, { type: 'turn_event', event: { type: 'turn_complete', turnId: 'p1', status: 'completed', finishReason: 'stop', durationMs: 1 } });
    expect(state.taskDisplay).toMatchObject({ mode: 'plan', phase: 'awaiting_approval' });

    state = reduceTuiState(state, { type: 'turn_event', event: {
      type: 'turn_start', turnId: 'p2', userText: '交付', startedAt: 2, taskMode: 'plan', taskPhase: 'plan_execute',
    } });
    state = reduceTuiState(state, { type: 'turn_event', event: {
      type: 'plan_step', turnId: 'p2', taskId: 'task-1', planId: 'plan-1', version: 1, stepId: 's2', status: 'running',
    } });
    expect(state.taskDisplay).toMatchObject({ mode: 'plan', phase: 'executing', currentStep: 2, totalSteps: 2 });

    state = reduceTuiState(state, { type: 'turn_event', event: {
      type: 'task_state', turnId: 'p2', taskId: 'task-1', state: 'awaiting_input', summary: '等待输入',
    } });
    expect(state.taskDisplay).toMatchObject({ mode: 'plan', phase: 'awaiting_input', resumePhase: 'executing' });
    state = reduceTuiState(state, { type: 'turn_event', event: { type: 'turn_complete', turnId: 'p2', status: 'completed', finishReason: 'stop', durationMs: 1 } });
    expect(state.taskDisplay).toMatchObject({ mode: 'plan', phase: 'awaiting_input' });
  });

  it('Plan 完成或退出后回落到 ReAct 就绪，停止与取消则保留模式', () => {
    const planStart: TurnEvent = {
      type: 'turn_start', turnId: 'p', userText: '执行', startedAt: 0, taskMode: 'plan', taskPhase: 'plan_execute',
    };
    let completed = reduceTuiState(initialTuiState(), { type: 'turn_event', event: planStart });
    completed = reduceTuiState(completed, { type: 'turn_event', event: { type: 'turn_complete', turnId: 'p', status: 'completed', finishReason: 'stop', durationMs: 1 } });
    expect(completed.taskDisplay).toEqual({ mode: 'react', phase: 'idle' });

    let stopped = reduceTuiState(initialTuiState(), { type: 'turn_event', event: planStart });
    stopped = reduceTuiState(stopped, { type: 'turn_event', event: { type: 'task_state', turnId: 'p', taskId: 'task', state: 'stopped', summary: '已停止' } });
    expect(stopped.taskDisplay).toMatchObject({ mode: 'plan', phase: 'stopped' });

    let cancelled = reduceTuiState(initialTuiState(), { type: 'turn_event', event: planStart });
    cancelled = reduceTuiState(cancelled, { type: 'turn_event', event: { type: 'turn_cancelled', turnId: 'p', durationMs: 1 } });
    expect(cancelled.taskDisplay).toMatchObject({ mode: 'plan', phase: 'cancelled' });

    let exited = reduceTuiState(initialTuiState(), { type: 'turn_event', event: planStart });
    exited = reduceTuiState(exited, { type: 'turn_event', event: { type: 'task_state', turnId: 'p', taskId: 'task', state: 'exited', summary: '已退出' } });
    expect(exited.taskDisplay).toEqual({ mode: 'react', phase: 'idle' });
  });

  it('ReAct 等待用户输入时不被兼容 turn 终态覆盖', () => {
    let state = reduceTuiState(initialTuiState(), { type: 'turn_event', event: {
      type: 'turn_start', turnId: 'r', userText: '需要输入', startedAt: 0, taskMode: 'react', taskPhase: 'react',
    } });
    state = reduceTuiState(state, { type: 'turn_event', event: {
      type: 'task_state', turnId: 'r', taskId: 'task', state: 'awaiting_input', summary: '请补充',
    } });
    state = reduceTuiState(state, { type: 'turn_event', event: {
      type: 'turn_complete', turnId: 'r', status: 'completed', finishReason: 'stop', durationMs: 1,
    } });
    expect(state.taskDisplay).toEqual({ mode: 'react', phase: 'awaiting_input' });
  });
});
