import stripAnsi from 'strip-ansi';
import { describe, expect, it } from 'vitest';
import { renderMarkdown, rowText } from '../../../src/interaction/markdown-renderer.js';

const text = (source: string, width = 80, final = true) => renderMarkdown(source, { width, final }).map(rowText);

describe('渐进式 Markdown 渲染', () => {
  it('渲染完整 GFM 元素且不显示样式标记', () => {
    const rows = text([
      '### 能力',
      '',
      '- **加粗**与*斜体*及~~删除~~',
      '- [x] 任务',
      '',
      '> 引用',
      '',
      '`inline` [链接](https://example.com)',
      '',
      '---',
    ].join('\n'));
    const plain = stripAnsi(rows.join('\n'));
    expect(plain).toContain('能力');
    expect(plain).toContain('• 加粗与斜体及删除');
    expect(plain).toContain('☑ 任务');
    expect(plain).toContain('│ 引用');
    expect(plain).toContain('inline');
    expect(plain).toContain('链接 (https://example.com)');
    expect(plain).not.toMatch(/###|\*\*|~~/);
  });

  it('流式未闭合尾段保持源码，终态再规范化', () => {
    expect(text('前文\n\n**尚未闭合', 80, false).at(-1)).toBe('**尚未闭合');
    expect(text('前文\n\n**已闭合**', 80, false).at(-1)).toBe('已闭合');
    expect(text('```ts\nconst x = 1', 80, false).join('\n')).toContain('```ts');
    expect(stripAnsi(text('```ts\nconst x = 1', 80, true).join('\n'))).toContain('const x = 1');
  });

  it('稳定前缀在流式和终态解析之间保持同一显示行锚点', () => {
    const streaming = renderMarkdown('前文\n\n**尚未闭合', { width: 80, final: false, keyPrefix: 'turn' });
    const completed = renderMarkdown('前文\n\n**尚未闭合**', { width: 80, final: true, keyPrefix: 'turn' });
    expect(streaming[0]?.key).toBe(completed[0]?.key);
  });

  it('表格宽时对齐、窄时降级为键值布局', () => {
    const source = '| 名称 | 说明 |\n| --- | --- |\n| Weave | 终端助手 |';
    expect(text(source, 40).join('\n')).toContain('名称');
    expect(text(source, 12)).toEqual(expect.arrayContaining(['名称：Weave', '说明：终端助', '手']));
  });

  it('代码块显示语言并以续行标记折行', () => {
    const rows = text('```ts\nconst longName = "abcdef";\n```', 14);
    expect(stripAnsi(rows.join('\n'))).toContain('ts');
    expect(stripAnsi(rows.join('\n'))).toContain('↪');
  });

  it('只在允许颜色且语言已知时生成内部 ANSI 高亮', () => {
    const highlighted = renderMarkdown('```ts\nconst value = 1;\n```', { width: 80, final: true, color: true });
    expect(highlighted.some((row) => row.spans.some((span) => span.style?.ansi === true && span.text.includes('\u001b[')))).toBe(true);

    const unknown = renderMarkdown('```not-a-language\nplain text\n```', { width: 80, final: true, color: true });
    expect(unknown.some((row) => row.spans.some((span) => span.style?.ansi === true))).toBe(false);

    const noColor = renderMarkdown('```ts\nconst value = 1;\n```', { width: 80, final: true, color: false });
    expect(noColor.some((row) => row.spans.some((span) => span.style?.ansi === true))).toBe(false);
  });

  it('不执行模型 ANSI，解析异常时可退化为安全文本', () => {
    const rows = text('\u001b[2J**安全**');
    expect(rows.join('')).not.toContain('\u001b[2J');
    expect(stripAnsi(rows.join(''))).toContain('安全');
  });
});
