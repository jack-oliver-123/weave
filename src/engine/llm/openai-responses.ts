import OpenAI from 'openai';
import { randomUUID } from 'node:crypto';
import type { ResolvedProfile } from '../../config/index.js';
import type { FinishReason, LlmClient, LlmRequest, LlmStreamEvent, TokenUsage } from '../../shared/types.js';
import { isRecord, mapClientError, ProtocolError, providerEventError, readNumber, readRecord, readString } from './errors.js';
import { deepSeekResponsesReasoningExtension, type DisabledReasoning } from './request-extensions.js';
import { StreamCancelledError, StreamGuard } from './stream-guard.js';
import { appendToolArguments, encodeResponsesRequest, parseToolArguments } from './tool-codecs.js';

interface OpenAIResponsesTransportRequest {
  readonly model: string;
  readonly messages: readonly unknown[];
  readonly maxTokens: number;
  readonly reasoning?: DisabledReasoning;
  readonly tools?: readonly unknown[];
  readonly toolChoice?: unknown;
  readonly instructions?: string;
  readonly signal: AbortSignal;
}
type OpenAIResponsesTransport = (request: OpenAIResponsesTransportRequest) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;
export interface OpenAIResponsesClientOptions {
  readonly timeoutMs?: number;
  readonly transport?: OpenAIResponsesTransport;
  readonly createCallId?: () => string;
}

export class OpenAIResponsesClient implements LlmClient {
  readonly profile;
  private readonly timeoutMs: number;
  private readonly transport: OpenAIResponsesTransport;
  private readonly reasoningExtension: { readonly reasoning?: DisabledReasoning };
  private readonly createCallId: () => string;

  constructor(profile: ResolvedProfile, options: OpenAIResponsesClientOptions = {}) {
    this.profile = { name: profile.name, protocol: profile.protocol, model: profile.model };
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.transport = options.transport ?? createSdkTransport(profile);
    this.reasoningExtension = deepSeekResponsesReasoningExtension(profile.baseUrl);
    this.createCallId = options.createCallId ?? randomUUID;
  }

  async *stream(request: LlmRequest): AsyncGenerator<LlmStreamEvent> {
    const guard = new StreamGuard(request.signal, this.timeoutMs);
    let started = false;
    let refused = false;
    const calls = new Map<string, { readonly providerCallId: string; readonly name: string; arguments: string; done: boolean }>();
    const providerCallIds = new Set<string>();
    try {
      const encoded = encodeResponsesRequest(request.prompt);
      const source = await guard.wait(this.transport({
        model: this.profile.model,
        messages: encoded.messages,
        maxTokens: request.maxTokens,
        ...this.reasoningExtension,
        ...(encoded.tools === undefined ? {} : { tools: encoded.tools, toolChoice: encoded.toolChoice }),
        ...(encoded.instructions === undefined ? {} : { instructions: encoded.instructions }),
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
          const assembled = assembleResponsesCalls(calls, this.createCallId);
          const usage = responseUsage(event);
          if (assembled.length > 0) yield { type: 'tool_calls', calls: assembled };
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
        if (type === 'response.output_item.added') {
          const item = readRecord(event, 'item');
          const itemType = readString(item, 'type');
          if (itemType === 'message') continue;
          if (itemType !== 'function_call') throw new ProtocolError();
          const itemId = readString(item, 'id');
          const providerCallId = readString(item, 'call_id');
          const name = readString(item, 'name');
          if (itemId === undefined || itemId.length === 0 || providerCallId === undefined || providerCallId.length === 0 || name === undefined || name.length === 0 || calls.has(itemId) || providerCallIds.has(providerCallId)) {
            throw new ProtocolError();
          }
          providerCallIds.add(providerCallId);
          calls.set(itemId, { providerCallId, name, arguments: readString(item, 'arguments') ?? '', done: false });
          continue;
        }
        if (type === 'response.function_call_arguments.delta') {
          const itemId = readString(event, 'item_id');
          const delta = readString(event, 'delta');
          const call = itemId === undefined ? undefined : calls.get(itemId);
          if (call === undefined || call.done || delta === undefined) throw new ProtocolError();
          call.arguments = appendToolArguments(call.arguments, delta);
          continue;
        }
        if (type === 'response.function_call_arguments.done') {
          const itemId = readString(event, 'item_id');
          const call = itemId === undefined ? undefined : calls.get(itemId);
          if (call === undefined || call.done) throw new ProtocolError();
          const finalArguments = readString(event, 'arguments');
          if (finalArguments !== undefined) {
            if (call.arguments.length > 0 && finalArguments !== call.arguments) throw new ProtocolError();
            call.arguments = appendToolArguments('', finalArguments);
          }
          call.done = true;
          continue;
        }
        if (type === 'response.output_item.done') {
          const item = readRecord(event, 'item');
          const itemType = readString(item, 'type');
          if (itemType === 'message') continue;
          if (itemType !== 'function_call') throw new ProtocolError();
          const itemId = readString(item, 'id');
          const call = itemId === undefined ? undefined : calls.get(itemId);
          if (call === undefined) throw new ProtocolError();
          if (!call.done) {
            const finalArguments = readString(item, 'arguments');
            if (finalArguments !== undefined) {
              if (call.arguments.length > 0 && finalArguments !== call.arguments) throw new ProtocolError();
              call.arguments = appendToolArguments('', finalArguments);
            }
            call.done = true;
          }
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
  return ({ model, messages, maxTokens, reasoning, tools, toolChoice, instructions, signal }) => client.responses.create({
    model,
    input: messages as OpenAI.Responses.ResponseInput,
    max_output_tokens: maxTokens,
    stream: true,
    store: false,
    ...(tools === undefined ? {} : { tools: tools as OpenAI.Responses.Tool[], tool_choice: toolChoice as 'auto' }),
    ...(instructions === undefined ? {} : { instructions }),
    ...(reasoning === undefined ? {} : { reasoning }),
  }, { signal });
}

function responseUsage(event: unknown): TokenUsage | undefined {
  const usage = readRecord(readRecord(event, 'response'), 'usage');
  if (usage === undefined) return undefined;
  const inputTokens = readNumber(usage, 'input_tokens');
  const outputTokens = readNumber(usage, 'output_tokens');
  const details = readRecord(usage, 'input_tokens_details');
  const cacheReadInputTokens = readNumber(details, 'cached_tokens');
  const cacheWriteInputTokens = readNumber(details, 'cache_write_tokens') ?? readNumber(usage, 'cache_write_tokens');
  if ([inputTokens, outputTokens, cacheReadInputTokens, cacheWriteInputTokens].every((value) => value === undefined)) return undefined;
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens }),
    ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens }),
  };
}

function isBenignResponsesEvent(type: string | undefined): boolean {
  return type === 'response.in_progress' || type === 'response.output_text.done' || type === 'response.refusal.done';
}

function isOutputAffectingResponsesEvent(type: string): boolean {
  return type.startsWith('response.') && (
    type.includes('output') || type.includes('reasoning') || type.includes('_call') || type.includes('.call')
  );
}

function assembleResponsesCalls(
  calls: ReadonlyMap<string, { readonly providerCallId: string; readonly name: string; readonly arguments: string; readonly done: boolean }>,
  createCallId: () => string,
) {
  return [...calls.values()].map((call) => {
    if (!call.done) throw new ProtocolError();
    return { callId: createCallId(), providerCallId: call.providerCallId, name: call.name, input: parseToolArguments(call.arguments) };
  });
}
