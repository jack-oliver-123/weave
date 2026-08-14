import type { LlmRequest, LlmStreamEvent } from '../../../src/shared/types.js';
import { assemblePrompt } from '../../../src/engine/prompt-assembly.js';
import { buildRuntimeState } from '../../../src/engine/prompt-builder.js';

export function request(signal = new AbortController().signal): LlmRequest {
  return {
    prompt: assemblePrompt({
      runtime: buildRuntimeState({ mode: 'react', iterationLimit: 10 }),
      tools: [],
      messages: [
        { role: 'user', content: '第一问' },
        { role: 'assistant', content: '第一答' },
        { role: 'user', content: '第二问' },
      ],
    }),
    maxTokens: 321,
    signal,
  };
}

export async function collect(stream: AsyncIterable<LlmStreamEvent>): Promise<LlmStreamEvent[]> {
  const events: LlmStreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

export function nativeStream(events: readonly unknown[]): AsyncIterable<unknown> {
  return (async function* () {
    yield* events;
  })();
}
