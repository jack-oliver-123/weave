import { describe, expect, it } from 'vitest';
import { initialViewportState, reduceViewport, visibleViewportLines } from '../../../src/interaction/viewport.js';

const lines = Array.from({ length: 20 }, (_, index) => `line-${index + 1}`);

describe('transcript viewport', () => {
  it('默认跟随底部，新内容到达时继续显示最新文本', () => {
    let state = initialViewportState();
    expect(visibleViewportLines(lines, 5, state)).toEqual(lines.slice(-5));
    state = reduceViewport(state, { type: 'content', lineCount: 21, height: 5 });
    expect(state).toEqual({ follow: true, offsetFromBottom: 0 });
  });

  it('用户上滚后暂停跟随且新内容不改变阅读偏移', () => {
    let state = reduceViewport(initialViewportState(), { type: 'scroll_up', lines: 4, lineCount: 20, height: 5 });
    expect(state).toEqual({ follow: false, offsetFromBottom: 4 });
    state = reduceViewport(state, { type: 'content', lineCount: 21, height: 5 });
    expect(state.offsetFromBottom).toBe(5);
  });

  it('滚回底部恢复 follow', () => {
    const up = reduceViewport(initialViewportState(), { type: 'scroll_up', lines: 4, lineCount: 20, height: 5 });
    expect(reduceViewport(up, { type: 'bottom' })).toEqual(initialViewportState());
  });

  it('高度变化时把偏移限制在唯一 transcript 区域', () => {
    const up = reduceViewport(initialViewportState(), { type: 'scroll_up', lines: 50, lineCount: 20, height: 5 });
    expect(reduceViewport(up, { type: 'resize', lineCount: 20, height: 18 }).offsetFromBottom).toBe(2);
  });
});
