/** Selected legacy stores may nominate only a pinned local-model candidate; an actual Engine adoption probe is mandatory.
 * Cache and person-bound licence proof cover both the temporary source model and the eventual target before maintenance.
 */
import { posix, win32 } from "node:path";
import { CATALOG, ENGINE_DEFAULTS, type CatalogEntry } from "./catalog.ts";
import type { Identity, IdentityField } from "./identity.ts";
import { ImportError, isSourceType, type SourceReport } from "./types.ts";

/** Candidate metadata only. It does not establish that source vectors match this model; the Engine probe owns that proof. */
export interface SourceStoreModel {
  model: string;
  dimensions: number;
  storeId: string;
  agentId: string;
}
/** The existing production model port verifies pinned cached artifacts and the current person's licence ledger. */
export type StoreModelStatus = (model: string, licenceId?: string) =>
  Promise<{ present: boolean; licenceAccepted: boolean }>;

const AGENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$(?![\s\S])/;
const SOURCES = new Set(["store-metadata", "config", "cache", "model-cache", "vector-schema", "derived",
  "not-applicable", "unknown", "harness-config", "harness-default", "engine-catalog", "engine-default"]);
const unsupported = (): never => {
  throw new ImportError("E_NOT_AVAILABLE", "source-store-identity-unsupported",
    "Selected source store cannot use the pinned local model route");
};
function embedding(model: unknown): CatalogEntry | undefined {
  if (typeof model !== "string" || !Object.hasOwn(CATALOG, model)) return undefined;
  const profile = CATALOG[model]!;
  return profile.role === "embedding" && Number.isSafeInteger(profile.nativeDimensions)
    && profile.nativeDimensions! > 0 ? profile : undefined;
}
function field(fields: Identity, key: IdentityField): unknown {
  const item = fields?.[key];
  if (!item || typeof item !== "object" || !SOURCES.has(item.source)
    || !Object.hasOwn(item, "value") || item.value === undefined) return unsupported();
  if (item.source === "unknown") {
    if (item.value !== null) return unsupported();
    return undefined;
  }
  return item.value;
}
function same(actual: unknown, expected: unknown): boolean {
  if (!expected || typeof expected !== "object") return actual === expected;
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  const values = actual as Record<string, unknown>;
  return Object.keys(values).length === Object.keys(expected).length
    && Object.entries(expected).every(([key, value]) => Object.hasOwn(values, key) && values[key] === value);
}

/** Reject unsupported selections and known fingerprint conflicts without reading files or copying source paths into output.
 * Missing legacy fingerprint metadata remains a candidate only; callers must obtain an actual read-only Engine probe verdict.
 */
export function sourceStoreModel(report: Pick<SourceReport, "sourceType" | "plur1bus">,
  storeId: string): SourceStoreModel {
  if (!isSourceType(report?.sourceType) || !Array.isArray(report?.plur1bus?.stores)) return unsupported();
  const matches = report.plur1bus.stores.filter(store => store?.storeId === storeId);
  if (matches.length !== 1) return unsupported();
  const store = matches[0]!;
  const root = report.plur1bus.storeRoot;
  if (store.kind !== "agent" || typeof store.agentId !== "string" || !AGENT.test(store.agentId)
    || store.storeId !== `agent:${store.agentId}` || store.namespace !== null || !root || root.present !== true
    || root.layout !== "legacy-flat" || root.namespace !== null || root.activeGeneration !== null
    || typeof root.baseDbPath !== "string" || typeof root.activeRoot !== "string" || typeof store.path !== "string") {
    return unsupported();
  }
  const paths = /^[A-Za-z]:[\\/]|^\\\\/.test(root.baseDbPath) ? win32 : posix;
  const base = paths.normalize(root.baseDbPath);
  if (!paths.isAbsolute(base) || paths.normalize(root.activeRoot) !== base
    || paths.normalize(store.path) !== paths.join(base, store.agentId)) return unsupported();
  const identity = store.identity;
  if (!identity || !Number.isSafeInteger(identity.distinctIdentities) || identity.distinctIdentities < 0
    || identity.distinctIdentities > 1 || !Array.isArray(identity.reasons)
    || identity.reasons.some(reason => ["multiple-identities", "dimension-conflict", "cache-model-differs"].includes(reason))) {
    return unsupported();
  }
  const fields = identity.fields;
  const model = field(fields, "model");
  const profile = embedding(model);
  if (!profile || typeof model !== "string" || field(fields, "provider") !== "local-transformers"
    || fields.dimension?.source !== "vector-schema" || field(fields, "dimension") !== profile.nativeDimensions) {
    return unsupported();
  }
  const expected: Partial<Record<IdentityField, unknown>> = {
    revision: profile.revision, quantization: profile.quantization, artefactHash: profile.artefactDigest,
    prefixSchema: { query: profile.queryPrefix ?? "", passage: profile.passagePrefix ?? "" },
    normalization: { pooling: "mean", normalize: true }, tokenCap: ENGINE_DEFAULTS.localTokenCap, endpoint: null,
  };
  for (const [key, value] of Object.entries(expected)) {
    const actual = field(fields, key as IdentityField);
    if (actual !== undefined && !same(actual, value)) return unsupported();
  }
  return { model, dimensions: profile.nativeDimensions!, storeId, agentId: store.agentId };
}

/** Require cached pinned source and target models, including each current-person licence, before Core can stop.
 * A backend failure produces fixed metadata only; equal models share one check with the stricter explicit target licence.
 */
export async function assertStoreModelsAvailable(source: SourceStoreModel,
  target: { model: string; licenceId?: string }, status: StoreModelStatus): Promise<void> {
  const unavailable = () => new ImportError("E_NOT_AVAILABLE", "embedding-model-unavailable",
    "Source and target embedding models must be installed before maintenance");
  const profile = embedding(source?.model);
  if (!profile || profile.nativeDimensions !== source.dimensions || !embedding(target?.model)) throw unavailable();
  const requests: [string, string | undefined][] = source.model === target.model
    ? [[target.model, target.licenceId]] : [[source.model, undefined], [target.model, target.licenceId]];
  const proofs = await Promise.allSettled(requests.map(async ([model, licence]) => status(model, licence)));
  if (proofs.some(proof => proof.status === "rejected" || proof.value?.present !== true)) throw unavailable();
  if (proofs.some(proof => proof.status === "fulfilled" && proof.value.licenceAccepted !== true)) {
    throw new ImportError("E_DENIED", "model-licence-required",
      "Source and target embedding models require the current person's licence confirmation");
  }
}
