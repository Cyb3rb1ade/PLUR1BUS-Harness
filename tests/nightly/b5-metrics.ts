export interface B5Usage { turn: number; inputTokens: number; cachedInputTokens: number }
/** Each turn is required to meet B5; weighting cannot hide a cold turn behind larger cached ones. */
export function evaluateB5(rows: readonly B5Usage[]) {
  if (rows.length < 6 || rows.some((r, i) => r.turn !== i + 1 || !Number.isSafeInteger(r.inputTokens) || r.inputTokens <= 0 || !Number.isSafeInteger(r.cachedInputTokens) || r.cachedInputTokens < 0 || r.cachedInputTokens > r.inputTokens)) throw new Error("invalid B5 usage");
  const turns = rows.map(r => ({ ...r, cacheReadShare: r.cachedInputTokens / r.inputTokens }));
  const measured = turns.filter(r => r.turn >= 3);
  return { threshold: 0.90, turns, cacheReadShare: measured.reduce((n, r) => n + r.cachedInputTokens, 0) / measured.reduce((n, r) => n + r.inputTokens, 0), pass: measured.every(r => r.cacheReadShare >= 0.90) };
}
