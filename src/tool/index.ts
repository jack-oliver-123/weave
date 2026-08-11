import type { ToolCallRequest, ToolCallResult } from '../shared/types.js';

export interface ToolLayer {
  execute(request: ToolCallRequest): Promise<ToolCallResult>;
  listTools(): string[];
}

export class ToolLayerStub implements ToolLayer {
  execute(_request: ToolCallRequest): Promise<ToolCallResult> {
    throw new Error('not implemented');
  }

  listTools(): string[] {
    throw new Error('not implemented');
  }
}
