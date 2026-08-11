import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { calculateLayout } from '../../../src/interaction/layout.js';
import { enterAlternateScreen, leaveAlternateScreen } from '../../../src/interaction/terminal-screen.js';

describe('布局与终端边界', () => {
  it('输入增长只调整固定 composer 与唯一 transcript 的高度', () => {
    const single = calculateLayout(30, '一行');
    const multiline = calculateLayout(30, '一\n二\n三');
    expect(multiline.composerHeight).toBeGreaterThan(single.composerHeight);
    expect(multiline.transcriptHeight).toBeLessThan(single.transcriptHeight);
    expect(Object.values(multiline).reduce((sum, height) => sum + height, 0)).toBe(30);
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
