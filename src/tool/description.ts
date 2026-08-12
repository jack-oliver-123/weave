import type { ToolDefinition } from '../shared/types.js';

export function formatToolDescription(definition: ToolDefinition): string {
  const cooperation = definition.worksWith.length === 0
    ? '无。'
    : definition.worksWith.map((item) => `- ${item.toolName}：${item.usage}`).join('\n');
  return [
    `用途：${definition.purpose}`,
    '适用场景：',
    ...definition.useWhen.map((item) => `- ${item}`),
    '不适用场景：',
    ...definition.avoidWhen.map((item) => `- ${item}`),
    `参数约束：${JSON.stringify(definition.inputSchema)}`,
    `返回格式：统一结果信封包含 isError、summary、data 或 error；成功 data 结构为 ${JSON.stringify(definition.resultSchema)}`,
    `工具配合：${cooperation}`,
  ].join('\n');
}
