import { describe, expect, it } from 'vitest';
import {
  cursorPosition,
  nextGraphemeBoundary,
  previousGraphemeBoundary,
  truncateDisplay,
  wrapDisplayText,
} from '../../../src/interaction/display-width.js';

describe('实际显示行', () => {
  it('按显示宽度折叠 ASCII、中文、Emoji 与组合字符', () => {
    expect(wrapDisplayText('ab中文', 4).map((line) => line.text)).toEqual(['ab中', '文']);
    expect(wrapDisplayText('A🙂B', 3).map((line) => line.text)).toEqual(['A🙂', 'B']);
    expect(wrapDisplayText('e\u0301x', 1).map((line) => line.text)).toEqual(['e\u0301', 'x']);
  });

  it('只在字素边界移动和删除', () => {
    const value = 'A👨‍👩‍👧‍👦e\u0301中';
    const afterA = nextGraphemeBoundary(value, 0);
    const afterEmoji = nextGraphemeBoundary(value, afterA);
    expect(value.slice(afterA, afterEmoji)).toBe('👨‍👩‍👧‍👦');
    expect(previousGraphemeBoundary(value, afterEmoji)).toBe(afterA);
  });

  it('计算带自动折行的光标坐标', () => {
    expect(cursorPosition('ab中文', 3, 4)).toEqual({ row: 0, column: 4 });
    expect(cursorPosition('ab中文', 4, 4)).toEqual({ row: 1, column: 2 });
  });

  it('按显示宽度截断并保留提示宽度', () => {
    expect(truncateDisplay('最新：中文消息', 10)).toBe('最新：中…');
  });
});
