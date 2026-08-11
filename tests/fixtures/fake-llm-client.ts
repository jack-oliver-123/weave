import type {
  LlmClient,
  LlmRequest,
  LlmStreamEvent,
  ProfileSummary,
  SafeError,
} from '../../src/shared/types.js';

export interface FakeStreamStep {
  readonly event?: LlmStreamEvent;
  readonly delayMs?: number;
  readonly error?: SafeError;
}

export class FakeLlmClient implements LlmClient {
  readonly requests: LlmRequest[] = [];

  constructor(
    readonly profile: ProfileSummary,
    private readonly scripts: readonly (readonly FakeStreamStep[])[],
  ) {}

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
    this.requests.push(request);
    const script = this.scripts[this.requests.length - 1] ?? [];

    for (const step of script) {
      if (step.delayMs !== undefined) {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(resolve, step.delayMs);
          request.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timeout);
              reject(request.signal.reason);
            },
            { once: true },
          );
        });
      }
      if (request.signal.aborted) {
        return;
      }
      if (step.error !== undefined) {
        yield { type: 'stream_error', error: step.error };
        return;
      }
      if (step.event !== undefined) {
        yield step.event;
      }
    }
  }
}

export const fakeProfile: ProfileSummary = {
  name: 'fake',
  protocol: 'anthropic-messages',
  model: 'fake-model',
};
