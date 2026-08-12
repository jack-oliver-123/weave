import type { ValidateFunction } from 'ajv';
import type { ToolCallRequest, ToolCallResult, ToolDefinition } from '../shared/types.js';
import { safeToolError, ToolError, truncate } from './errors.js';

export interface ToolExecutionContext {
  readonly signal: AbortSignal;
}

export abstract class BaseTool<TInput, TData> {
  private inputValidator: ValidateFunction<TInput> | undefined;
  private resultValidator: ValidateFunction<TData> | undefined;

  protected constructor(readonly definition: ToolDefinition) {}

  bindValidators(input: ValidateFunction<TInput>, result: ValidateFunction<TData>): void {
    if (this.inputValidator !== undefined) throw new TypeError('tool validators already bound');
    this.inputValidator = input;
    this.resultValidator = result;
  }

  async execute(request: ToolCallRequest, context: ToolExecutionContext): Promise<ToolCallResult> {
    try {
      if (context.signal.aborted) throw new ToolError('TOOL_CANCELLED', '工具调用已取消。', false);
      if (this.inputValidator === undefined || this.resultValidator === undefined) {
        throw new Error('tool validators are not bound');
      }
      if (!this.inputValidator(request.input)) {
        throw new ToolError('INVALID_ARGUMENT', '工具参数不符合约束。', false, {
          errors: this.inputValidator.errors?.map((item) => ({ instancePath: item.instancePath, keyword: item.keyword })),
        });
      }
      const data = await this.run(request.input, context);
      if (!this.resultValidator(data)) throw new Error('tool result does not match schema');
      return envelope(request, false, { summary: truncate(this.successSummary(data), 1024), data });
    } catch (error) {
      const safe = safeToolError(error);
      return envelope(request, true, { summary: truncate(safe.message, 1024), error: safe });
    }
  }

  protected abstract run(input: TInput, context: ToolExecutionContext): Promise<TData>;
  protected abstract successSummary(data: TData): string;
}

function envelope(
  request: ToolCallRequest,
  isError: boolean,
  content: ToolCallResult['content'],
): ToolCallResult {
  return {
    callId: request.callId,
    providerCallId: request.providerCallId,
    toolName: request.name,
    isError,
    content,
  };
}
