// Original MIT benchmark fixture; the generated README states the contract.
/** Inputs, outputs and failure behavior follow the generated README contract. */
export async function BENCH_FN<T, U>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number, signal: AbortSignal) => Promise<U>,
  signal: AbortSignal,
): Promise<U[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("invalid concurrency");
  if (signal.aborted) throw signal.reason;
  let next = 0,
    failed = false;
  let first: unknown;
  const result = new Array<U>(items.length);
  const fail = (reason: unknown) => {
    if (!failed) {
      failed = true;
      first = reason;
    }
  };
  const abort = () => fail(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) abort();
    const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (!failed && next < items.length) {
        const index = next++;
        try {
          result[index] = await worker(items[index]!, index, signal);
        } catch (error) {
          fail(error);
        }
      }
    });
    await Promise.allSettled(lanes);
    if (failed) throw first;
    return result;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
