// Original MIT benchmark fixture; the generated README states the contract.
/** Inputs, outputs and failure behavior follow the generated README contract. */
export function BENCH_FN(tags: readonly string[]): string[] {
  const seen = new Set<string>(),
    result: string[] = [];
  for (const tag of tags) {
    const value = tag.trim().toLowerCase();
    if (value && !seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}
