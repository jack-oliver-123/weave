import React from 'react';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConversationController, TaskAction, TurnEvent, UserTurn } from '../../src/shared/types.js';
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

  it('显式解析 /plan、拒绝空命令，并用方向键确认当前计划版本', async () => {
    const controller = new PlanController();
    const instance = render(<WeaveTui conversation={controller} profile={profile} cwd="C:\Code\Weave" version="test" columns={100} rows={30} />);
    instances.push(instance);

    enter(instance, '/plan');
    await waitFor(() => instance.lastFrame()?.includes('用法：/plan <任务>') === true);
    expect(controller.turns).toHaveLength(0);

    enter(instance, '/plan 完成交付');
    await waitFor(() => instance.lastFrame()?.includes('执行计划') === true);
    expect(controller.turns).toEqual([{ mode: 'plan', content: '完成交付' }]);
    instance.stdin.write('\u001b[B');
    instance.stdin.write('\u001b[A');
    instance.stdin.write('\r');
    await waitFor(() => controller.actions.length === 1);
    expect(controller.actions[0]).toEqual({ type: 'approve_plan', taskId: 'task-1', planId: 'plan-1', version: 2 });
  });

  it('逐项键盘选择四种授权决定且等待期间保留普通草稿', async () => {
    const controller = new AuthorizationController();
    const instance = render(<WeaveTui conversation={controller} profile={profile} cwd="C:\\Code\\Weave" version="test" columns={100} rows={30} />);
    instances.push(instance);
    enter(instance, '执行受控批次');
    await waitFor(() => instance.lastFrame()?.includes('授权请求') === true);
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('FilesystemWrite');
    expect(frame).toContain('允许一次');
    expect(frame).toContain('本任务允许');
    expect(frame).toContain('拒绝');
    expect(frame).toContain('取消运行');
    expect(frame).not.toMatch(/全部允许|会话允许|永久允许/);

    instance.stdin.write('local draft');
    await waitFor(() => instance.lastFrame()?.includes('local draft') === true);
    instance.stdin.write('\r');
    expect(controller.actions).toHaveLength(0);
    for (let index = 0; index < 'local draft'.length; index += 1) instance.stdin.write('\u007f');

    instance.stdin.write('\u001b[B');
    instance.stdin.write('\u001b[C');
    instance.stdin.write('\u001b[B');
    instance.stdin.write('\u001b[C');
    instance.stdin.write('\u001b[C');
    instance.stdin.write('\u001b[B');
    instance.stdin.write('\u001b[C');
    instance.stdin.write('\u001b[C');
    instance.stdin.write('\u001b[C');
    instance.stdin.write('\r');
    await waitFor(() => controller.actions.length === 1);
    expect(controller.actions[0]).toMatchObject({
      type: 'resolve_authorization',
      decisions: [
        { actionDigest: 'digest-0', choice: 'allow_once' },
        { actionDigest: 'digest-1', choice: 'allow_for_task' },
        { actionDigest: 'digest-2', choice: 'deny' },
        { actionDigest: 'digest-3', choice: 'cancel' },
      ],
    });
  });
});

class AuthorizationController implements ConversationController {
  activeTurnId: string | undefined;
  readonly actions: TaskAction[] = [];
  private readonly resolved = deferred();

  submit(turn: UserTurn): AsyncIterable<TurnEvent> { return this.events(turn.content); }
  dispatch(action: TaskAction): AsyncIterable<TurnEvent> {
    this.actions.push(action);
    this.resolved.resolve();
    return this.empty();
  }
  cancel(): void { this.resolved.resolve(); }

  private async *events(userText: string): AsyncGenerator<TurnEvent> {
    const turnId = 'authorization-turn';
    this.activeTurnId = turnId;
    yield { type: 'turn_start', turnId, userText, startedAt: 0, taskMode: 'react' };
    yield {
      type: 'authorization_requested', turnId, taskId: 'task-1', runId: 'run-1',
      authorizationRequestId: 'auth-1', authorizationEpoch: 1,
      items: Array.from({ length: 4 }, (_, index) => ({
        callId: `call-${index}`, actionDigest: `digest-${index}`, toolName: 'edit_file',
        summary: `修改 ${index + 1}`, capabilityTypes: ['FilesystemWrite'], risks: index === 2 ? ['HIGH_RISK'] : [],
      })),
    };
    yield { type: 'task_state', turnId, taskId: 'task-1', state: 'awaiting_authorization', summary: '等待授权' };
    await this.resolved.promise;
    this.activeTurnId = undefined;
    yield { type: 'turn_complete', turnId, status: 'completed', finishReason: 'stop', durationMs: 1 };
  }

  private async *empty(): AsyncGenerator<TurnEvent> {}
}

class PlanController implements ConversationController {
  activeTurnId: string | undefined;
  readonly turns: UserTurn[] = [];
  readonly actions: TaskAction[] = [];
  submit(turn: UserTurn): AsyncIterable<TurnEvent> { this.turns.push(turn); return this.planEvents(); }
  dispatch(action: TaskAction): AsyncIterable<TurnEvent> { this.actions.push(action); return this.completedEvents(); }
  cancel(): void {}
  private async *planEvents(): AsyncGenerator<TurnEvent> {
    const turnId = 'plan-turn'; this.activeTurnId = turnId;
    const plan = { planId: 'plan-1', version: 2, goal: '完成交付', successCriteria: ['通过'], steps: [
      { id: 's1', description: '实现', dependencies: [], successCriteria: ['单测'], status: 'pending' as const, evidence: [] },
    ] };
    yield { type: 'turn_start', turnId, userText: '完成交付', startedAt: 0 };
    yield { type: 'plan_ready', turnId, taskId: 'task-1', plan };
    this.activeTurnId = undefined;
    yield { type: 'turn_complete', turnId, status: 'completed', finishReason: 'stop', durationMs: 1 };
  }
  private async *completedEvents(): AsyncGenerator<TurnEvent> {
    const turnId = 'execute-turn'; this.activeTurnId = turnId;
    yield { type: 'turn_start', turnId, userText: '执行计划', startedAt: 0 };
    this.activeTurnId = undefined;
    yield { type: 'turn_complete', turnId, status: 'completed', finishReason: 'stop', durationMs: 1 };
  }
}

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
  dispatch(): AsyncIterable<TurnEvent> { throw new Error('本 fixture 不支持任务操作'); }

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
  dispatch(): AsyncIterable<TurnEvent> { throw new Error('本 fixture 不支持任务操作'); }

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
