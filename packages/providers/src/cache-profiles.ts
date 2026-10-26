// The provider prompt-cache profile table (RE-D21, plan §2.6): `schema/cache-profiles.json`, validated against
// `schema/cache-profiles.schema.json` when this module loads, plus the model-id normaliser that sits beside it. The core's
// prompt builder (`packages/core/src/prompt/model-table.ts`) and, from RE-14/T1, the Rust engine read the same table.

import table from "../schema/cache-profiles.json" with { type: "json" };
import schema from "../schema/cache-profiles.schema.json" with { type: "json" };

export type CacheProvider = "anthropic" | "openai" | "google" | "xai" | "moonshot" | "deepseek" | "alibaba" | "zai" | "mistral" | "local";
export type CacheWire = "anthropic_messages" | "chat_completions" | "codex_responses" | "gemini";
export type CacheTtl = "5m" | "30m" | "1h" | "12h";
export type CachePlatform = "first-party" | "bedrock" | "bedrock-legacy" | "google-managed" | "vertex" | "chatgpt-plan" | "local";
export type CacheClass = "explicit-breakpoints" | "implicit-ttl-tier" | "implicit-routing-key" | "implicit" | "local-kv";
export type CacheGateway = "direct" | "openrouter";

export interface CacheTtlEntry { ttl: CacheTtl; write: number | null; read: number | null; wires?: CacheWire[] }
export interface CacheAffinity { field: string; in: "body" | "header"; maxLength: number | null; wires?: CacheWire[] }
export interface CacheUsageMap { read: string[]; write: string[]; miss?: string[]; inputIncludesCache: boolean }

/** One row of the table, exactly as stored (see the schema's descriptions). */
export interface CacheProfileRow {
  id: string;
  match: string;
  provider: CacheProvider;
  platforms: CachePlatform[];
  class: CacheClass;
  mechanism: "explicit" | "implicit";
  minTokens: number;
  minTokensCounts: "prefix" | "visible-input";
  belowMinimum: "silent" | "error" | "unverified";
  maxBreakpoints: number;
  lookbackPositions: number;
  lookbackCollapsesRuns: boolean;
  ttls: CacheTtlEntry[];
  warmMs: number | null;
  ttlField: string | null;
  affinity: CacheAffinity[];
  usage: CacheUsageMap;
  holdConstant?: string[];
  suppressWrite: "omit-marker" | "explicit-mode-without-breakpoint" | "short-ttl" | "not-possible" | "not-applicable";
  tokenizerFamily: string;
  source: string;
  verified: string;
  status: "verified" | "unverified" | "conflict";
  notes?: string;
}

export interface CacheGatewayProfile {
  slugPrefixes: Record<string, CacheProvider>;
  affinity: CacheAffinity[];
  markers: Array<"text-parts" | "tools">;
  markerProviders?: CacheProvider[];
  ttlForwarded: "yes" | "no" | "unverified";
  usage: CacheUsageMap;
  source: string;
  verified: string;
  status: "verified" | "unverified" | "conflict";
  notes?: string;
}

export interface CacheHost { pattern: string; gateway?: "openrouter"; platform?: CachePlatform; vendor?: CacheProvider }

export interface CacheProfileTable {
  version: number;
  aliases: Array<{ from: string; to: string; since: string; source: string }>;
  hosts: CacheHost[];
  rows: CacheProfileRow[];
  gateways: { openrouter: CacheGatewayProfile };
}

type Schema = { $ref?: string; type?: string | string[]; enum?: unknown[]; required?: string[]; properties?: Record<string, Schema>;
  additionalProperties?: boolean | Schema; items?: Schema; minimum?: number; minItems?: number; minLength?: number; pattern?: string };

const typeOf = (v: unknown): string => v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v;

/**
 * The subset of JSON Schema the table's own schema uses ($ref, type, enum, required, properties, additionalProperties,
 * items, minimum, minItems, minLength, pattern), so the table is checked against that file and no second copy of its
 * rules exists. Returns the first problem as `path: message`, or undefined.
 */
export function checkAgainstSchema(value: unknown, s: Schema, root: Schema, path = "$"): string | undefined {
  if (s.$ref) return checkAgainstSchema(value, resolveRef(s.$ref, root), root, path);
  const t = typeOf(value);
  if (s.type !== undefined) {
    const allowed = Array.isArray(s.type) ? s.type : [s.type];
    if (!allowed.includes(t) && !(t === "integer" && allowed.includes("number"))) return `${path}: expected ${allowed.join(" or ")}, got ${t}`;
  }
  if (s.enum !== undefined && !s.enum.includes(value)) return `${path}: ${JSON.stringify(value)} is not one of ${s.enum.map((e) => JSON.stringify(e)).join(", ")}`;
  if (typeof value === "number" && s.minimum !== undefined && value < s.minimum) return `${path}: below ${s.minimum}`;
  if (typeof value === "string") {
    if (s.minLength !== undefined && value.length < s.minLength) return `${path}: shorter than ${s.minLength}`;
    if (s.pattern !== undefined && !new RegExp(s.pattern, "u").test(value)) return `${path}: does not match ${s.pattern}`;
  }
  if (Array.isArray(value)) {
    if (s.minItems !== undefined && value.length < s.minItems) return `${path}: fewer than ${s.minItems} items`;
    if (s.items) for (const [i, item] of value.entries()) { const e = checkAgainstSchema(item, s.items, root, `${path}[${i}]`); if (e) return e; }
  }
  if (t === "object") {
    const o = value as Record<string, unknown>;
    for (const k of s.required ?? []) if (!(k in o)) return `${path}: missing ${k}`;
    for (const [k, v] of Object.entries(o)) {
      const sub = s.properties?.[k] ?? (typeof s.additionalProperties === "object" ? s.additionalProperties : undefined);
      if (!sub) { if (s.additionalProperties === false) return `${path}: unknown key ${k}`; continue; }
      const e = checkAgainstSchema(v, sub, root, `${path}.${k}`); if (e) return e;
    }
  }
  return undefined;
}

function resolveRef(ref: string, root: Schema): Schema {
  const m = /^#\/\$defs\/([A-Za-z]+)$/.exec(ref);
  const target = m ? (root as { $defs?: Record<string, Schema> }).$defs?.[m[1]!] : undefined;
  if (!target) throw new TypeError(`cache-profiles schema: unresolvable $ref ${ref}`);
  return target;
}

/** Validates a table (schema first, then what the schema cannot say: unique ids, compilable patterns). Throws on the first problem. */
export function loadCacheProfileTable(raw: unknown): CacheProfileTable {
  const problem = checkAgainstSchema(raw, schema as Schema, schema as Schema);
  if (problem) throw new TypeError(`cache-profiles.json: ${problem}`);
  const t = raw as CacheProfileTable;
  const ids = new Set<string>();
  for (const r of t.rows) {
    if (ids.has(r.id)) throw new TypeError(`cache-profiles.json: duplicate row id ${r.id}`);
    ids.add(r.id);
    try { new RegExp(r.match, "u"); } catch { throw new TypeError(`cache-profiles.json: row ${r.id} has an invalid match pattern`); }
    if ((r.mechanism === "explicit") !== (r.maxBreakpoints > 0)) throw new TypeError(`cache-profiles.json: row ${r.id}: only explicit rows have breakpoints`);
  }
  for (const h of t.hosts) {
    try { new RegExp(h.pattern, "u"); } catch { throw new TypeError(`cache-profiles.json: host pattern ${h.pattern} is invalid`); }
  }
  return t;
}

export const CACHE_PROFILE_TABLE: CacheProfileTable = loadCacheProfileTable(table);
const MATCHERS = new Map(CACHE_PROFILE_TABLE.rows.map((r) => [r.id, new RegExp(r.match, "u")]));
const ALIASES = new Map(CACHE_PROFILE_TABLE.aliases.map((a) => [a.from, a.to]));

/** Where a request goes, as far as the caller knows it; every field optional. `vendor` is set when the route reaches that
 *  provider's own first-party API, the only place its body fields are sent. */
export interface CacheRoute { gateway?: CacheGateway; platform?: CachePlatform; local?: boolean; vendor?: CacheProvider }

const HOSTS = CACHE_PROFILE_TABLE.hosts.map((h) => ({ ...h, re: new RegExp(h.pattern, "u") }));

/** The route a base URL reaches, from the table's host list; an unknown host is a route with nothing known about it. */
export function cacheRouteForUrl(url: string): CacheRoute {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return {}; }
  const h = HOSTS.find((x) => x.re.test(host));
  if (!h) return {};
  return { ...(h.gateway ? { gateway: h.gateway } : {}), ...(h.platform ? { platform: h.platform } : {}), ...(h.vendor ? { vendor: h.vendor } : {}) };
}

export interface NormalizedModelRef {
  /** Lower case, no gateway or platform decoration, dots as dashes, served aliases applied. */
  id: string;
  /** Set when the id carried a known OpenRouter slug prefix. */
  gateway?: CacheGateway;
  /** Set when the id carried a platform form (Bedrock `anthropic.` ids, Google `@date` ids). */
  platform?: CachePlatform;
}

const BEDROCK = /^(?:(?:us|eu|apac|jp|au|global)\.)?anthropic\.(claude-[a-z0-9.-]+?)(?:-v\d+(?::\d+)?)?$/;

/**
 * `Anthropic/Claude-Opus-4.5` -> `claude-opus-4-5` (OpenRouter), `us.anthropic.claude-opus-4-7-v1:0` -> `claude-opus-4-7`
 * (Bedrock), `claude-opus-4-1@20250805` -> `claude-opus-4-1` (Google), then the table's served-model aliases.
 */
export function normalizeModelRef(model: string): NormalizedModelRef {
  let id = model.trim().toLowerCase();
  let gateway: CacheGateway | undefined;
  let platform: CachePlatform | undefined;
  const slash = id.indexOf("/");
  if (slash > 0) {
    const prefix = id.slice(0, slash);
    if (Object.hasOwn(CACHE_PROFILE_TABLE.gateways.openrouter.slugPrefixes, prefix)) {
      gateway = "openrouter";
      id = id.slice(slash + 1).replace(/:[a-z]+$/, "");
    }
  }
  const bedrock = BEDROCK.exec(id);
  if (bedrock) { id = bedrock[1]!; platform = "bedrock"; }
  else if (/^claude-[^@]+@\d{8}$/.test(id)) { id = id.slice(0, id.indexOf("@")); platform = "google-managed"; }
  id = id.replace(/\./g, "-");
  id = ALIASES.get(id) ?? id;
  return { id, ...(gateway ? { gateway } : {}), ...(platform ? { platform } : {}) };
}

export interface CacheProfileMatch {
  /** The matching row, or undefined when the table does not know the model on this platform. */
  row: CacheProfileRow | undefined;
  ref: NormalizedModelRef;
  platform: CachePlatform;
  gateway: CacheGateway;
}

/** First row whose platforms include the route's platform and whose pattern accepts the normalised id. A local route takes the local row. */
export function findCacheProfile(model: string, route: CacheRoute = {}): CacheProfileMatch {
  const ref = normalizeModelRef(model);
  const platform: CachePlatform = route.local ? "local" : route.platform ?? ref.platform ?? "first-party";
  const gateway: CacheGateway = route.gateway ?? ref.gateway ?? "direct";
  const row = CACHE_PROFILE_TABLE.rows.find((r) => r.platforms.includes(platform) && MATCHERS.get(r.id)!.test(ref.id));
  return { row, ref, platform, gateway };
}
