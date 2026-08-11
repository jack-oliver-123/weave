import { describe, expect, it } from 'vitest';
import { handleCtrlC, initialCtrlCState } from '../../../src/interaction/ctrl-c-state.js';

describe('Ctrl+C 状态机', () => {
  it('首次按下在生成时取消并打开 2 秒退出窗口', () => {
    expect(handleCtrlC(initialCtrlCState(), 100, true)).toEqual({
      state: { exitDeadline: 2100 }, action: 'cancel',
    });
  });

  it('首次按下在空闲时清空草稿', () => {
    expect(handleCtrlC(initialCtrlCState(), 100, false).action).toBe('clear');
  });

  it('窗口内第二次按下退出', () => {
    const first = handleCtrlC(initialCtrlCState(), 100, false);
    expect(handleCtrlC(first.state, 2099, false).action).toBe('exit');
  });

  it('超时后下一次重新作为首次处理', () => {
    const first = handleCtrlC(initialCtrlCState(), 100, true);
    expect(handleCtrlC(first.state, 2101, false)).toEqual({
      state: { exitDeadline: 4101 }, action: 'clear',
    });
  });
});
