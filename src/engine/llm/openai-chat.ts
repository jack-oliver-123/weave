import OpenAI from 'openai';
import type { ResolvedProfile } from '../../config/index.js';
import type { FinishReason, LlmClient, LlmRequest, LlmStreamEvent, TokenUsage } from '../../shared/types.js';
import { isRecord, mapClientError, ProtocolError, readNumber, readRecord, readString } from './errors.js';
import { deepSeekThinkingExtension, type DisabledThinking } from './request-extensions.js';
import { StreamCancelledError, StreamGuard } from './stream-guard.js';

interface OpenAIChatTransportRequest {
  readonly model: string;
  readonly messages: LlmRequest['messages'];
  readonly maxTokens: number;
  readonly thinking?: DisabledThinking;
  readonly signal: AbortSignal;
}
type OpenAIChatTransport = (request: OpenAIChatTransportRequest) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;
export interface OpenAIChatClientOptions { readonly timeoutMs?: number; readonly transport?: OpenAIChatTransport }

export class OpenAIChatCompletionsClient implements LlmClient {
  readonly profile;
  private readonly timeoutMs: number;
  private readonly transport: OpenAIChatTransport;
  private readonly thinkingExtension: { readonly thinking?: DisabledThinking };

  constructor(profile: ResolvedProfile, options: OpenAIChatClientOptions = {}) {
    this.profile = { name: profile.name, protocol: profile.protocol, model: profile.model };
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.transport = options.transport ?? createSdkTransport(profile);
    this.thinkingExtension = deepSeekThinkingExtension(profile.baseUrl);
  }

  async *stream(request: LlmRequest): AsyncGenerator<LlmStreamEvent> {
    const guard = new StreamGuard(request.signal, this.timeoutMs);
    let started = false;
    let finishReason: FinishReason | undefined;
    let refused = false;
    let usage: TokenUsage | undefined;
    try {
      const source = await guard.wait(this.transport({
        model: this.profile.model,
        messages: request.messages,
        maxTokens: request.maxTokens,
        ...this.thinkingExtension,
        signal: guard.signal,
      }));
      for await (const chunk of guard.iterate(source)) {
        if (!isRecord(chunk) || !Array.isArray(chunk.choices)) throw new ProtocolError();
        if (!started) {
          started = true;
          yield { type: 'stream_start' };
        }
        const rawUsage = readRecord(chunk, 'usage');
        if (rawUsage !== undefined) {
          usage = {
            ...(readNumber(rawUsage, 'prompt_tokens') === undefined ? {} : { inputTokens: readNumber(rawUsage, 'prompt_tokens') }),
            ...(readNumber(rawUsage, 'completion_tokens') === undefined ? {} : { outputTokens: readNumber(rawUsage, 'completion_tokens') }),
          };
        }
        if (chunk.choices.length === 0) continue;
        if (chunk.choices.length !== 1 || finishReason !== undefined) throw new ProtocolError();
        const choice = chunk.choices[0];
        const delta = readRecord(choice, 'delta');
        if (delta === undefined) throw new ProtocolError();
        if (delta.tool_calls !== undefined || delta.function_call !== undefined) throw new ProtocolError();
        const content = readString(delta, 'content');
        const refusal = readString(delta, 'refusal');
        if (content !== undefined && refusal !== undefined) throw new ProtocolError();
        if (content !== undefined && content.length > 0) yield { type: 'text_delta', delta: content };
        if (refusal !== undefined && refusal.length > 0) {
          refused = true;
          yield { type: 'text_delta', delta: refusal };
        }
        const nativeFinish = readString(choice, 'finish_reason');
        if (nativeFinish !== undefined) finishReason = mapChatFinishReason(nativeFinish);
      }
      if (!started || finishReason === undefined) throw new ProtocolError();
      yield { type: 'stream_complete', finishReason: refused ? 'refusal' : finishReason, ...(usage === undefined ? {} : { usage }) };
    } catch (error) {
      if (error instanceof StreamCancelledError || request.signal.aborted) return;
      yield { type: 'stream_error', error: mapClientError(error) };
    } finally {
      guard.close();
    }
  }
}

function createSdkTransport(profile: ResolvedProfile): OpenAIChatTransport {
  const client = new OpenAI({ apiKey: profile.apiKey, baseURL: profile.baseUrl, maxRetries: 0 });
  return ({ model, messages, maxTokens, thinking, signal }) => client.chat.completions.create({
    model,
    messages: messages.map((message) => ({ role: message.role, content: message.content })),
    max_completion_tokens: maxTokens,
    stream: true,
    stream_options: { include_usage: true },
    ...(thinking === undefined ? {} : { thinking }),
  }, { signal });
}

function mapChatFinishReason(reason: string): FinishReason {
  if (reason === 'stop') return 'stop';
  if (reason === 'length') return 'max_tokens';
  if (reason === 'content_filter') return 'content_filter';
  if (reason === 'tool_calls' || reason === 'function_call') throw new ProtocolError();
  return 'unknown';
}
