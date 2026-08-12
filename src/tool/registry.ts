import { Ajv, type ValidateFunction } from 'ajv/dist/ajv.js';
import type { ToolCallRequest, ToolCallResult, ToolDefinition } from '../shared/types.js';
import type { BaseTool, ToolExecutionContext } from './base-tool.js';
import { formatToolDescription } from './description.js';
import { ToolDefinitionError } from './errors.js';

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const DESCRIPTION_MAX = 8 * 1024;
const SCHEMA_MAX = 32 * 1024;
const DEFINITIONS_MAX = 256 * 1024;

export class ToolRegistry {
  private readonly tools: ReadonlyMap<string, BaseTool<unknown, unknown>>;
  private readonly definitions: readonly ToolDefinition[];

  constructor(tools: readonly BaseTool<any, any>[]) {
    const ajv = new Ajv({ allErrors: true, strict: true });
    const map = new Map<string, BaseTool<unknown, unknown>>();
    for (const tool of tools) {
      validateDefinition(tool.definition);
      if (map.has(tool.definition.name)) throw new ToolDefinitionError(`工具名称重复：${tool.definition.name}`);
      let input: ValidateFunction;
      let result: ValidateFunction;
      try {
        input = ajv.compile(tool.definition.inputSchema);
        result = ajv.compile(tool.definition.resultSchema);
      } catch {
        throw new ToolDefinitionError(`工具 Schema 无效：${tool.definition.name}`);
      }
      tool.bindValidators(input, result);
      map.set(tool.definition.name, tool);
    }
    for (const tool of tools) {
      for (const relation of tool.definition.worksWith) {
        if (!map.has(relation.toolName)) {
          throw new ToolDefinitionError(`工具 ${tool.definition.name} 引用了不存在的工具 ${relation.toolName}`);
        }
      }
    }
    const definitions = tools.map((tool) => deepFreeze(structuredClone(tool.definition)));
    if (Buffer.byteLength(JSON.stringify(definitions), 'utf8') > DEFINITIONS_MAX) {
      throw new ToolDefinitionError('工具定义集合超过 256 KiB');
    }
    this.tools = map;
    this.definitions = Object.freeze(definitions);
  }

  listDefinitions(): readonly ToolDefinition[] { return this.definitions; }
  get(name: string): BaseTool<unknown, unknown> | undefined { return this.tools.get(name); }

  async dispatch(request: ToolCallRequest, context: ToolExecutionContext): Promise<ToolCallResult> {
    const tool = this.tools.get(request.name);
    if (tool === undefined) {
      return {
        callId: request.callId, providerCallId: request.providerCallId, toolName: request.name, isError: true,
        content: { summary: '工具不存在。', error: { code: 'UNKNOWN_TOOL', message: '请求的工具不存在。', retryable: false } },
      };
    }
    return tool.execute(request, context);
  }
}

export function registryDispatcher(registry: ToolRegistry): {
  definitions: readonly ToolDefinition[];
  dispatch(request: ToolCallRequest, signal: AbortSignal): Promise<ToolCallResult>;
} {
  return {
    definitions: registry.listDefinitions(),
    dispatch: (request, signal) => registry.dispatch(request, { signal }),
  };
}

function validateDefinition(definition: ToolDefinition): void {
  if (!TOOL_NAME.test(definition.name)) throw new ToolDefinitionError(`工具名称无效：${definition.name}`);
  if (definition.purpose.trim().length === 0 || definition.useWhen.length === 0 || definition.avoidWhen.length === 0) {
    throw new ToolDefinitionError(`工具说明不完整：${definition.name}`);
  }
  if (!['read_shared', 'write_exclusive'].includes(definition.executionMode)) {
    throw new ToolDefinitionError(`工具执行模式无效：${definition.name}`);
  }
  if (Buffer.byteLength(formatToolDescription(definition), 'utf8') > DESCRIPTION_MAX) {
    throw new ToolDefinitionError(`工具说明超过 8 KiB：${definition.name}`);
  }
  for (const schema of [definition.inputSchema, definition.resultSchema]) {
    if (Buffer.byteLength(JSON.stringify(schema), 'utf8') > SCHEMA_MAX) {
      throw new ToolDefinitionError(`工具 Schema 超过 32 KiB：${definition.name}`);
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
