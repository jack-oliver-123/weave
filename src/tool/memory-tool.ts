import type { ToolDefinition } from '../shared/types.js';

export const REMEMBER_TOOL: ToolDefinition = Object.freeze({
  name: 'remember',
  purpose: 'Persist an explicitly authorized memory',
  useWhen: ['retain a durable project or user fact'],
  avoidWhen: ['content contains credentials or transient task state'],
  inputSchema: {
    type: 'object',
    required: ['content', 'purpose'],
    properties: {
      content: { type: 'string' },
      purpose: { type: 'string' },
      scope: { enum: ['project', 'user'] },
    },
  },
  resultSchema: { type: 'object' },
  worksWith: [],
  executionMode: 'write_exclusive',
});
