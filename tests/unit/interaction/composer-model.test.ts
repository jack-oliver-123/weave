import { describe, expect, it } from 'vitest';
import { applyComposerKey, insertPaste, type ComposerState } from '../../../src/interaction/composer-model.js';

const empty: ComposerState = { value: '', cursor: 0 };

describe('composer model', () => {
  it('Enter 提交非空输入并清空 composer', () => {
    const result = applyComposerKey({ value: '你好', cursor: 2 }, '', { return: true }, true);
    expect(result).toEqual({ state: empty, submitted: '你好' });
  });

  it('Shift+Enter 在当前光标插入换行且不提交', () => {
    const result = applyComposerKey({ value: '你好', cursor: 1 }, '', { return: true, shift: true }, true);
    expect(result).toEqual({ state: { value: '你\n好', cursor: 2 } });
  });

  it('多行粘贴保持原始换行并插入当前光标', () => {
    expect(insertPaste({ value: '前后', cursor: 1 }, '一\n二')).toEqual({ value: '前一\n二后', cursor: 4 });
  });

  it('生成期间可编辑但 Enter 不创建并发提交', () => {
    const edited = applyComposerKey(empty, '草稿', {}, false);
    expect(edited.state.value).toBe('草稿');
    expect(applyComposerKey(edited.state, '', { return: true }, false)).toEqual({ state: edited.state });
  });

  it('支持左右移动、退格和删除', () => {
    let state: ComposerState = { value: 'abc', cursor: 3 };
    state = applyComposerKey(state, '', { leftArrow: true }, true).state;
    state = applyComposerKey(state, '', { backspace: true }, true).state;
    expect(state).toEqual({ value: 'ac', cursor: 1 });
    state = applyComposerKey(state, '', { delete: true }, true).state;
    expect(state).toEqual({ value: 'a', cursor: 1 });
  });
});
