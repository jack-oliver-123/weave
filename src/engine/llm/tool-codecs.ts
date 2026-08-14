import type { ChatMessage, MessageContent, PromptAssembly, ToolCallResult } from '../../shared/types.js';
import type { ChatSystemMode } from '../../config/index.js';
import { formatToolDescription } from '../../tool/description.js';
import { InternalLlmError, ProtocolError } from './errors.js';

export const MAX_TOOL_ARGUMENT_BYTES = 64 * 1024;

export interface EncodedToolRequest {
  readonly messages: readonly unknown[];
  readonly tools?: readonly unknown[];
  readonly toolChoice?: unknown;
  readonly system?: readonly unknown[];
  readonly instructions?: string;
}

export function encodeAnthropicRequest(prompt: PromptAssembly, explicitCaching = false): EncodedToolRequest {
  return {
    messages: prompt.messages.flatMap(encodeAnthropicMessage),
    system: [
      { type: 'text', text: prompt.system.stable.text, ...(explicitCaching ? { cache_control: { type: 'ephemeral' } } : {}) },
      ...(prompt.system.reminder === undefined ? [] : [{ type: 'text', text: prompt.system.reminder.text }]),
    ],
    ...(prompt.tools.length === 0 ? {} : {
      tools: prompt.tools.map((definition) => ({
        name: definition.name,
        description: formatToolDescription(definition),
        input_schema: definition.inputSchema,
      })),
      toolChoice: { type: 'auto' },
    }),
  };
}

export function encodeChatRequest(prompt: PromptAssembly, systemMode: ChatSystemMode = 'multiple'): EncodedToolRequest {
  const systemMessages = systemMode === 'single'
    ? [{ role: 'system', content: [prompt.system.stable.text, prompt.system.reminder?.text].filter((item): item is string => item !== undefined).join('\n\n') }]
    : [
        { role: 'system', content: prompt.system.stable.text },
        ...(prompt.system.reminder === undefined ? [] : [{ role: 'system', content: prompt.system.reminder.text }]),
      ];
  return {
    messages: [
      ...systemMessages,
      ...prompt.messages.flatMap(encodeChatMessage),
    ],
    ...(prompt.tools.length === 0 ? {} : {
      tools: prompt.tools.map((definition) => ({
        type: 'function',
        function: {
          name: definition.name,
          description: formatToolDescription(definition),
          parameters: definition.inputSchema,
        },
      })),
      toolChoice: 'auto',
    }),
  };
}

export function encodeResponsesRequest(prompt: PromptAssembly): EncodedToolRequest {
  return {
    messages: prompt.messages.flatMap(encodeResponsesMessage),
    instructions: [prompt.system.stable.text, prompt.system.reminder?.text].filter((item): item is string => item !== undefined).join('\n\n'),
    ...(prompt.tools.length === 0 ? {} : {
      tools: prompt.tools.map((definition) => ({
        type: 'function',
        name: definition.name,
        description: formatToolDescription(definition),
        parameters: definition.inputSchema,
      })),
      toolChoice: 'auto',
    }),
  };
}

export function serializeToolResult(result: ToolCallResult): string {
  return stableJsonStringify({
    isError: result.isError,
    summary: result.content.summary,
    ...(result.content.data === undefined ? {} : { data: result.content.data }),
    ...(result.content.error === undefined ? {} : { error: result.content.error }),
  });
}

export function parseToolArguments(raw: string): unknown {
  if (Buffer.byteLength(raw, 'utf8') > MAX_TOOL_ARGUMENT_BYTES) throw new ProtocolError();
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // 保留原文让注册中心的 Schema 校验生成可关联参数错误，不能执行工具。
    return raw;
  }
}

export function appendToolArguments(current: string, delta: string): string {
  const next = current + delta;
  if (Buffer.byteLength(next, 'utf8') > MAX_TOOL_ARGUMENT_BYTES) throw new ProtocolError();
  return next;
}

function encodeAnthropicMessage(message: ChatMessage): readonly unknown[] {
  if (typeof message.content === 'string') {
    if (message.role === 'tool') throw new ProtocolError();
    return [{ role: message.role, content: message.content }];
  }
  if (message.role === 'tool') {
    return [{ role: 'user', content: message.content.map((block) => {
      if (block.type !== 'tool_result') throw new ProtocolError();
      return {
        type: 'tool_result',
        tool_use_id: block.result.providerCallId,
        content: serializeToolResult(block.result),
        is_error: block.result.isError,
      };
    }) }];
  }
  return [{ role: message.role, content: message.content.map((block) => encodeAnthropicBlock(block)) }];
}

function encodeAnthropicBlock(block: MessageContent): unknown {
  if (block.type === 'text') return { type: 'text', text: block.text };
  if (block.type === 'tool_call') return {
    type: 'tool_use', id: block.call.providerCallId, name: block.call.name, input: block.call.input,
  };
  throw new ProtocolError();
}

function encodeChatMessage(message: ChatMessage): readonly unknown[] {
  if (typeof message.content === 'string') {
    if (message.role === 'tool') throw new ProtocolError();
    return [{ role: message.role, content: message.content }];
  }
  if (message.role === 'tool') {
    return message.content.map((block) => {
      if (block.type !== 'tool_result') throw new ProtocolError();
      return { role: 'tool', tool_call_id: block.result.providerCallId, content: serializeToolResult(block.result) };
    });
  }
  const text = message.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
  const calls = message.content.filter((block) => block.type === 'tool_call').map((block) => ({
    id: block.call.providerCallId,
    type: 'function',
    function: { name: block.call.name, arguments: stableJsonStringify(block.call.input) },
  }));
  if (message.content.some((block) => block.type === 'tool_result')) throw new ProtocolError();
  return [{ role: message.role, content: text.length === 0 ? null : text, ...(calls.length === 0 ? {} : { tool_calls: calls }) }];
}

function encodeResponsesMessage(message: ChatMessage): readonly unknown[] {
  if (typeof message.content === 'string') {
    if (message.role === 'tool') throw new ProtocolError();
    return [{ role: message.role, content: message.content }];
  }
  if (message.role === 'tool') {
    return message.content.map((block) => {
      if (block.type !== 'tool_result') throw new ProtocolError();
      return { type: 'function_call_output', call_id: block.result.providerCallId, output: serializeToolResult(block.result) };
    });
  }
  const encoded: unknown[] = [];
  const text = message.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
  if (text.length > 0) encoded.push({ role: message.role, content: text });
  for (const block of message.content) {
    if (block.type === 'tool_call') encoded.push({
      type: 'function_call',
      call_id: block.call.providerCallId,
      name: block.call.name,
      arguments: stableJsonStringify(block.call.input),
    });
    if (block.type === 'tool_result') throw new ProtocolError();
  }
  return encoded;
}

function stableJsonStringify(value: unknown): string {
  try {
    const ancestors = new Set<object>();
    const normalize = (item: unknown): unknown => {
    if (item === undefined) return undefined;
    if (typeof item === 'number' && !Number.isFinite(item)) throw new TypeError('non-finite JSON number');
    if (typeof item === 'bigint' || typeof item === 'function' || typeof item === 'symbol') throw new TypeError('invalid JSON value');
    if (item === null || typeof item !== 'object') return item;
    if (ancestors.has(item)) throw new TypeError('cyclic JSON value');
    ancestors.add(item);
    let normalized: unknown;
    if (Array.isArray(item)) {
      normalized = item.map((child) => {
        const value = normalize(child);
        if (value === undefined) throw new TypeError('undefined array item');
        return value;
      });
    } else {
      normalized = Object.fromEntries(Object.keys(item as Record<string, unknown>).sort().flatMap((key) => {
        const value = normalize((item as Record<string, unknown>)[key]);
        return value === undefined ? [] : [[key, value]];
      }));
    }
    ancestors.delete(item);
    return normalized;
    };
    return JSON.stringify(normalize(value));
  } catch {
    throw new InternalLlmError();
  }
}
