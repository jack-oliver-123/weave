import { describe, expect, it } from 'vitest';
import type { ChatMessage, ToolCallResult, ToolDefinition } from '../../../src/shared/types.js';
import { assemblePrompt } from '../../../src/engine/prompt-assembly.js';
import { buildRuntimeState } from '../../../src/engine/prompt-builder.js';
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
    const prompt = assembled([], [definition]);
    const anthropic = encodeAnthropicRequest(prompt, true);
    const chat = encodeChatRequest(prompt);
    const responses = encodeResponsesRequest(prompt);
    expect(anthropic).toMatchSnapshot();
    expect(chat).toMatchSnapshot();
    expect(responses).toMatchSnapshot();
  });

  it('工具禁用时仍保留系统指令，但不增加工具或选择字段', () => {
    const messages = [{ role: 'user', content: '你好' }] as const;
    const prompt = assembled(messages);
    expect(encodeAnthropicRequest(prompt)).not.toHaveProperty('tools');
    expect(encodeAnthropicRequest(prompt).system).toHaveLength(1);
    expect(encodeChatRequest(prompt)).not.toHaveProperty('tools');
    expect(encodeChatRequest(prompt).messages.slice(0, 2).map((message) => (message as { role: string }).role)).toEqual(['system', 'user']);
    expect(encodeResponsesRequest(prompt)).not.toHaveProperty('tools');
    expect(encodeResponsesRequest(prompt).instructions).not.toContain('<system-reminder>');
  });

  it('Chat 单 system 兼容模式合并稳定指令和动态提醒', () => {
    const prompt = assembled([{ role: 'user', content: '你好' }]);
    const encoded = encodeChatRequest(prompt, 'single');
    expect(encoded.messages).toHaveLength(3);
    expect(encoded.messages[0]).toMatchObject({ role: 'system' });
    expect((encoded.messages[0] as { content: string }).content).toContain('<identity>');
    expect((encoded.messages[0] as { content: string }).content).not.toContain('<system-reminder>');
    expect(encoded.messages[1]).toMatchObject({ role: 'user', content: expect.stringContaining('untrusted_context') });
    expect(encoded.messages[2]).toEqual({ role: 'user', content: '你好' });
  });

  it('映射三种原生历史并保留 Provider call ID 与错误标记', () => {
    expect(encodeAnthropicRequest(assembled(history)).messages.slice(1)).toEqual([
      { role: 'assistant', content: [
        { type: 'text', text: '我来读取。' },
        { type: 'tool_use', id: 'provider-1', name: 'read_file', input: { path: 'a.txt' } },
      ] },
      { role: 'user', content: [{
        type: 'tool_result', tool_use_id: 'provider-1', content: serializeToolResult(result), is_error: true,
      }] },
    ]);
    expect(encodeChatRequest(assembled(history)).messages.slice(2)).toMatchObject([
      { role: 'assistant', tool_calls: [{ id: 'provider-1' }] },
      { role: 'tool', tool_call_id: 'provider-1' },
    ]);
    expect(encodeResponsesRequest(assembled(history)).messages.slice(1)).toMatchObject([
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

function assembled(messages: readonly ChatMessage[], tools: readonly ToolDefinition[] = []) {
  return assemblePrompt({ runtime: buildRuntimeState({ mode: 'react', iterationLimit: 10 }), tools, messages });
}
