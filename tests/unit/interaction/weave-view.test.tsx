import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { WeaveView } from '../../../src/interaction/weave-view.js';
import { initialTuiState, reduceTuiState } from '../../../src/interaction/tui-state.js';
import { initialViewportState } from '../../../src/interaction/viewport.js';

const baseProps = {
  version: '0.1.0',
  cwd: 'C:\\Code\\Weave',
  profile: { name: 'test', protocol: 'openai-responses' as const, model: 'gpt-test' },
  columns: 100,
  rows: 30,
  viewport: initialViewportState(),
  cursor: 0,
};

describe('WeaveView', () => {
  it('首屏只有一个头部、静态小狗、版本、目录、协议模型、composer 与状态栏', () => {
    const frame = render(<WeaveView {...baseProps} state={initialTuiState()} />).lastFrame() ?? '';
    expect(frame).toContain('/ \\__');
    expect(frame.match(/Weave v0\.1\.0/g)).toHaveLength(1);
    expect(frame).toContain('C:\\Code\\Weave');
    expect(frame).toContain('openai-responses / gpt-test');
    expect(frame).toContain('>');
    expect(frame).toContain('ReAct · 就绪');
    expect(frame).not.toMatch(/费用|上下文|权限|Agents|MCP|\/model|\/clear/);
  });

  it.each([
    ['waiting', '等待响应'],
    ['streaming', '生成中'],
    ['completed', '完成'],
    ['truncated', '已达到输出上限'],
    ['refused', '模型拒绝回答'],
    ['cancelled', '已中断'],
    ['error', '连接失败'],
  ])('显示 %s 终态或生成状态', (phase, label) => {
    let state = reduceTuiState(initialTuiState(), { type: 'turn_event', event: {
      type: 'turn_start', turnId: 't1', userText: '你好', startedAt: 0,
    } });
    if (phase === 'streaming') {
      state = reduceTuiState(state, { type: 'turn_event', event: { type: 'text_delta', turnId: 't1', delta: '回答' } });
    } else if (phase === 'completed' || phase === 'truncated' || phase === 'refused') {
      state = reduceTuiState(state, { type: 'turn_event', event: {
        type: 'turn_complete', turnId: 't1', status: phase,
        finishReason: phase === 'truncated' ? 'max_tokens' : phase === 'refused' ? 'refusal' : 'stop', durationMs: 1200,
      } });
    } else if (phase === 'cancelled') {
      state = reduceTuiState(state, { type: 'turn_event', event: { type: 'turn_cancelled', turnId: 't1', durationMs: 1200 } });
    } else if (phase === 'error') {
      state = reduceTuiState(state, { type: 'turn_event', event: {
        type: 'turn_error', turnId: 't1', error: { code: 'X', message: '连接失败', retryable: true }, restoreInput: '你好', durationMs: 1200,
      } });
    }
    const frame = render(<WeaveView {...baseProps} state={state} now={1500} />).lastFrame() ?? '';
    expect(frame).toContain(label);
  });

  it('明确显示结果审计失败后外部效果可能已发生且结果未释放', () => {
    let state = reduceTuiState(initialTuiState(), { type: 'turn_event', event: {
      type: 'turn_start', turnId: 'security-turn', userText: '执行动作', startedAt: 0, taskMode: 'react',
    } });
    state = reduceTuiState(state, { type: 'turn_event', event: {
      type: 'task_state', turnId: 'security-turn', taskId: 'task-1', state: 'security_integrity_failure',
      summary: '结果审计失败。', effectsMayHaveOccurred: true,
    } });
    const frame = render(<WeaveView {...baseProps} state={state} />).lastFrame() ?? '';
    expect(frame).toContain('外部效果可能已发生，结果未释放');
    expect(frame).toContain('安全完整性故障');
  });

  it('终端小于 80x24 时只显示单一尺寸提示，恢复尺寸后原状态仍可渲染', () => {
    const state = reduceTuiState(initialTuiState(), { type: 'set_composer', value: '保留草稿' });
    const small = render(<WeaveView {...baseProps} columns={79} rows={23} state={state} />).lastFrame() ?? '';
    expect(small.trim()).toBe('终端窗口过小，请调整到至少 80×24。');
    const restored = render(<WeaveView {...baseProps} state={state} />).lastFrame() ?? '';
    expect(restored).toContain('保留草稿');
  });

  it('等待首个文本片段时旋转等待符且小狗保持静态', () => {
    const state = reduceTuiState(initialTuiState(), { type: 'turn_event', event: {
      type: 'turn_start', turnId: 'waiting', userText: '你好', startedAt: 0,
    } });
    const first = render(<WeaveView {...baseProps} state={state} now={0} />).lastFrame() ?? '';
    const second = render(<WeaveView {...baseProps} state={state} now={100} />).lastFrame() ?? '';

    expect(first).toContain('⠋ 等待响应');
    expect(second).toContain('⠙ 等待响应');
    expect(first.match(/\/ \\__/g)).toHaveLength(1);
    expect(second.match(/\/ \\__/g)).toHaveLength(1);
  });

  it('长授权批次仍在唯一转录区滚动并保留固定底部输入区', () => {
    let state = reduceTuiState(initialTuiState(), { type: 'turn_event', event: {
      type: 'turn_start', turnId: 'auth-turn', userText: '执行批次', startedAt: 0, taskMode: 'react',
    } });
    state = reduceTuiState(state, { type: 'turn_event', event: {
      type: 'authorization_requested', turnId: 'auth-turn', taskId: 'task-1', runId: 'run-1',
      authorizationRequestId: 'auth-1', authorizationEpoch: 1,
      items: Array.from({ length: 20 }, (_, index) => ({
        callId: `call-${index}`, actionDigest: `digest-${index}`, toolName: 'edit_file',
        summary: `修改文件 ${index + 1}`, capabilityTypes: ['FilesystemWrite'], risks: index === 19 ? ['HIGH_RISK'] : [],
      })),
    } });
    const frame = render(<WeaveView {...baseProps} state={state} />).lastFrame() ?? '';
    expect(frame.split('\n')).toHaveLength(30);
    expect(frame).toContain('20. edit_file');
    expect(frame).toContain('允许一次');
    expect(frame).toContain('ReAct · 等待授权');
    expect(frame).toContain('openai-responses / gpt-test');
  });

  it('在单一 transcript 中紧凑显示工具状态、错误码与整轮统计', () => {
    let state = reduceTuiState(initialTuiState(), { type: 'turn_event', event: {
      type: 'turn_start', turnId: 'tools', userText: '检查', startedAt: 0,
    } });
    state = reduceTuiState(state, { type: 'turn_event', event: { type: 'text_delta', turnId: 'tools', delta: '我先检查。' } });
    state = reduceTuiState(state, { type: 'turn_event', event: {
      type: 'tool_call_complete', turnId: 'tools', callId: 'c1', toolName: 'read_file', summary: '读取完成', isError: false,
    } });
    state = reduceTuiState(state, { type: 'turn_event', event: {
      type: 'tool_call_skipped', turnId: 'tools', callId: 'c2', toolName: 'edit_file', summary: '未执行', isError: true,
      error: { code: 'PRIOR_WRITE_FAILED', message: '前序写入失败', retryable: false },
    } });
    state = reduceTuiState(state, { type: 'turn_event', event: { type: 'text_delta', turnId: 'tools', delta: '检查结束。' } });
    state = reduceTuiState(state, { type: 'turn_event', event: {
      type: 'turn_complete', turnId: 'tools', status: 'completed', finishReason: 'stop', durationMs: 20,
      modelTurnCount: 2, toolCallCount: 2, toolErrorCount: 1,
    } });
    const frame = render(<WeaveView {...baseProps} state={state} />).lastFrame() ?? '';
    expect(frame).toContain('✓ read_file · 读取完成');
    expect(frame).toContain('↷ edit_file · 未执行 (PRIOR_WRITE_FAILED)');
    expect(frame).toContain('完成 · 2 回合 · 2 工具 · 1 错误');
    expect(frame).not.toContain('前序写入失败');
  });

  it('在唯一 transcript 与状态栏显示 Plan 详情和三个固定选项', () => {
    const plan = { planId: 'p1', version: 2, goal: '交付功能', successCriteria: ['全量测试通过'], steps: [
      { id: 's1', description: '实现核心', dependencies: [], successCriteria: ['单测通过'], status: 'completed' as const, evidence: ['unit ok'] },
    ] };
    let state = reduceTuiState(initialTuiState(), { type: 'turn_event', event: { type: 'turn_start', turnId: 'p', userText: '/plan 交付', startedAt: 0 } });
    state = reduceTuiState(state, { type: 'turn_event', event: { type: 'plan_ready', turnId: 'p', taskId: 't1', plan } });
    state = reduceTuiState(state, { type: 'turn_event', event: { type: 'turn_complete', turnId: 'p', status: 'completed', finishReason: 'stop', durationMs: 1 } });
    const frame = render(<WeaveView {...baseProps} state={state} />).lastFrame() ?? '';
    expect(frame).toContain('计划 v2：交付功能');
    expect(frame).toContain('单测通过');
    expect(frame).toContain('unit ok');
    expect(frame).toContain('执行计划');
    expect(frame).toContain('继续完善');
    expect(frame).toContain('退出任务');
    expect(frame).toContain('Plan · 待确认');
  });

  it('在现有单行状态栏持续显示 Plan 阶段与执行进度', () => {
    const plan = { planId: 'p1', version: 1, goal: '交付', successCriteria: ['通过'], steps: [
      { id: 's1', description: '实现', dependencies: [], successCriteria: ['通过'], status: 'pending' as const, evidence: [] },
      { id: 's2', description: '验证', dependencies: ['s1'], successCriteria: ['通过'], status: 'pending' as const, evidence: [] },
    ] };
    let state = reduceTuiState(initialTuiState(), { type: 'turn_event', event: {
      type: 'turn_start', turnId: 'draft', userText: '交付', startedAt: 0, taskMode: 'plan', taskPhase: 'plan_draft',
    } });
    let frame = render(<WeaveView {...baseProps} state={state} now={1000} />).lastFrame() ?? '';
    expect(frame).toContain('Plan · 规划中 · 等待响应');

    state = reduceTuiState(state, { type: 'turn_event', event: { type: 'plan_ready', turnId: 'draft', taskId: 'task', plan } });
    state = reduceTuiState(state, { type: 'turn_event', event: { type: 'turn_complete', turnId: 'draft', status: 'completed', finishReason: 'stop', durationMs: 1 } });
    state = reduceTuiState(state, { type: 'turn_event', event: {
      type: 'turn_start', turnId: 'execute', userText: '执行', startedAt: 2, taskMode: 'plan', taskPhase: 'plan_execute',
    } });
    state = reduceTuiState(state, { type: 'turn_event', event: {
      type: 'plan_step', turnId: 'execute', taskId: 'task', planId: 'p1', version: 1, stepId: 's2', status: 'running',
    } });
    frame = render(<WeaveView {...baseProps} state={state} now={1000} />).lastFrame() ?? '';
    expect(frame).toContain('Plan · 执行 2/2');
  });

  it('滚动提示和反馈只作为模式后缀', () => {
    let state = reduceTuiState(initialTuiState(), { type: 'turn_event', event: {
      type: 'turn_start', turnId: 'plan', userText: '交付', startedAt: 0, taskMode: 'plan', taskPhase: 'plan_draft',
    } });
    state = reduceTuiState(state, { type: 'set_feedback', value: '短暂提示' });
    const viewport = { ...initialViewportState(), follow: false, unreadRows: 3 };
    const frame = render(<WeaveView {...baseProps} viewport={viewport} state={state} />).lastFrame() ?? '';
    expect(frame).toContain('Plan · 规划中 · 正在查看上文');
  });
});
