/** Enforce a host deadline even when a callback fails to observe its AbortSignal. */
export async function abortable<T>(signal: AbortSignal, operation: () => T | PromiseLike<T>): Promise<T> {
  signal.throwIfAborted();
  let onAbort: () => void = () => {};

  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
  });

  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        signal.throwIfAborted();

        return operation();
      }),
      aborted,
    ]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
