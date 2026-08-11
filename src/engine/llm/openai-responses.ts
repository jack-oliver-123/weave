import OpenAI from 'openai';
import type { ResolvedProfile } from '../../config/index.js';
import type { FinishReason, LlmClient, LlmRequest, LlmStreamEvent, TokenUsage } from '../../shared/types.js';
import { isRecord, mapClientError, ProtocolError, providerEventError, readNumber, readRecord, readString } from './errors.js';
import { deepSeekResponsesReasoningExtension, type DisabledReasoning } from './request-extensions.js';
import { StreamCancelledError, StreamGuard } from './stream-guard.js';

interface OpenAIResponsesTransportRequest {
  readonly model: string;
  readonly messages: LlmRequest['messages'];
  readonly maxTokens: number;
  readonly reasoning?: DisabledReasoning;
  readonly signal: AbortSignal;
}
type OpenAIResponsesTransport = (request: OpenAIResponsesTransportRequest) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;
export interface OpenAIResponsesClientOptions { readonly timeoutMs?: number; readonly transport?: OpenAIResponsesTransport }

export class OpenAIResponsesClient implements LlmClient {
  readonly profile;
  private readonly timeoutMs: number;
  private readonly transport: OpenAIResponsesTransport;
  private readonly reasoningExtension: { readonly reasoning?: DisabledReasoning };

  constructor(profile: ResolvedProfile, options: OpenAIResponsesClientOptions = {}) {
    this.profile = { name: profile.name, protocol: profile.protocol, model: profile.model };
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.transport = options.transport ?? createSdkTransport(profile);
    this.reasoningExtension = deepSeekResponsesReasoningExtension(profile.baseUrl);
  }

  async *stream(request: LlmRequest): AsyncGenerator<LlmStreamEvent> {
    const guard = new StreamGuard(request.signal, this.timeoutMs);
    let started = false;
    let refused = false;
    try {
      const source = await guard.wait(this.transport({
        model: this.profile.model,
        messages: request.messages,
        maxTokens: request.maxTokens,
        ...this.reasoningExtension,
        signal: guard.signal,
      }));
      for await (const event of guard.iterate(source)) {
        const type = readString(event, 'type');
        if (type === 'response.created') {
          if (started) throw new ProtocolError();
          started = true;
          yield { type: 'stream_start' };
          continue;
        }
        if (!started) throw new ProtocolError();
        if (type === 'response.output_text.delta') {
          const delta = readString(event, 'delta');
          if (delta === undefined) throw new ProtocolError();
          if (delta.length > 0) yield { type: 'text_delta', delta };
          continue;
        }
        if (type === 'response.refusal.delta') {
          const delta = readString(event, 'delta');
          if (delta === undefined) throw new ProtocolError();
          refused = true;
          if (delta.length > 0) yield { type: 'text_delta', delta };
          continue;
        }
        if (type === 'response.completed') {
          const usage = responseUsage(event);
          yield { type: 'stream_complete', finishReason: refused ? 'refusal' : 'stop', ...(usage === undefined ? {} : { usage }) };
          return;
        }
        if (type === 'response.incomplete') {
          const response = readRecord(event, 'response');
          const details = readRecord(response, 'incomplete_details');
          const reason: FinishReason = readString(details, 'reason') === 'max_output_tokens' ? 'max_tokens' : 'unknown';
          const usage = responseUsage(event);
          yield { type: 'stream_complete', finishReason: reason, ...(usage === undefined ? {} : { usage }) };
          return;
        }
        if (type === 'error') {
          yield { type: 'stream_error', error: providerEventError(readString(event, 'code')) };
          return;
        }
        if (type === 'response.failed') {
          yield { type: 'stream_error', error: providerEventError() };
          return;
        }
        if (type === 'response.output_item.added' || type === 'response.output_item.done') {
          if (readString(readRecord(event, 'item'), 'type') !== 'message') throw new ProtocolError();
          continue;
        }
        if (type === 'response.content_part.added' || type === 'response.content_part.done') {
          const partType = readString(readRecord(event, 'part'), 'type');
          if (partType !== 'output_text' && partType !== 'refusal') throw new ProtocolError();
          continue;
        }
        if (isBenignResponsesEvent(type)) continue;
        if (type !== undefined && isOutputAffectingResponsesEvent(type)) throw new ProtocolError();
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

function createSdkTransport(profile: ResolvedProfile): OpenAIResponsesTransport {
  const client = new OpenAI({ apiKey: profile.apiKey, baseURL: profile.baseUrl, maxRetries: 0 });
  return ({ model, messages, maxTokens, reasoning, signal }) => client.responses.create({
    model,
    input: messages.map((message) => ({ role: message.role, content: message.content })),
    max_output_tokens: maxTokens,
    stream: true,
    store: false,
    ...(reasoning === undefined ? {} : { reasoning }),
  }, { signal });
}

function responseUsage(event: unknown): TokenUsage | undefined {
  const usage = readRecord(readRecord(event, 'response'), 'usage');
  if (usage === undefined) return undefined;
  const inputTokens = readNumber(usage, 'input_tokens');
  const outputTokens = readNumber(usage, 'output_tokens');
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return { ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }) };
}

function isBenignResponsesEvent(type: string | undefined): boolean {
  return type === 'response.in_progress' || type === 'response.output_text.done' || type === 'response.refusal.done';
}

function isOutputAffectingResponsesEvent(type: string): boolean {
  return type.startsWith('response.') && (
    type.includes('output') || type.includes('reasoning') || type.includes('_call') || type.includes('.call')
  );
}
