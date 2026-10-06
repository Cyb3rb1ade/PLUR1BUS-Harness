// The embedding compatibility probe (M2 acceptance 6): a store's embedding identity against the configured target.
// Pure: the identity comparison is the engine's own (lib/reembedding/fingerprint.js), so the Harness and the engine
// can never disagree about what "the same vector space" means. Missing evidence is never `compatible` (R2).
import { embeddingFingerprintId } from "@cyb3rb1ade/plur1bus-memory/lib/reembedding/fingerprint.js";

/** An embedding fingerprint as the engine records it (credential metadata is accepted and ignored by the engine's id). */
export interface EmbeddingFingerprint {
  provider: string; model: string; dimensions: number; revision?: string; endpoint?: string;
  queryPrefix?: string; passagePrefix?: string; pooling?: string; normalize?: boolean; dtype?: string;
  artifacts?: { path: string; sha256: string }[];
}

export type Verdict = "compatible" | "migration-needed" | "incompatible";
export type ProbeReason =
  | "stored-identity-missing" | "stored-identity-invalid" | "target-identity-invalid" | "target-revision-unpinned" | "target-provider-unusable"
  | "provider-changed" | "model-changed" | "revision-changed" | "dimension-changed" | "endpoint-changed" | "query-prefix-changed"
  | "passage-prefix-changed" | "pooling-changed" | "normalisation-changed" | "dtype-changed" | "artifacts-changed";

export interface ProbeInput {
  /** The store's own identity; null when the store carries none (unreadable, unverifiable). */
  stored: EmbeddingFingerprint | null;
  target: EmbeddingFingerprint;
  /** The target provider's own readiness probe (engine EmbeddingService.probe), when one was run. */
  targetProbe?: { ok: boolean; error?: string };
}
export interface ProbeResult {
  verdict: Verdict;
  /** Stable codes: why the verdict is not `compatible` (empty when it is). */
  reasons: ProbeReason[];
  /** The fingerprint fields that differ, in the order below (empty unless `migration-needed`). */
  changed: string[];
  storedId: string | null; targetId: string | null;
  /** One English sentence for the CLI; never contains a credential or a store path. */
  message: string;
}

const FIELDS: { field: keyof EmbeddingFingerprint; reason: ProbeReason }[] = [
  { field: "provider", reason: "provider-changed" }, { field: "model", reason: "model-changed" }, { field: "revision", reason: "revision-changed" },
  { field: "dimensions", reason: "dimension-changed" }, { field: "endpoint", reason: "endpoint-changed" }, { field: "queryPrefix", reason: "query-prefix-changed" },
  { field: "passagePrefix", reason: "passage-prefix-changed" }, { field: "pooling", reason: "pooling-changed" }, { field: "normalize", reason: "normalisation-changed" },
  { field: "dtype", reason: "dtype-changed" }, { field: "artifacts", reason: "artifacts-changed" },
];

const idOf = (fp: EmbeddingFingerprint): { id: string } | { error: string } => {
  try { return { id: embeddingFingerprintId(fp as unknown as Record<string, unknown>) }; } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
};
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const result = (verdict: Verdict, reasons: ProbeReason[], message: string, o: Partial<ProbeResult> = {}): ProbeResult =>
  ({ verdict, reasons, changed: [], storedId: null, targetId: null, message, ...o });

export function probeCompatibility(i: ProbeInput): ProbeResult {
  if (i.stored === null) return result("incompatible", ["stored-identity-missing"], "the store carries no readable embedding identity, so its vectors cannot be vouched for");
  const stored = idOf(i.stored);
  if ("error" in stored) return result("incompatible", ["stored-identity-invalid"], "the store's embedding identity is not a valid fingerprint");
  const target = idOf(i.target);
  if ("error" in target) {
    const moving = /immutable revision/.test(target.error);
    return result("incompatible", [moving ? "target-revision-unpinned" : "target-identity-invalid"],
      moving ? "the target model's revision is not pinned to an immutable value (a moving tag such as main or latest)" : "the target embedding identity is not a valid fingerprint (provider, model and dimensions are required)",
      { storedId: stored.id });
  }
  const ids = { storedId: stored.id, targetId: target.id };
  if (i.targetProbe && !i.targetProbe.ok) {
    return result("incompatible", ["target-provider-unusable"], `the target embedding provider did not answer its readiness probe (${i.targetProbe.error ?? "failed"})`, ids);
  }
  if (stored.id === target.id) return result("compatible", [], "the store's embedding identity matches the configured provider", ids);
  const diff = FIELDS.filter((f) => !same(i.stored![f.field], i.target[f.field]));
  const changed: string[] = diff.map((f) => f.field);
  return result("migration-needed", diff.map((f) => f.reason),
    `the store was embedded with a different identity (${changed.join(", ")}); its vectors must be re-embedded before this provider can be used`, { ...ids, changed });
}
