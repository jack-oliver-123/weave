import { EventEmitter } from 'node:events';
import React from 'react';
import { render as renderInk } from 'ink';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConversationController, TurnEvent, UserTurn } from '../../src/shared/types.js';
import { WeaveTui } from '../../src/interaction/weave-tui.js';
import { WeaveView } from '../../src/interaction/weave-view.js';
import { initialTuiState, reduceTuiState } from '../../src/interaction/tui-state.js';
import { initialViewportState } from '../../src/interaction/viewport.js';

const profile = { name: 'fixture', protocol: 'openai-responses' as const, model: 'fixture-model' };
const instances: Array<{ cleanup(): void }> = [];

afterEach(() => {
  for (const instance of instances.splice(0)) instance.cleanup();
});

describe('TUI 交互集成', () => {
  it('经典 CMD 将 Ctrl+J 的原始 LF 作为换行且不提前提交', async () => {
    const controller = new CompletingController();
    const instance = render(<WeaveTui
      conversation={controller}
      profile={profile}
      cwd="C:\\Code\\Weave"
      version="test"
      columns={100}
      rows={30}
    />);
    instances.push(instance);

    instance.stdin.write('line-one');
    instance.stdin.write('\n');
    instance.stdin.write('line-two');
    instance.stdin.write('\r');
    await waitFor(() => controller.submissions.length === 1);

    expect(controller.submissions).toEqual(['line-one\nline-two']);
  });

  it('生成期间连续入队，完成后只按空行合并续发一次并保留未入队草稿', async () => {
    const controller = new CompletingController();
    const instance = render(<WeaveTui
      conversation={controller}
      profile={profile}
      cwd="C:\\Code\\Weave"
      version="test"
      columns={100}
      rows={30}
    />);
    instances.push(instance);

    enter(instance, 'first');
    await waitFor(() => instance.lastFrame()?.includes('first-chunk') === true);
    enter(instance, 'queued-one');
    enter(instance, 'queued-two');
    instance.stdin.write('draft-only');
    await waitFor(() => instance.lastFrame()?.includes('已排队 2 条') === true);

    controller.releaseFirst();
    await waitFor(() => controller.submissions.length === 2 && instance.lastFrame()?.includes('queue-ok') === true);

    expect(controller.submissions).toEqual(['first', 'queued-one\n\nqueued-two']);
    expect(instance.lastFrame()).toContain('draft-only');
  });

  it('非正常终态暂停队列，显示退出丢失提示并仅在 Enter 后继续', async () => {
    const controller = new TruncatingController();
    const instance = render(<WeaveTui
      conversation={controller}
      profile={profile}
      cwd="C:\\Code\\Weave"
      version="test"
      columns={100}
      rows={30}
    />);
    instances.push(instance);

    enter(instance, 'first');
    await waitFor(() => instance.lastFrame()?.includes('partial') === true);
    enter(instance, 'after-truncated');
    controller.releaseFirst();
    await waitFor(() => instance.lastFrame()?.includes('队列已暂停') === true);
    expect(controller.submissions).toEqual(['first']);

    instance.stdin.write('\u0003');
    await waitFor(() => instance.lastFrame()?.includes('将丢失 1 条排队消息') === true);
    instance.stdin.write('\r');
    await waitFor(() => controller.submissions.length === 2 && instance.lastFrame()?.includes('resume-ok') === true);
    expect(controller.submissions).toEqual(['first', 'after-truncated']);
  });

  it('使用原生终端光标定位且不渲染手绘块光标', async () => {
    const stdout = new TerminalOutput();
    const stderr = new TerminalOutput();
    const stdin = new TerminalInput();
    const instance = renderInk(<WeaveView
      state={initialTuiState()}
      profile={profile}
      version="test"
      cwd="C:\\Code\\Weave"
      columns={100}
      rows={30}
      viewport={initialViewportState()}
      cursor={0}
    />, {
      stdout: stdout as never,
      stderr: stderr as never,
      stdin: stdin as never,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    instances.push(instance);
    await waitFor(() => stdout.writes.some((value) => value.includes('\u001b[?25h')));

    expect(stdout.writes.join('')).toContain('\u001b[2A\u001b[5G\u001b[?25h');
    expect(stdout.writes.join('')).not.toContain('█');
  });

  it('Ink 视图渲染 Markdown 结构并保持队列、composer 和状态栏固定', () => {
    let state = reduceTuiState(initialTuiState(), { type: 'turn_event', event: {
      type: 'turn_start', turnId: 'markdown', userText: 'show markdown', startedAt: 0,
    } });
    state = reduceTuiState(state, { type: 'turn_event', event: {
      type: 'text_delta', turnId: 'markdown', delta: '### 标题\n\n**正文**\n\n| 名称 | 说明 |\n| --- | --- |\n| Weave | 终端助手 |\n\n```ts\nconst x = 1;\n```',
    } });
    state = reduceTuiState(state, { type: 'turn_event', event: {
      type: 'turn_complete', turnId: 'markdown', status: 'completed', finishReason: 'stop', durationMs: 1,
    } });
    state = reduceTuiState(state, { type: 'queue_message', value: 'queued-preview' });

    const instance = render(<WeaveView
      state={state}
      profile={profile}
      version="test"
      cwd="C:\\Code\\Weave"
      columns={100}
      rows={30}
      viewport={initialViewportState()}
      cursor={0}
    />);
    instances.push(instance);
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('标题');
    expect(frame).toContain('Weave');
    expect(frame).toContain('const x = 1;');
    expect(frame).toContain('已排队 1 条');
    expect(frame).toContain('openai-responses / fixture-model');
    expect(frame).not.toMatch(/###|\*\*|```|█/);
    expect(frame.split('\n')).toHaveLength(30);
  });
});

class CompletingController implements ConversationController {
  activeTurnId: string | undefined;
  readonly submissions: string[] = [];
  private readonly firstGate = deferred();

  submit(turn: UserTurn): AsyncIterable<TurnEvent> {
    const index = this.submissions.push(turn.content);
    const turnId = `turn-${index}`;
    this.activeTurnId = turnId;
    return this.events(index, turnId, turn.content);
  }

  cancel(): void {}

  releaseFirst(): void {
    this.firstGate.resolve();
  }

  private async *events(index: number, turnId: string, userText: string): AsyncGenerator<TurnEvent> {
    yield { type: 'turn_start', turnId, userText, startedAt: performance.now() };
    yield { type: 'text_delta', turnId, delta: index === 1 ? '### first-chunk' : '### queue-ok' };
    if (index === 1) await this.firstGate.promise;
    this.activeTurnId = undefined;
    yield { type: 'turn_complete', turnId, status: 'completed', finishReason: 'stop', durationMs: 1 };
  }
}

class TruncatingController implements ConversationController {
  activeTurnId: string | undefined;
  readonly submissions: string[] = [];
  private readonly firstGate = deferred();

  submit(turn: UserTurn): AsyncIterable<TurnEvent> {
    const index = this.submissions.push(turn.content);
    const turnId = `turn-${index}`;
    this.activeTurnId = turnId;
    return this.events(index, turnId, turn.content);
  }

  cancel(): void {}

  releaseFirst(): void {
    this.firstGate.resolve();
  }

  private async *events(index: number, turnId: string, userText: string): AsyncGenerator<TurnEvent> {
    yield { type: 'turn_start', turnId, userText, startedAt: performance.now() };
    yield { type: 'text_delta', turnId, delta: index === 1 ? 'partial' : 'resume-ok' };
    if (index === 1) await this.firstGate.promise;
    this.activeTurnId = undefined;
    yield {
      type: 'turn_complete',
      turnId,
      status: index === 1 ? 'truncated' : 'completed',
      finishReason: index === 1 ? 'max_tokens' : 'stop',
      durationMs: 1,
    };
  }
}

class TerminalOutput extends EventEmitter {
  readonly columns = 100;
  readonly rows = 30;
  readonly isTTY = true;
  readonly writes: string[] = [];

  write = (value: string): boolean => {
    this.writes.push(value);
    return true;
  };
}

class TerminalInput extends EventEmitter {
  readonly isTTY = true;
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read(): null { return null; }
}

function enter(instance: ReturnType<typeof render>, value: string): void {
  instance.stdin.write(value);
  instance.stdin.write('\r');
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve = () => {};
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for TUI state');
}
