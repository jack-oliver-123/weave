import { describe, expect, it } from 'vitest';
import type { JsonSchema, ToolDefinition } from '../../../src/shared/types.js';
import { BaseTool } from '../../../src/tool/base-tool.js';
import { ToolDefinitionError, ToolError } from '../../../src/tool/errors.js';
import { formatToolDescription } from '../../../src/tool/description.js';
import { ToolRegistry } from '../../../src/tool/registry.js';

const objectSchema: JsonSchema = {
  type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false,
};

function definition(name = 'echo', mode: 'read_shared' | 'write_exclusive' = 'read_shared'): ToolDefinition {
  return {
    name, purpose: '返回输入', useWhen: ['需要回显'], avoidWhen: ['需要写文件'],
    inputSchema: objectSchema, resultSchema: objectSchema,
    worksWith: [], executionMode: mode,
  };
}

class EchoTool extends BaseTool<{ value: string }, { value: string }> {
  constructor(def = definition()) { super(def); }
  protected async run(input: { value: string }): Promise<{ value: string }> { return input; }
  protected successSummary(): string { return '回显完成'; }
}

class FailingTool extends EchoTool {
  protected override async run(): Promise<{ value: string }> {
    throw new ToolError('FILE_NOT_FOUND', '文件不存在', false, { path: 'a.txt' });
  }
}

describe('ToolRegistry and BaseTool', () => {
  it('formats all structured guidance in a stable order', () => {
    expect(formatToolDescription(definition())).toBe([
      '用途：返回输入', '适用场景：', '- 需要回显', '不适用场景：', '- 需要写文件',
      '参数约束：{"type":"object","properties":{"value":{"type":"string"}},"required":["value"],"additionalProperties":false}',
      '返回格式：统一结果信封包含 isError、summary、data 或 error；成功 data 结构为 {"type":"object","properties":{"value":{"type":"string"}},"required":["value"],"additionalProperties":false}',
      '工具配合：无。',
    ].join('\n'));
  });

  it('compiles schemas, validates input and wraps success', async () => {
    const registry = new ToolRegistry([new EchoTool()]);
    await expect(registry.dispatch(
      { callId: 'c1', providerCallId: 'p1', name: 'echo', input: { value: 'ok' } },
      { signal: new AbortController().signal },
    )).resolves.toEqual({
      callId: 'c1', providerCallId: 'p1', toolName: 'echo', isError: false,
      content: { summary: '回显完成', data: { value: 'ok' } },
    });
    await expect(registry.dispatch(
      { callId: 'c2', providerCallId: 'p2', name: 'echo', input: { value: 'ok', extra: true } },
      { signal: new AbortController().signal },
    )).resolves.toMatchObject({ isError: true, content: { error: { code: 'INVALID_ARGUMENT' } } });
  });

  it('maps expected and unknown failures without stacks', async () => {
    const expected = new ToolRegistry([new FailingTool()]);
    const result = await expected.dispatch(
      { callId: 'c', providerCallId: 'p', name: 'echo', input: { value: 'x' } },
      { signal: new AbortController().signal },
    );
    expect(result).toMatchObject({ isError: true, content: { error: { code: 'FILE_NOT_FOUND', retryable: false } } });
    expect(JSON.stringify(result)).not.toContain('stack');
  });

  it.each([
    ['duplicate', [new EchoTool(), new EchoTool()]],
    ['invalid name', [new EchoTool(definition('Bad Name'))]],
    ['missing guidance', [new EchoTool({ ...definition(), avoidWhen: [] })]],
    ['missing relation', [new EchoTool({ ...definition(), worksWith: [{ toolName: 'missing', usage: 'x' }] })]],
  ])('rejects invalid registry: %s', (_name, tools) => {
    expect(() => new ToolRegistry(tools)).toThrow(ToolDefinitionError);
  });

  it('deep-freezes definitions and returns an immutable list', () => {
    const registry = new ToolRegistry([new EchoTool()]);
    const definitions = registry.listDefinitions();
    expect(Object.isFrozen(definitions)).toBe(true);
    expect(Object.isFrozen(definitions[0])).toBe(true);
    expect(Object.isFrozen(definitions[0]?.useWhen)).toBe(true);
  });

  it('rejects oversized definitions at startup', () => {
    expect(() => new ToolRegistry([new EchoTool({ ...definition(), purpose: 'x'.repeat(9 * 1024) })]))
      .toThrow(ToolDefinitionError);
  });
});
