import { describe, expect, it, vi } from 'vitest';
import { decodeTerminalInput, TerminalInputDecoder } from '../../../src/interaction/terminal-input.js';
import { disableMouseTracking, enableMouseTracking } from '../../../src/interaction/terminal-screen.js';

describe('终端鼠标输入边界', () => {
  it('将 SGR 滚轮转换为动作并吞掉控制序列', () => {
    expect(decodeTerminalInput('\u001b[<64;99;1M')).toEqual({ text: '', wheel: 'up' });
    expect(decodeTerminalInput('\u001b[<65;1;30M')).toEqual({ text: '', wheel: 'down' });
    expect(decodeTerminalInput('[<64;99;1M')).toEqual({ text: '', wheel: 'up' });
  });

  it('不把不完整鼠标序列插入 composer', () => {
    expect(decodeTerminalInput('\u001b[<64;')).toEqual({ text: '', wheel: undefined });
    expect(decodeTerminalInput('普通文本')).toEqual({ text: '普通文本', wheel: undefined });
  });

  it('跨输入分片组装滚轮序列并保留其后的普通文本', () => {
    const decoder = new TerminalInputDecoder();
    expect(decoder.decode('\u001b[<64;12')).toEqual({ text: '', wheel: undefined });
    expect(decoder.decode(';8M正常')).toEqual({ text: '正常', wheel: 'up' });
  });

  it('吞掉用于聚焦的完整鼠标点击，但不吞掉随后提交的中文', () => {
    const decoder = new TerminalInputDecoder();
    expect(decoder.decode('[<0;55;6M')).toEqual({ text: '', wheel: undefined });
    expect(decoder.decode('[<0;55;6m')).toEqual({ text: '', wheel: undefined });
    expect(decoder.decode('你好')).toEqual({ text: '你好', wheel: undefined });
  });

  it('同一输入块中的点击序列不会污染其后的中文', () => {
    const decoder = new TerminalInputDecoder();
    expect(decoder.decode('\u001b[<0;55;6M\u001b[<0;55;6m你好')).toEqual({ text: '你好', wheel: undefined });
  });

  it('成对启停标准鼠标跟踪模式', () => {
    const write = vi.fn();
    enableMouseTracking({ write } as never);
    disableMouseTracking({ write } as never);
    expect(write.mock.calls[0]?.[0]).toContain('?1006h');
    expect(write.mock.calls[1]?.[0]).toContain('?1006l');
  });
});
