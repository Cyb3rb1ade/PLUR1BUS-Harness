// Compatibility probe helper (G7). Embeds a small fixed synthetic set through the adapter and checks the properties that
// make a vector space usable: count, dimension, normalisation, and that similar texts are closer than unrelated ones.
// The result's `ok`/`error` pair is assignable to core's `ProbeInput.targetProbe`; core is not imported (no cycle).
import { isAdapterError, errorSummary } from "./errors.ts";
import { toFingerprint, identityHash, type EmbeddingFingerprintShape } from "./identity.ts";
import { cosine, norm } from "./vector.ts";
import type { EmbeddingAdapter } from "./types.ts";

/** Synthetic, language-mixed, no real data. Indexes: 0/1 paraphrases, 2 German paraphrase of 0, 3 unrelated, 4 query. */
export const PROBE_TEXTS: readonly string[] = Object.freeze([
  "The cat sat on the mat in the sun.",
  "A cat was sitting on a rug in the sunshine.",
  "Die Katze saß in der Sonne auf der Matte.",
  "Quarterly invoices must be reconciled before the ledger is closed.",
  "Where did the cat sit?",
]);

export interface ProbeCheck {
  name: "count" | "dimensions" | "finite" | "normalisation" | "non-degenerate" | "similarity" | "reference";
  ok: boolean;
  detail: string;
}

export interface ProbeOutcome {
  /** Assignable to core `targetProbe`. */
  ok: boolean;
  error?: string;
  identityId: string;
  fingerprint: EmbeddingFingerprintShape;
  dimensions: number;
  checks: ProbeCheck[];
}

export interface ProbeOptions {
  signal?: AbortSignal;
  /** Vectors from a previous run of the same identity (same PROBE_TEXTS order); each must match within `referenceMinCosine`. */
  reference?: readonly ArrayLike<number>[];
  referenceMinCosine?: number;
  normTolerance?: number;
  /** Required margin between related and unrelated cosine. */
  similarityMargin?: number;
}

export async function probe(adapter: EmbeddingAdapter, opts: ProbeOptions = {}): Promise<ProbeOutcome> {
  const identity = adapter.identity();
  const base = { identityId: identityHash(identity), fingerprint: toFingerprint(identity), dimensions: identity.dimensions };
  const checks: ProbeCheck[] = [];
  const done = (error?: string): ProbeOutcome => {
    const failed = checks.filter((c) => !c.ok);
    const message = error ?? (failed.length > 0 ? failed.map((c) => `${c.name}: ${c.detail}`).join("; ") : undefined);
    return { ok: message === undefined, ...(message !== undefined ? { error: message } : {}), ...base, checks };
  };

  // Documents and the query are embedded separately so asymmetric adapters are exercised the way they are used.
  let docs: Float32Array[];
  let query: Float32Array[];
  try {
    docs = await adapter.embed(PROBE_TEXTS.slice(0, 4), { inputType: "document", ...(opts.signal ? { signal: opts.signal } : {}) });
    query = await adapter.embed(PROBE_TEXTS.slice(4), { inputType: "query", ...(opts.signal ? { signal: opts.signal } : {}) });
  } catch (e) {
    return done(isAdapterError(e) ? `${e.kind}: ${e.message}` : errorSummary(e));
  }
  const vectors = [...docs, ...query];

  const countOk = docs.length === 4 && query.length === 1;
  checks.push({ name: "count", ok: countOk, detail: `${vectors.length} vectors for ${PROBE_TEXTS.length} texts` });
  if (!countOk) return done();

  const dimOk = vectors.every((v) => v.length === identity.dimensions);
  checks.push({ name: "dimensions", ok: dimOk, detail: `expected ${identity.dimensions}, got ${[...new Set(vectors.map((v) => v.length))].join("/")}` });
  const finiteOk = vectors.every((v) => v.every(Number.isFinite));
  checks.push({ name: "finite", ok: finiteOk, detail: finiteOk ? "all components finite" : "non-finite component" });
  if (!dimOk || !finiteOk) return done();

  const tol = opts.normTolerance ?? 1e-3;
  const norms = vectors.map((v) => norm(v));
  const degenerate = norms.some((n) => n < 1e-6);
  checks.push({ name: "non-degenerate", ok: !degenerate, detail: degenerate ? "a zero vector was returned" : "no zero vectors" });
  const normOk = !identity.normalize || norms.every((n) => Math.abs(n - 1) <= tol);
  checks.push({ name: "normalisation", ok: normOk, detail: identity.normalize ? `norms ${Math.min(...norms).toFixed(4)}..${Math.max(...norms).toFixed(4)} (tolerance ${tol})` : "adapter does not normalise; not checked" });
  if (degenerate) return done();

  const margin = opts.similarityMargin ?? 0.02;
  const related = Math.min(cosine(docs[0]!, docs[1]!), cosine(docs[0]!, docs[2]!));
  const unrelated = Math.max(cosine(docs[0]!, docs[3]!), cosine(docs[1]!, docs[3]!));
  const simOk = related >= unrelated + margin;
  checks.push({ name: "similarity", ok: simOk, detail: `related ${related.toFixed(3)} vs unrelated ${unrelated.toFixed(3)} (margin ${margin})` });

  if (opts.reference) {
    const min = opts.referenceMinCosine ?? 0.99;
    const ref = opts.reference;
    const refOk = ref.length === vectors.length && vectors.every((v, i) => ref[i]!.length === v.length && cosine(v, ref[i]!) >= min);
    checks.push({ name: "reference", ok: refOk, detail: `reference vectors ${refOk ? "match" : "differ"} (min cosine ${min})` });
  }
  return done();
}
