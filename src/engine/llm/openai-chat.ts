import OpenAI from 'openai';
import { randomUUID } from 'node:crypto';
import type { ResolvedProfile } from '../../config/index.js';
import type { ChatSystemMode } from '../../config/index.js';
import type { ProviderCredentialBroker } from '../../security/index.js';
import type { FinishReason, LlmClient, LlmRequest, LlmStreamEvent, TokenUsage } from '../../shared/types.js';
import { isRecord, mapClientError, ProtocolError, readNumber, readRecord, readString } from './errors.js';
import { deepSeekThinkingExtension, type DisabledThinking } from './request-extensions.js';
import { StreamCancelledError, StreamGuard } from './stream-guard.js';
import { appendToolArguments, encodeChatRequest, parseToolArguments } from './tool-codecs.js';
import { guardEncodedProviderRequest } from './final-input-guard.js';

interface OpenAIChatTransportRequest {
  readonly model: string;
  readonly messages: readonly unknown[];
  readonly maxTokens: number;
  readonly thinking?: DisabledThinking;
  readonly tools?: readonly unknown[];
  readonly toolChoice?: unknown;
  readonly signal: AbortSignal;
}
type OpenAIChatTransport = (request: OpenAIChatTransportRequest) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;
export interface OpenAIChatClientOptions {
  readonly timeoutMs?: number;
  readonly transport?: OpenAIChatTransport;
  readonly createCallId?: () => string;
  readonly credentialBroker?: ProviderCredentialBroker;
}

export class OpenAIChatCompletionsClient implements LlmClient {
  readonly profile;
  private readonly timeoutMs: number;
  private readonly transport: OpenAIChatTransport;
  private readonly thinkingExtension: { readonly thinking?: DisabledThinking };
  private readonly createCallId: () => string;
  private readonly systemMode: ChatSystemMode;
  private readonly resolvedProfile: ResolvedProfile;

  constructor(profile: ResolvedProfile, options: OpenAIChatClientOptions = {}) {
    this.profile = { name: profile.name, protocol: profile.protocol, model: profile.model };
    this.resolvedProfile = profile;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.transport = options.transport ?? createSdkTransport(profile, options.credentialBroker);
    this.thinkingExtension = deepSeekThinkingExtension(profile.baseUrl);
    this.createCallId = options.createCallId ?? randomUUID;
    this.systemMode = profile.chatSystemMode ?? 'multiple';
  }

  async *stream(request: LlmRequest): AsyncGenerator<LlmStreamEvent> {
    const guard = new StreamGuard(request.signal, this.timeoutMs);
    let started = false;
    let finishReason: FinishReason | undefined;
    let refused = false;
    let usage: TokenUsage | undefined;
    let stoppedForTools = false;
    const calls = new Map<number, { providerCallId?: string; name?: string; arguments: string }>();
    try {
      const encoded = encodeChatRequest(request.prompt, this.systemMode);
      const transportRequest = {
        model: this.profile.model,
        messages: encoded.messages,
        maxTokens: request.maxTokens,
        ...this.thinkingExtension,
        ...(encoded.tools === undefined ? {} : { tools: encoded.tools, toolChoice: encoded.toolChoice }),
        signal: guard.signal,
      };
      guardEncodedProviderRequest(this.resolvedProfile, { ...transportRequest, signal: undefined }, request);
      const source = await guard.wait(this.transport(transportRequest));
      for await (const chunk of guard.iterate(source)) {
        if (!isRecord(chunk) || !Array.isArray(chunk.choices)) throw new ProtocolError();
        if (!started) {
          started = true;
          yield { type: 'stream_start' };
        }
        const rawUsage = readRecord(chunk, 'usage');
        if (rawUsage !== undefined) {
          const details = readRecord(rawUsage, 'prompt_tokens_details');
          const cacheReadInputTokens = readNumber(details, 'cached_tokens');
          const cacheWriteInputTokens = readNumber(details, 'cache_write_tokens') ?? readNumber(rawUsage, 'cache_write_tokens');
          usage = {
            ...(readNumber(rawUsage, 'prompt_tokens') === undefined ? {} : { inputTokens: readNumber(rawUsage, 'prompt_tokens') }),
            ...(readNumber(rawUsage, 'completion_tokens') === undefined ? {} : { outputTokens: readNumber(rawUsage, 'completion_tokens') }),
            ...(cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens }),
            ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens }),
          };
        }
        if (chunk.choices.length === 0) continue;
        if (chunk.choices.length !== 1 || finishReason !== undefined) throw new ProtocolError();
        const choice = chunk.choices[0];
        const delta = readRecord(choice, 'delta');
        if (delta === undefined) throw new ProtocolError();
        if (delta.function_call !== undefined) throw new ProtocolError();
        if (delta.tool_calls !== undefined) appendChatToolCalls(delta.tool_calls, calls);
        const content = readString(delta, 'content');
        const refusal = readString(delta, 'refusal');
        if (content !== undefined && refusal !== undefined) throw new ProtocolError();
        if (content !== undefined && content.length > 0) yield { type: 'text_delta', delta: content };
        if (refusal !== undefined && refusal.length > 0) {
          refused = true;
          yield { type: 'text_delta', delta: refusal };
        }
        const nativeFinish = readString(choice, 'finish_reason');
        if (nativeFinish !== undefined) {
          stoppedForTools = nativeFinish === 'tool_calls';
          finishReason = mapChatFinishReason(nativeFinish);
        }
      }
      if (!started || finishReason === undefined) throw new ProtocolError();
      const assembled = [...calls.entries()].sort(([left], [right]) => left - right).map(([, call]) => {
        if (call.providerCallId === undefined || call.providerCallId.length === 0 || call.name === undefined || call.name.length === 0) {
          throw new ProtocolError();
        }
        return { callId: this.createCallId(), providerCallId: call.providerCallId, name: call.name, input: parseToolArguments(call.arguments) };
      });
      if (assembled.length > 0 && !stoppedForTools) throw new ProtocolError();
      if (stoppedForTools && assembled.length === 0) throw new ProtocolError();
      if (assembled.length > 0) yield { type: 'tool_calls', calls: assembled };
      yield { type: 'stream_complete', finishReason: refused ? 'refusal' : finishReason, ...(usage === undefined ? {} : { usage }) };
    } catch (error) {
      if (error instanceof StreamCancelledError || request.signal.aborted) return;
      yield { type: 'stream_error', error: mapClientError(error) };
    } finally {
      guard.close();
    }
  }
}

function createSdkTransport(profile: ResolvedProfile, broker?: ProviderCredentialBroker): OpenAIChatTransport {
  const client = new OpenAI({
    apiKey: profile.apiKey ?? 'credential-managed', baseURL: profile.baseUrl, maxRetries: 0,
    ...(broker === undefined || profile.credentialRef === undefined ? {} : {
      fetch: ((input: string | URL | Request, init?: RequestInit) => broker.fetch(
        profile.credentialRef!, new URL(profile.baseUrl).origin, 'bearer', input, init,
      )) as typeof fetch,
    }),
  });
  return ({ model, messages, maxTokens, thinking, tools, toolChoice, signal }) => client.chat.completions.create({
    model,
    messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    max_completion_tokens: maxTokens,
    stream: true,
    stream_options: { include_usage: true },
    ...(tools === undefined ? {} : { tools: tools as OpenAI.Chat.Completions.ChatCompletionTool[], tool_choice: toolChoice as 'auto' }),
    ...(thinking === undefined ? {} : { thinking }),
  }, { signal });
}

function mapChatFinishReason(reason: string): FinishReason {
  if (reason === 'stop') return 'stop';
  if (reason === 'length') return 'max_tokens';
  if (reason === 'content_filter') return 'content_filter';
  if (reason === 'tool_calls') return 'stop';
  if (reason === 'function_call') throw new ProtocolError();
  return 'unknown';
}

function appendChatToolCalls(value: unknown, calls: Map<number, { providerCallId?: string; name?: string; arguments: string }>): void {
  if (!Array.isArray(value)) throw new ProtocolError();
  for (const item of value) {
    if (!isRecord(item)) throw new ProtocolError();
    const index = readNumber(item, 'index');
    if (index === undefined || !Number.isInteger(index) || index < 0) throw new ProtocolError();
    const current = calls.get(index) ?? { arguments: '' };
    const providerCallId = readString(item, 'id');
    if (providerCallId !== undefined) {
      if (current.providerCallId !== undefined && current.providerCallId !== providerCallId) throw new ProtocolError();
      for (const [otherIndex, other] of calls) {
        if (otherIndex !== index && other.providerCallId === providerCallId) throw new ProtocolError();
      }
      current.providerCallId = providerCallId;
    }
    const fn = readRecord(item, 'function');
    if (fn !== undefined) {
      const name = readString(fn, 'name');
      if (name !== undefined) {
        if (current.name !== undefined && current.name !== name) throw new ProtocolError();
        current.name = name;
      }
      const argumentDelta = readString(fn, 'arguments');
      if (argumentDelta !== undefined) current.arguments = appendToolArguments(current.arguments, argumentDelta);
    }
    calls.set(index, current);
  }
}
