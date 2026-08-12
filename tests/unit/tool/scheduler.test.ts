import { describe, expect, it } from 'vitest';
import type { ToolCallRequest, ToolCallResult, ToolDefinition } from '../../../src/shared/types.js';
import { ToolCallScheduler, ToolCallLimitError } from '../../../src/tool/scheduler.js';

const schema = { type: 'object', additionalProperties: false } as const;
const def = (name: string, executionMode: 'read_shared' | 'write_exclusive'): ToolDefinition => ({
  name, purpose: name, useWhen: ['x'], avoidWhen: ['y'], inputSchema: schema, resultSchema: schema, worksWith: [], executionMode,
});
const call = (index: number, name: string): ToolCallRequest => ({ callId: `c${index}`, providerCallId: `p${index}`, name, input: {} });
const success = (request: ToolCallRequest, data: unknown = {}): ToolCallResult => ({
  callId: request.callId, providerCallId: request.providerCallId, toolName: request.name, isError: false,
  content: { summary: 'ok', data },
});
const failure = (request: ToolCallRequest): ToolCallResult => ({
  callId: request.callId, providerCallId: request.providerCallId, toolName: request.name, isError: true,
  content: { summary: 'fail', error: { code: 'COMMAND_FAILED', message: 'fail', retryable: false } },
});

describe('ToolCallScheduler', () => {
  it('runs contiguous reads concurrently with max 8 and write barriers in strict order', async () => {
    const definitions = [def('read', 'read_shared'), def('write', 'write_exclusive')];
    const timeline: string[] = []; let active = 0; let maxActive = 0;
    const scheduler = new ToolCallScheduler({ definitions, dispatch: async (request) => {
      timeline.push(`start:${request.callId}`); active++; maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, request.name === 'read' ? 10 : 1));
      active--; timeline.push(`end:${request.callId}`); return success(request);
    }});
    const calls = [...Array.from({ length: 10 }, (_, index) => call(index, 'read')), call(10, 'write'), call(11, 'read')];
    const started: string[] = [];
    const results = await scheduler.execute(calls, new AbortController().signal, 0, { onStart: (item) => started.push(item.callId) });
    expect(maxActive).toBe(8);
    expect(results.results.map((item) => item.callId)).toEqual(calls.map((item) => item.callId));
    expect(timeline.indexOf('start:c10')).toBeGreaterThan(timeline.indexOf('end:c9'));
    expect(timeline.indexOf('start:c11')).toBeGreaterThan(timeline.indexOf('end:c10'));
    expect(started).toEqual(calls.map((item) => item.callId));
  });

  it('continues after read failure but skips after write failure or unknown tool', async () => {
    const definitions = [def('read', 'read_shared'), def('write', 'write_exclusive')];
    const executed: string[] = [];
    const scheduler = new ToolCallScheduler({ definitions, dispatch: async (request) => {
      executed.push(request.callId); return request.callId === 'c1' || request.callId === 'c3' ? failure(request) : success(request);
    }});
    const results = await scheduler.execute([call(1, 'read'), call(2, 'read'), call(3, 'write'), call(4, 'read')], new AbortController().signal);
    expect(executed).toEqual(['c1', 'c2', 'c3']);
    expect(results.results[3]).toMatchObject({ isError: true, content: { error: { code: 'PRIOR_WRITE_FAILED' } } });
    const unknown = await scheduler.execute([call(5, 'missing'), call(6, 'read')], new AbortController().signal);
    expect(unknown.results.map((item) => item.content.error?.code)).toEqual(['UNKNOWN_TOOL', 'PRIOR_WRITE_FAILED']);
  });

  it('marks running and waiting calls on cancellation', async () => {
    const controller = new AbortController();
    const scheduler = new ToolCallScheduler({ definitions: [def('read', 'read_shared'), def('write', 'write_exclusive')], dispatch: async (request, signal) => {
      if (request.callId === 'c1') controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 1));
      return signal.aborted ? { ...failure(request), content: { summary: 'cancel', error: { code: 'TOOL_CANCELLED', message: 'cancel', retryable: false } } } : success(request);
    }});
    const results = await scheduler.execute([call(1, 'read'), call(2, 'write')], controller.signal);
    expect(results.results.map((item) => item.content.error?.code)).toEqual(['TOOL_CANCELLED', 'TURN_CANCELLED']);
  });

  it('并行槽位外尚未 dispatch 的读取调用标记为 TURN_CANCELLED', async () => {
    const controller = new AbortController();
    let entered = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const scheduler = new ToolCallScheduler({ definitions: [def('read', 'read_shared')], dispatch: async (request) => {
      entered += 1;
      if (entered === 8) controller.abort();
      await gate;
      return { ...failure(request), content: { summary: 'cancel', error: { code: 'TOOL_CANCELLED', message: 'cancel', retryable: false } } };
    }});
    const executing = scheduler.execute(Array.from({ length: 10 }, (_, index) => call(index, 'read')), controller.signal);
    while (entered < 8) await new Promise((resolve) => setTimeout(resolve, 1));
    release();
    const output = await executing;
    expect(output.results.slice(0, 8).every((result) => result.content.error?.code === 'TOOL_CANCELLED')).toBe(true);
    expect(output.results.slice(8).map((result) => result.content.error?.code)).toEqual(['TURN_CANCELLED', 'TURN_CANCELLED']);
  });

  it('enforces per-response and cumulative limits including skipped calls', async () => {
    const scheduler = new ToolCallScheduler({ definitions: [def('read', 'read_shared')], dispatch: async (request) => success(request) });
    await expect(scheduler.execute(Array.from({ length: 33 }, (_, index) => call(index, 'read')), new AbortController().signal))
      .rejects.toBeInstanceOf(ToolCallLimitError);
    const first = await scheduler.execute(Array.from({ length: 32 }, (_, index) => call(index, 'read')), new AbortController().signal, 68);
    expect(first.totalCalls).toBe(100);
    expect(first.finalTextOnly).toBe(true);
  });

  it('caps serialized result budget while preserving later errors', async () => {
    const scheduler = new ToolCallScheduler({ definitions: [def('read', 'read_shared')], dispatch: async (request) =>
      request.callId === 'c2' ? failure(request) : success(request, { content: 'x'.repeat(600 * 1024) }) });
    const output = await scheduler.execute([call(1, 'read'), call(2, 'read')], new AbortController().signal);
    expect(Buffer.byteLength(JSON.stringify(output.results))).toBeLessThanOrEqual(512 * 1024);
    expect(output.results[0]).toMatchObject({ isError: false, content: { data: { truncated: true } } });
    expect(output.results[1]).toMatchObject({ isError: true, content: { error: { code: 'COMMAND_FAILED' } } });
  });

  it('counts JSON escaping when fitting the 512 KiB serialized budget', async () => {
    const scheduler = new ToolCallScheduler({ definitions: [def('read', 'read_shared')], dispatch: async (request) =>
      success(request, { content: '\\"'.repeat(400 * 1024) }) });
    const output = await scheduler.execute([call(1, 'read')], new AbortController().signal);
    expect(Buffer.byteLength(JSON.stringify(output.results))).toBeLessThanOrEqual(512 * 1024);
    expect(output.results[0]).toMatchObject({ content: { data: { truncated: true } } });
  });

  it('reserves correlated shells for later successful results within the 512 KiB budget', async () => {
    const scheduler = new ToolCallScheduler({ definitions: [def('read', 'read_shared')], dispatch: async (request) =>
      success(request, { content: 'x'.repeat(request.callId === 'c1' ? 524_020 : 1_000) }) });
    const output = await scheduler.execute([call(1, 'read'), call(2, 'read')], new AbortController().signal);
    expect(Buffer.byteLength(JSON.stringify(output.results))).toBeLessThanOrEqual(512 * 1024);
    expect(output.results[0]).toMatchObject({ callId: 'c1', isError: false, content: { data: { content: expect.any(String) } } });
    expect(output.results[1]).toMatchObject({ callId: 'c2', isError: false, content: { data: { truncated: true } } });
  });
});
