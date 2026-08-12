import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import type { ResolvedProfile } from '../../config/index.js';
import type { FinishReason, LlmClient, LlmRequest, LlmStreamEvent, TokenUsage } from '../../shared/types.js';
import { isRecord, mapClientError, ProtocolError, readNumber, readRecord, readString } from './errors.js';
import { DISABLED_THINKING, type DisabledThinking } from './request-extensions.js';
import { StreamCancelledError, StreamGuard } from './stream-guard.js';
import { appendToolArguments, encodeAnthropicRequest, parseToolArguments } from './tool-codecs.js';

interface AnthropicTransportRequest {
  readonly model: string;
  readonly messages: readonly unknown[];
  readonly maxTokens: number;
  readonly thinking: DisabledThinking;
  readonly tools?: readonly unknown[];
  readonly toolChoice?: unknown;
  readonly systemPrompt?: string;
  readonly signal: AbortSignal;
}

type AnthropicTransport = (
  request: AnthropicTransportRequest,
) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;

export interface AnthropicClientOptions {
  readonly timeoutMs?: number;
  readonly transport?: AnthropicTransport;
  readonly createCallId?: () => string;
}

type ActiveAnthropicBlock =
  | { readonly index: number; readonly type: 'text' }
  | { readonly index: number; readonly type: 'tool_use'; readonly providerCallId: string; readonly name: string; arguments: string };

export class AnthropicMessagesClient implements LlmClient {
  readonly profile;
  private readonly timeoutMs: number;
  private readonly transport: AnthropicTransport;
  private readonly createCallId: () => string;

  constructor(profile: ResolvedProfile, options: AnthropicClientOptions = {}) {
    this.profile = { name: profile.name, protocol: profile.protocol, model: profile.model };
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.transport = options.transport ?? createSdkTransport(profile);
    this.createCallId = options.createCallId ?? randomUUID;
  }

  async *stream(request: LlmRequest): AsyncGenerator<LlmStreamEvent> {
    const guard = new StreamGuard(request.signal, this.timeoutMs);
    let started = false;
    let activeBlock: ActiveAnthropicBlock | undefined;
    const calls: { providerCallId: string; name: string; arguments: string }[] = [];
    const providerCallIds = new Set<string>();
    let sawMessageDelta = false;
    let finishReason: FinishReason | undefined;
    let stoppedForTools = false;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    try {
      const encoded = encodeAnthropicRequest(request.messages, request.tools, request.systemPrompt);
      const source = await guard.wait(this.transport({
        model: this.profile.model,
        messages: encoded.messages,
        maxTokens: request.maxTokens,
        thinking: DISABLED_THINKING,
        ...(encoded.tools === undefined ? {} : { tools: encoded.tools, toolChoice: encoded.toolChoice }),
        ...(encoded.systemPrompt === undefined ? {} : { systemPrompt: encoded.systemPrompt }),
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
          const blockType = readString(block, 'type');
          if (index === undefined) throw new ProtocolError();
          if (blockType === 'text') {
            activeBlock = { index, type: 'text' };
            const initialText = readString(block, 'text');
            if (initialText !== undefined && initialText.length > 0) yield { type: 'text_delta', delta: initialText };
            continue;
          }
          if (blockType !== 'tool_use') throw new ProtocolError();
          const providerCallId = readString(block, 'id');
          const name = readString(block, 'name');
          if (providerCallId === undefined || providerCallId.length === 0 || name === undefined || name.length === 0 || providerCallIds.has(providerCallId)) {
            throw new ProtocolError();
          }
          providerCallIds.add(providerCallId);
          activeBlock = { index, type: 'tool_use', providerCallId, name, arguments: '' };
          continue;
        }
        if (type === 'content_block_delta') {
          const index = readNumber(event, 'index');
          const delta = readRecord(event, 'delta');
          if (activeBlock === undefined || index !== activeBlock.index) throw new ProtocolError();
          if (activeBlock.type === 'text') {
            if (readString(delta, 'type') !== 'text_delta') throw new ProtocolError();
            const text = readString(delta, 'text');
            if (text === undefined) throw new ProtocolError();
            if (text.length > 0) yield { type: 'text_delta', delta: text };
            continue;
          }
          if (readString(delta, 'type') !== 'input_json_delta') throw new ProtocolError();
          const partialJson = readString(delta, 'partial_json');
          if (partialJson === undefined) throw new ProtocolError();
          activeBlock.arguments = appendToolArguments(activeBlock.arguments, partialJson);
          continue;
        }
        if (type === 'content_block_stop') {
          if (activeBlock === undefined || readNumber(event, 'index') !== activeBlock.index) throw new ProtocolError();
          if (activeBlock.type === 'tool_use') calls.push(activeBlock);
          activeBlock = undefined;
          continue;
        }
        if (type === 'message_delta') {
          if (activeBlock !== undefined) throw new ProtocolError();
          sawMessageDelta = true;
          const delta = readRecord(event, 'delta');
          const reason = readString(delta, 'stop_reason');
          if (reason !== undefined) {
            stoppedForTools = reason === 'tool_use';
            finishReason = mapAnthropicFinishReason(reason);
          }
          outputTokens = readNumber(readRecord(event, 'usage'), 'output_tokens') ?? outputTokens;
          continue;
        }
        if (type === 'message_stop') {
          if (activeBlock !== undefined || !sawMessageDelta || finishReason === undefined) throw new ProtocolError();
          const usage = buildUsage(inputTokens, outputTokens);
          if (calls.length > 0 && !stoppedForTools) throw new ProtocolError();
          if (stoppedForTools && calls.length === 0) throw new ProtocolError();
          if (calls.length > 0) yield { type: 'tool_calls', calls: calls.map((call) => ({
            callId: this.createCallId(),
            providerCallId: call.providerCallId,
            name: call.name,
            input: parseToolArguments(call.arguments),
          })) };
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
  return ({ model, messages, maxTokens, thinking, tools, toolChoice, systemPrompt, signal }) => client.messages.stream({
    model,
    max_tokens: maxTokens,
    messages: messages as Anthropic.MessageParam[],
    thinking,
    ...(tools === undefined ? {} : { tools: tools as Anthropic.Tool[], tool_choice: toolChoice as Anthropic.ToolChoiceAuto }),
    ...(systemPrompt === undefined ? {} : { system: systemPrompt }),
  }, { signal });
}

function isAnthropicStateEvent(type: string): boolean {
  return ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'].includes(type);
}

function mapAnthropicFinishReason(reason: string): FinishReason {
  if (reason === 'end_turn' || reason === 'stop_sequence' || reason === 'tool_use') return 'stop';
  if (reason === 'max_tokens' || reason === 'model_context_window_exceeded') return 'max_tokens';
  if (reason === 'refusal') return 'refusal';
  return 'unknown';
}

function buildUsage(inputTokens?: number, outputTokens?: number): TokenUsage | undefined {
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return { ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }) };
}
