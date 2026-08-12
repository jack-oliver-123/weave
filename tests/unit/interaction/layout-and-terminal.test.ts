import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { calculateLayout, composerViewport } from '../../../src/interaction/layout.js';
import { enterAlternateScreen, leaveAlternateScreen } from '../../../src/interaction/terminal-screen.js';

describe('布局与终端边界', () => {
  it('输入增长只调整固定 composer 与唯一 transcript 的高度', () => {
    const single = calculateLayout(30, '一行');
    const multiline = calculateLayout(30, '一\n二\n三');
    expect(multiline.composerHeight).toBeGreaterThan(single.composerHeight);
    expect(multiline.transcriptHeight).toBeLessThan(single.transcriptHeight);
    expect(Object.values(multiline).reduce((sum, height) => sum + height, 0)).toBe(30);
  });

  it('队列摘要固定占一行且总布局不产生第二滚动区域', () => {
    const layout = calculateLayout(30, '草稿', 100, 3);
    expect(layout.queueHeight).toBe(1);
    expect(Object.values(layout).reduce((sum, height) => sum + height, 0)).toBe(30);
  });

  it('输入超过可见高度时窗口跟随光标且不创建第二滚动区', () => {
    const value = Array.from({ length: 10 }, (_, index) => `第${index + 1}行`).join('\n');
    const viewport = composerViewport(value, value.length, 20, 5);

    expect(viewport.rows).toHaveLength(5);
    expect(viewport.cursorRow).toBe(4);
    expect(viewport.hiddenAbove).toBe(true);
    expect(viewport.hiddenBelow).toBe(false);
  });

  it('终端变宽或变窄后保留同一草稿光标语义位置', () => {
    const value = 'prefix and a longer mixed text suffix';
    const cursor = value.indexOf(' suffix');
    const narrow = composerViewport(value, cursor, 10, 10);
    const wide = composerViewport(value, cursor, 24, 10);
    const beforeCursor = (viewport: ReturnType<typeof composerViewport>) => [
      ...viewport.rows.slice(0, viewport.cursorRow),
      viewport.rows[viewport.cursorRow]?.slice(0, viewport.cursorColumn) ?? '',
    ].join('');

    expect(narrow.cursorRow).toBeGreaterThan(wide.cursorRow);
    expect(beforeCursor(narrow)).toBe(value.slice(0, cursor));
    expect(beforeCursor(wide)).toBe(value.slice(0, cursor));
  });

  it('退出时恢复光标和主屏', () => {
    const write = vi.fn();
    enterAlternateScreen({ write } as never);
    leaveAlternateScreen({ write } as never);
    expect(write.mock.calls[0]?.[0]).toContain('\u001b[?1049h');
    expect(write.mock.calls[0]?.[0]).toContain('\u001b[?25l');
    expect(write.mock.calls[1]?.[0]).toContain('\u001b[?25h');
    expect(write.mock.calls[1]?.[0]).toContain('\u001b[?1049l');
  });

  it('交互层不导入供应商 SDK 或具体会话存储', async () => {
    const files = ['weave-tui.tsx', 'weave-view.tsx', 'tui-state.ts'];
    const sources = await Promise.all(files.map((file) => readFile(new URL(`../../../src/interaction/${file}`, import.meta.url), 'utf8')));
    expect(sources.join('\n')).not.toMatch(/@anthropic-ai|from ['"]openai|InMemoryConversationStore|getMessages|commitTurn/);
  });
});
