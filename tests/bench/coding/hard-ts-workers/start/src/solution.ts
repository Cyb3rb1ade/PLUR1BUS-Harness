// Original MIT benchmark fixture; the generated README states the contract.
/** Inputs, outputs and failure behavior follow the generated README contract. */
export async function BENCH_FN<T, U>(
  items: readonly T[],
  _limit: number,
  worker: (item: T, index: number, signal: AbortSignal) => Promise<U>,
  signal: AbortSignal,
): Promise<U[]> {
  return Promise.all(items.map((item, index) => worker(item, index, signal)));
}
