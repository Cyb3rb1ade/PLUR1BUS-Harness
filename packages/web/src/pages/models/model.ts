// Pure logic of the Models page, no DOM and no i18n: tolerant parsing of the models.* answers (a value the UI does not know
// becomes "unknown", never a crash or a guess), secret masking, scan totals, filters, grouping and the route of one model.
import type {
  CatalogModelStatus, ModelCapability, ModelEntry as WireEntry, ModelKind, ModelOverrides, ModelProviderState, ModelScanOutcomeCode, ModelScanProviderResult,
  ModelScanResultCode, ModelScanWarning, ModelSource,
} from "./rpc-types.ts";

export const KINDS: readonly ModelKind[] = ["chat", "embedding", "tts", "asr", "image", "moderation", "rerank", "realtime", "unknown"];
export const CAPABILITIES: readonly ModelCapability[] = ["tools", "vision", "reasoning", "audio_in", "audio_out", "structured_output", "prompt_caching"];
const STATUSES: readonly CatalogModelStatus[] = ["available", "unavailable", "manual"];
const SOURCES: readonly ModelSource[] = ["scan", "table", "manual"];
const RESULTS: readonly ModelScanResultCode[] = ["ok", "failed:auth", "failed:network", "failed:server", "failed:invalid", "failed:empty"];
const OUTCOMES: readonly ModelScanOutcomeCode[] = [...RESULTS, "already_running", "disabled", "no-scanner"];
const WARNING_CODES = ["role_unavailable", "shadowed_by_manual", "empty_list"] as const;

/** A catalog entry as the page uses it: the documented fields plus `extra`, any further scalar fields (already masked). */
export type ModelEntry = Omit<WireEntry, "source" | "status"> & { source: ModelSource | "unknown"; status: CatalogModelStatus; extra: Record<string, string | number | boolean> };
export type ListData = { models: ModelEntry[]; providers: ModelProviderState[]; newCount: number; warnings: ModelScanWarning[] };

const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const oneOf = <T extends string>(list: readonly T[], v: unknown): T | undefined => (typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : undefined);
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

const MASK = "••••";
/** A field name that ends in key, token, secret or credential(s) (case and separators ignored) holds a secret. */
export function isSecretKey(name: string): boolean {
  return /(key|token|secret|credentials?)$/.test(name.toLowerCase().replace(/[^a-z0-9]/g, ""));
}
/** Deep copy with every secret-named value replaced; used for anything shown that the page does not know by name. */
export function maskSecrets(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(maskSecrets);
  if (typeof v === "object" && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, isSecretKey(k) ? MASK : maskSecrets(x)]));
  return v;
}

const KNOWN = new Set(["provider", "id", "displayName", "kind", "contextWindow", "capabilities", "aliases", "status", "firstSeen", "lastSeen", "source", "overrides"]);

function overrides(v: unknown): ModelOverrides {
  const o = rec(v);
  const out: ModelOverrides = {};
  const name = str(o.displayName); if (name) out.displayName = name;
  const kind = oneOf(KINDS, o.kind); if (kind) out.kind = kind;
  if (typeof o.contextWindow === "number" && Number.isInteger(o.contextWindow) && o.contextWindow >= 1) out.contextWindow = o.contextWindow;
  if (Array.isArray(o.capabilities)) out.capabilities = o.capabilities.filter((c): c is ModelCapability => oneOf(CAPABILITIES, c) !== undefined);
  if (Array.isArray(o.aliases)) out.aliases = strings(o.aliases);
  return out;
}

export function normalizeModel(raw: unknown): ModelEntry | null {
  const o = rec(raw);
  const provider = str(o.provider), id = str(o.id);
  if (!provider || !id) return null;
  const extra: ModelEntry["extra"] = {};
  for (const [k, v] of Object.entries(o)) {
    if (KNOWN.has(k) || (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean")) continue;
    extra[k] = isSecretKey(k) ? MASK : v;
  }
  const cw = o.contextWindow;
  return {
    provider, id, displayName: str(o.displayName) ?? id, kind: oneOf(KINDS, o.kind) ?? "unknown",
    ...(typeof cw === "number" && Number.isInteger(cw) && cw >= 1 ? { contextWindow: cw } : {}),
    capabilities: Array.isArray(o.capabilities) ? o.capabilities.filter((c): c is ModelCapability => oneOf(CAPABILITIES, c) !== undefined) : [],
    aliases: strings(o.aliases),
    // A status the UI does not know must not read as usable: it counts as unavailable.
    status: oneOf(STATUSES, o.status) ?? "unavailable",
    firstSeen: str(o.firstSeen) ?? "", lastSeen: str(o.lastSeen) ?? "",
    source: oneOf(SOURCES, o.source) ?? "unknown", overrides: overrides(o.overrides), extra,
  };
}

function warnings(v: unknown): ModelScanWarning[] {
  if (!Array.isArray(v)) return [];
  const out: ModelScanWarning[] = [];
  for (const w of v) {
    const o = rec(w);
    const code = oneOf(WARNING_CODES, o.code);
    if (!code) continue;
    const role = str(o.role), provider = str(o.provider), id = str(o.id);
    out.push({ code, ...(role ? { role } : {}), ...(provider ? { provider } : {}), ...(id ? { id } : {}) });
  }
  return out;
}

export function normalizeList(raw: unknown): ListData {
  const o = rec(raw);
  const models = (Array.isArray(o.models) ? o.models : []).map(normalizeModel).filter((m): m is ModelEntry => m !== null);
  const providers: ModelProviderState[] = [];
  for (const p of Array.isArray(o.providers) ? o.providers : []) {
    const r = rec(p);
    const provider = str(r.provider);
    if (!provider) continue;
    const lastScanAt = str(r.lastScanAt), nextScanAt = str(r.nextScanAt), lastResult = oneOf(RESULTS, r.lastResult);
    providers.push({ provider, ...(lastScanAt ? { lastScanAt } : {}), ...(nextScanAt ? { nextScanAt } : {}), ...(lastResult ? { lastResult } : {}), ...(typeof r.consecutiveFailures === "number" ? { consecutiveFailures: count(r.consecutiveFailures) } : {}) });
  }
  return { models, providers, newCount: count(o.newCount), warnings: warnings(o.warnings) };
}

export const modelKey = (m: { provider: string; id: string }): string => `${m.provider}\u0000${m.id}`;

/** The set of new models, from `models.list { newOnly: true }` (the entries themselves carry no "new" flag in docs/rpc.md). */
export function newKeys(raw: unknown): Set<string> { return new Set(normalizeList(raw).models.map(modelKey)); }

export type ScanTotals = { added: number; gone: number; reappeared: number; failed: { provider: string; result: ModelScanOutcomeCode }[]; running: string[]; skipped: { provider: string; result: ModelScanOutcomeCode }[] };

/** "N new, M no longer available" over all providers; failures (failed:*), scans already running and skipped providers apart. */
export function scanTotals(raw: unknown): ScanTotals {
  const t: ScanTotals = { added: 0, gone: 0, reappeared: 0, failed: [], running: [], skipped: [] };
  const list = rec(raw).providers;
  for (const p of Array.isArray(list) ? list : []) {
    const r = rec(p) as Partial<ModelScanProviderResult>;
    const provider = str(r.provider) ?? "?";
    const result = oneOf(OUTCOMES, r.result) ?? "failed:invalid";
    t.added += strings(r.new).length;
    t.gone += strings(r.unavailable).length;
    t.reappeared += strings(r.reappeared).length;
    if (result === "already_running") t.running.push(provider);
    else if (result === "disabled" || result === "no-scanner") t.skipped.push({ provider, result });
    else if (result !== "ok") t.failed.push({ provider, result });
  }
  return t;
}

export type Filters = { provider: string; status: string; newOnly: boolean };
export function filterModels(models: readonly ModelEntry[], f: Filters, isNew: ReadonlySet<string>): ModelEntry[] {
  return models.filter((m) => (f.provider === "" || m.provider === f.provider) && (f.status === "" || m.status === f.status) && (!f.newOnly || isNew.has(modelKey(m))));
}

export function groupByProvider(models: readonly ModelEntry[]): { provider: string; models: ModelEntry[] }[] {
  const groups = new Map<string, ModelEntry[]>();
  for (const m of models) { const g = groups.get(m.provider); if (g) g.push(m); else groups.set(m.provider, [m]); }
  return [...groups].map(([provider, list]) => ({ provider, models: list }));
}

/** Sub-route of one model: both parts are percent-encoded, so ids with slashes or colons stay one segment each. */
export const routeFor = (provider: string, id: string): string => `${encodeURIComponent(provider)}/${encodeURIComponent(id)}`;
export function parseModelRoute(sub: string | undefined): { provider: string; id: string } | null {
  if (!sub) return null;
  const parts = sub.split("/");
  if (parts.length !== 2) return null;
  try {
    const provider = decodeURIComponent(parts[0]!), id = decodeURIComponent(parts[1]!);
    return provider && id ? { provider, id } : null;
  } catch { return null; }
}
