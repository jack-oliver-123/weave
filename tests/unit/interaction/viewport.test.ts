import { describe, expect, it } from 'vitest';
import { initialViewportState, reduceViewport, visibleViewportLines } from '../../../src/interaction/viewport.js';

const rows = Array.from({ length: 20 }, (_, index) => ({ key: `line-${index + 1}`, text: `line-${index + 1}` }));

describe('transcript viewport', () => {
  it('默认跟随底部，新内容到达时继续显示最新文本', () => {
    let state = initialViewportState();
    expect(visibleViewportLines(rows, 5, state)).toEqual(rows.slice(-5));
    state = reduceViewport(state, { type: 'content', rows: [...rows, { key: 'line-21', text: 'line-21' }], height: 5 });
    expect(state).toMatchObject({ follow: true, offsetFromBottom: 0, unreadRows: 0, lineCount: 21 });
  });

  it('用户上滚后以显示行 key 保持阅读锚点并累计新增实际行', () => {
    let state = reduceViewport(initialViewportState(), { type: 'scroll_up', lines: 4, rows, height: 5 });
    expect(state).toMatchObject({ follow: false, offsetFromBottom: 4, anchorKey: 'line-12', lineCount: 20 });
    const updated = [{ key: 'inserted', text: 'inserted' }, ...rows, { key: 'line-21', text: 'line-21' }];
    state = reduceViewport(state, { type: 'content', rows: updated, height: 5 });
    expect(state).toMatchObject({ anchorKey: 'line-12', unreadRows: 2 });
    expect(visibleViewportLines(updated, 5, state)[0]?.key).toBe('line-12');
  });

  it('向下滚回底部或 bottom 动作恢复 follow 并清零未读', () => {
    const up = reduceViewport(initialViewportState(), { type: 'scroll_up', lines: 4, rows, height: 5 });
    const down = reduceViewport(up, { type: 'scroll_down', lines: 4, rows, height: 5 });
    expect(down).toMatchObject({ follow: true, offsetFromBottom: 0, unreadRows: 0, anchorKey: undefined });
    expect(reduceViewport(up, { type: 'bottom' })).toMatchObject({ follow: true, offsetFromBottom: 0, unreadRows: 0 });
  });

  it('高度变化时保留同一顶部锚点并把偏移限制在唯一 transcript 区域', () => {
    const up = reduceViewport(initialViewportState(), { type: 'scroll_up', lines: 50, rows, height: 5 });
    const resized = reduceViewport(up, { type: 'resize', rows, height: 18 });
    expect(resized).toMatchObject({ offsetFromBottom: 2, anchorKey: 'line-1' });
    expect(visibleViewportLines(rows, 18, resized)[0]?.key).toBe('line-1');
  });

  it('滚轮按实际显示行移动且固定区不参与视口数据', () => {
    let state = reduceViewport(initialViewportState(), { type: 'content', rows, height: 5 });
    state = reduceViewport(state, { type: 'scroll_up', lines: 3, rows, height: 5 });
    expect(visibleViewportLines(rows, 5, state)[0]?.key).toBe('line-13');
    state = reduceViewport(state, { type: 'scroll_down', lines: 3, rows, height: 5 });
    expect(state.follow).toBe(true);
  });
});
