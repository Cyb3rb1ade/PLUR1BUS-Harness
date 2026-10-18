// Nearest-rank percentiles; retain every sample, including outliers.
export function distribution(samples, warmups) {
  if (!samples.length || samples.some(x => !Number.isFinite(x) || x < 0)) throw new Error('invalid samples');
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = p => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
  return { samples, n: samples.length, warmups, p50: rank(.5), p95: rank(.95), p99: rank(.99), max: sorted.at(-1), outliersDiscarded: 0 };
}
export function runs(value = '30') {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 30) throw new Error('p95 requires at least 30 measured runs');
  return n;
}
