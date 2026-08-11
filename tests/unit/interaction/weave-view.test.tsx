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
    expect(frame).toContain('就绪');
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

  it('终端小于 80x24 时只显示单一尺寸提示，恢复尺寸后原状态仍可渲染', () => {
    const state = reduceTuiState(initialTuiState(), { type: 'set_composer', value: '保留草稿' });
    const small = render(<WeaveView {...baseProps} columns={79} rows={23} state={state} />).lastFrame() ?? '';
    expect(small.trim()).toBe('终端窗口过小，请调整到至少 80×24。');
    const restored = render(<WeaveView {...baseProps} state={state} />).lastFrame() ?? '';
    expect(restored).toContain('保留草稿');
  });
});
