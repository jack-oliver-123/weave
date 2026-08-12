import { describe, expect, it } from 'vitest';
import type { ChatMessage, ToolCallResult, ToolDefinition } from '../../../src/shared/types.js';
import {
  encodeAnthropicRequest,
  encodeChatRequest,
  encodeResponsesRequest,
  serializeToolResult,
} from '../../../src/engine/llm/tool-codecs.js';

const definition: ToolDefinition = {
  name: 'read_file',
  purpose: '读取工作区文本文件。',
  useWhen: ['需要查看文件内容。'],
  avoidWhen: ['需要修改文件。'],
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  resultSchema: { type: 'object', properties: { content: { type: 'string' } }, additionalProperties: false },
  worksWith: [{ toolName: 'grep', usage: '先搜索再读取。' }],
  executionMode: 'read_shared',
};

const result: ToolCallResult = {
  callId: 'internal-1', providerCallId: 'provider-1', toolName: 'read_file', isError: true,
  content: { summary: '失败', error: { code: 'NOT_FOUND', message: '不存在', retryable: false } },
};

const history: readonly ChatMessage[] = [
  { role: 'assistant', content: [
    { type: 'text', text: '我来读取。' },
    { type: 'tool_call', call: { callId: 'internal-1', providerCallId: 'provider-1', name: 'read_file', input: { path: 'a.txt' } } },
  ] },
  { role: 'tool', content: [{ type: 'tool_result', result }] },
];

describe('tool protocol codecs', () => {
  it('从同一中立定义生成三种等价工具定义与 auto 选择', () => {
    const anthropic = encodeAnthropicRequest([], [definition], '原则');
    const chat = encodeChatRequest([], [definition], '原则');
    const responses = encodeResponsesRequest([], [definition], '原则');
    expect(anthropic).toMatchSnapshot();
    expect(chat).toMatchSnapshot();
    expect(responses).toMatchSnapshot();
  });

  it('工具禁用时不增加工具、选择或系统指令字段', () => {
    const messages = [{ role: 'user', content: '你好' }] as const;
    expect(encodeAnthropicRequest(messages)).toEqual({ messages });
    expect(encodeChatRequest(messages)).toEqual({ messages });
    expect(encodeResponsesRequest(messages)).toEqual({ messages });
  });

  it('映射三种原生历史并保留 Provider call ID 与错误标记', () => {
    expect(encodeAnthropicRequest(history).messages).toEqual([
      { role: 'assistant', content: [
        { type: 'text', text: '我来读取。' },
        { type: 'tool_use', id: 'provider-1', name: 'read_file', input: { path: 'a.txt' } },
      ] },
      { role: 'user', content: [{
        type: 'tool_result', tool_use_id: 'provider-1', content: serializeToolResult(result), is_error: true,
      }] },
    ]);
    expect(encodeChatRequest(history).messages).toMatchObject([
      { role: 'assistant', tool_calls: [{ id: 'provider-1' }] },
      { role: 'tool', tool_call_id: 'provider-1' },
    ]);
    expect(encodeResponsesRequest(history).messages).toMatchObject([
      { role: 'assistant', content: '我来读取。' },
      { type: 'function_call', call_id: 'provider-1' },
      { type: 'function_call_output', call_id: 'provider-1' },
    ]);
    expect(serializeToolResult(result)).toContain('"isError":true');
  });

  it('稳定排序字段、忽略对象 undefined，并拒绝非法 JSON 值', () => {
    const valid = { ...result, content: { summary: 'ok', data: { z: 1, ignored: undefined, a: 2 } }, isError: false };
    expect(serializeToolResult(valid)).toBe('{"data":{"a":2,"z":1},"isError":false,"summary":"ok"}');
    expect(() => serializeToolResult({ ...valid, content: { summary: 'x', data: Number.NaN } })).toThrow();
    expect(() => serializeToolResult({ ...valid, content: { summary: 'x', data: 1n } })).toThrow();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => serializeToolResult({ ...valid, content: { summary: 'x', data: cyclic } })).toThrow();
  });
});
