import { describe, expect, it } from 'vitest';
import { sanitizeTerminalText } from '../../../src/shared/sanitize-terminal-text.js';

describe('sanitizeTerminalText', () => {
  it.each([
    ['ANSI 样式', '\u001b[31m红色\u001b[0m', '红色'],
    ['OSC 标题', '\u001b]0;偷换标题\u0007正文', '正文'],
    ['光标控制', '前\u001b[2J\u001b[H后', '前后'],
    ['C0/C1', `a\u0000\u0008\u000b\u001f\u007f\u0085b`, 'ab'],
    ['换行与制表符', 'a\n\tb', 'a\n\tb'],
    ['中文与 Unicode', '你好 café 🚀', '你好 café 🚀'],
    ['代码围栏', '```ts\nconst x = 1;\n```', '```ts\nconst x = 1;\n```'],
  ])('清理%s且保留安全文本', (_name, input, expected) => {
    expect(sanitizeTerminalText(input)).toBe(expected);
  });
});
