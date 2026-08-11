export class StreamTimeoutError extends Error {
  constructor() {
    super('stream timeout');
    this.name = 'StreamTimeoutError';
  }
}

export class StreamCancelledError extends Error {
  constructor() {
    super('stream cancelled');
    this.name = 'StreamCancelledError';
  }
}

export class StreamGuard {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();

  constructor(
    private readonly externalSignal: AbortSignal,
    private readonly timeoutMs: number,
  ) {
    this.signal = AbortSignal.any([externalSignal, this.controller.signal]);
  }

  async *iterate(source: AsyncIterable<unknown>): AsyncGenerator<unknown> {
    const iterator = source[Symbol.asyncIterator]();
    try {
      while (true) {
        const result = await this.next(iterator);
        if (result.done === true) {
          return;
        }
        yield result.value;
      }
    } finally {
      await iterator.return?.();
    }
  }

  wait<T>(operation: PromiseLike<T> | T): Promise<T> {
    return this.race(Promise.resolve(operation));
  }

  close(): void {
    this.controller.abort();
  }

  private async next(iterator: AsyncIterator<unknown>): Promise<IteratorResult<unknown>> {
    return this.race(iterator.next());
  }

  private async race<T>(operation: Promise<T>): Promise<T> {
    if (this.externalSignal.aborted) {
      throw new StreamCancelledError();
    }

    let timeout: ReturnType<typeof setTimeout> | undefined;
    let removeAbortListener: (() => void) | undefined;
    const timeoutResult = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        this.controller.abort();
        reject(new StreamTimeoutError());
      }, this.timeoutMs);
    });
    const cancellation = new Promise<never>((_resolve, reject) => {
      const onAbort = () => reject(new StreamCancelledError());
      this.externalSignal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => this.externalSignal.removeEventListener('abort', onAbort);
    });

    try {
      return await Promise.race([operation, timeoutResult, cancellation]);
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      removeAbortListener?.();
    }
  }
}
