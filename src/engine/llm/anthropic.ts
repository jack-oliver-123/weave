import Anthropic from '@anthropic-ai/sdk';
import type { ResolvedProfile } from '../../config/index.js';
import type { FinishReason, LlmClient, LlmRequest, LlmStreamEvent, TokenUsage } from '../../shared/types.js';
import { isRecord, mapClientError, ProtocolError, readNumber, readRecord, readString } from './errors.js';
import { DISABLED_THINKING, type DisabledThinking } from './request-extensions.js';
import { StreamCancelledError, StreamGuard } from './stream-guard.js';

interface AnthropicTransportRequest {
  readonly model: string;
  readonly messages: LlmRequest['messages'];
  readonly maxTokens: number;
  readonly thinking: DisabledThinking;
  readonly signal: AbortSignal;
}

type AnthropicTransport = (
  request: AnthropicTransportRequest,
) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;

export interface AnthropicClientOptions {
  readonly timeoutMs?: number;
  readonly transport?: AnthropicTransport;
}

export class AnthropicMessagesClient implements LlmClient {
  readonly profile;
  private readonly timeoutMs: number;
  private readonly transport: AnthropicTransport;

  constructor(profile: ResolvedProfile, options: AnthropicClientOptions = {}) {
    this.profile = { name: profile.name, protocol: profile.protocol, model: profile.model };
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.transport = options.transport ?? createSdkTransport(profile);
  }

  async *stream(request: LlmRequest): AsyncGenerator<LlmStreamEvent> {
    const guard = new StreamGuard(request.signal, this.timeoutMs);
    let started = false;
    let activeBlock: number | undefined;
    let sawMessageDelta = false;
    let finishReason: FinishReason | undefined;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    try {
      const source = await guard.wait(this.transport({
        model: this.profile.model,
        messages: request.messages,
        maxTokens: request.maxTokens,
        thinking: DISABLED_THINKING,
        signal: guard.signal,
      }));
      for await (const event of guard.iterate(source)) {
        const type = readString(event, 'type');
        if (type === 'ping' || (type !== undefined && !isAnthropicStateEvent(type))) {
          continue;
        }
        if (type === 'message_start') {
          if (started) throw new ProtocolError();
          const usage = readRecord(readRecord(event, 'message'), 'usage');
          inputTokens = readNumber(usage, 'input_tokens');
          started = true;
          yield { type: 'stream_start' };
          continue;
        }
        if (!started) throw new ProtocolError();
        if (type === 'content_block_start') {
          if (activeBlock !== undefined || sawMessageDelta) throw new ProtocolError();
          const index = readNumber(event, 'index');
          const block = readRecord(event, 'content_block');
          if (index === undefined || readString(block, 'type') !== 'text') throw new ProtocolError();
          activeBlock = index;
          const initialText = readString(block, 'text');
          if (initialText !== undefined && initialText.length > 0) {
            yield { type: 'text_delta', delta: initialText };
          }
          continue;
        }
        if (type === 'content_block_delta') {
          const index = readNumber(event, 'index');
          const delta = readRecord(event, 'delta');
          if (activeBlock === undefined || index !== activeBlock || readString(delta, 'type') !== 'text_delta') {
            throw new ProtocolError();
          }
          const text = readString(delta, 'text');
          if (text === undefined) throw new ProtocolError();
          if (text.length > 0) yield { type: 'text_delta', delta: text };
          continue;
        }
        if (type === 'content_block_stop') {
          if (activeBlock === undefined || readNumber(event, 'index') !== activeBlock) throw new ProtocolError();
          activeBlock = undefined;
          continue;
        }
        if (type === 'message_delta') {
          if (activeBlock !== undefined) throw new ProtocolError();
          sawMessageDelta = true;
          const delta = readRecord(event, 'delta');
          const reason = readString(delta, 'stop_reason');
          if (reason !== undefined) finishReason = mapAnthropicFinishReason(reason);
          outputTokens = readNumber(readRecord(event, 'usage'), 'output_tokens') ?? outputTokens;
          continue;
        }
        if (type === 'message_stop') {
          if (activeBlock !== undefined || !sawMessageDelta || finishReason === undefined) throw new ProtocolError();
          const usage = buildUsage(inputTokens, outputTokens);
          yield { type: 'stream_complete', finishReason, ...(usage === undefined ? {} : { usage }) };
          return;
        }
        throw new ProtocolError();
      }
      throw new ProtocolError();
    } catch (error) {
      if (error instanceof StreamCancelledError || request.signal.aborted) return;
      yield { type: 'stream_error', error: mapClientError(error) };
    } finally {
      guard.close();
    }
  }
}

function createSdkTransport(profile: ResolvedProfile): AnthropicTransport {
  const client = new Anthropic({ apiKey: profile.apiKey, baseURL: profile.baseUrl, maxRetries: 0 });
  return ({ model, messages, maxTokens, thinking, signal }) => client.messages.stream({
    model,
    max_tokens: maxTokens,
    messages: messages.map((message) => ({ role: message.role, content: message.content })),
    thinking,
  }, { signal });
}

function isAnthropicStateEvent(type: string): boolean {
  return ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'].includes(type);
}

function mapAnthropicFinishReason(reason: string): FinishReason {
  if (reason === 'end_turn' || reason === 'stop_sequence') return 'stop';
  if (reason === 'max_tokens' || reason === 'model_context_window_exceeded') return 'max_tokens';
  if (reason === 'refusal') return 'refusal';
  return 'unknown';
}

function buildUsage(inputTokens?: number, outputTokens?: number): TokenUsage | undefined {
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return { ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }) };
}
