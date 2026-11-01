/** B1 paired inference. Concordances and unmatched evidence stay visible; only discordances enter the sign test. */

/** One verdict identified by corpus, model configuration, task and seed; arm selection precedes pairing. */
export interface PairedOutcome {
  key: string;
  resolved: boolean;
}

const MAX_PAIRS = 1_000_000;

/** Exact two-sided sign probability; log-sum avoids overflowing binomial coefficients. */
export function exactPairedSignP(improved: number, regressed: number): number {
  if (![improved, regressed].every((n) => Number.isSafeInteger(n) && n >= 0) || improved + regressed > MAX_PAIRS) {
    throw new RangeError("invalid paired sign counts");
  }
  const n = improved + regressed;
  const m = Math.min(improved, regressed);
  if (n === 0 || m * 2 === n) return 1;
  let term = -n * Math.LN2;
  let sum = term;
  for (let k = 1; k <= m; k++) {
    term += Math.log(n - k + 1) - Math.log(k);
    const high = Math.max(sum, term);
    const low = Math.min(sum, term);
    sum = high + Math.log1p(Math.exp(low - high));
  }
  return Math.min(1, 2 * Math.exp(sum));
}

/** Full contingency counts; a probability never waives the no-regression gate. */
export interface PairComparison {
  bothResolved: number;
  bothUnresolved: number;
  improved: number;
  regressed: number;
  unmatchedBaseline: number;
  unmatchedCandidate: number;
  paired: number;
  deltaResolved: number;
  signP: number;
}

function index(rows: readonly PairedOutcome[]): Map<string, boolean> {
  if (!Array.isArray(rows) || rows.length > MAX_PAIRS) throw new RangeError("invalid paired outcomes");
  const result = new Map<string, boolean>();
  for (const row of rows) {
    if (!row || typeof row.key !== "string" || !row.key || row.key.length > 2048 || typeof row.resolved !== "boolean") {
      throw new RangeError("invalid paired outcome");
    }
    if (result.has(row.key)) throw new RangeError("duplicate pair key");
    result.set(row.key, row.resolved);
  }
  return result;
}

/** Pair by explicit identities; unmatched evidence is never silently counted as a loss or discarded. */
export function comparePairedOutcomes(
  baseline: readonly PairedOutcome[],
  candidate: readonly PairedOutcome[],
): PairComparison {
  const before = index(baseline);
  const after = index(candidate);
  const counts: PairComparison = {
    bothResolved: 0,
    bothUnresolved: 0,
    improved: 0,
    regressed: 0,
    unmatchedBaseline: 0,
    unmatchedCandidate: 0,
    paired: 0,
    deltaResolved: 0,
    signP: 1,
  };
  for (const [key, previous] of before) {
    const current = after.get(key);
    if (current === undefined) {
      counts.unmatchedBaseline++;
      continue;
    }
    counts.paired++;
    if (previous && current) counts.bothResolved++;
    else if (!previous && !current) counts.bothUnresolved++;
    else if (current) counts.improved++;
    else counts.regressed++;
  }
  for (const key of after.keys()) if (!before.has(key)) counts.unmatchedCandidate++;
  counts.deltaResolved = counts.improved - counts.regressed;
  counts.signP = exactPairedSignP(counts.improved, counts.regressed);
  return counts;
}
