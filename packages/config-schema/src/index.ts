import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import schemaJson from "../schema/config.schema.json" with { type: "json" };

export const CONFIG_SCHEMA = schemaJson as Record<string, any>;
export const SCHEMA_VERSION = 1 as const;

export interface HarnessConfig {
  $schema?: string;
  schemaVersion: 1;
  core: { logLevel: "debug" | "info" | "warn" | "error"; recall: { softBudgetMs: number; hardBudgetMs: number; capChars: number }; capture: { waitMs: number }; shutdownBudgetMs: number };
  supervisor: { graceMs: number; healthIntervalMs: number };
  logs: { maxBytes: number; keep: number };
  agents: Record<string, { createdAt?: string; displayName?: string }>;
  embedding: { useClass: "general" | "research" | "commercial"; acceptedNcLicence: boolean; acceptedNcLicenceAt?: string };
  engine: Record<string, unknown> & { baseDbPathOverride?: string };
  providers: Record<string, unknown>;
  oauth: Record<string, unknown>;
  decision: Record<string, unknown>;
  modelRoles: Record<string, string>;
}

export type RestartClass = "live" | "core" | `module:${string}`;

const ajv = new ((Ajv2020 as any).default ?? Ajv2020)({ strict: true, allErrors: true, useDefaults: true, strictSchema: false });
((addFormats as any).default ?? addFormats)(ajv);
ajv.addKeyword("x-restart"); ajv.addKeyword("x-reserved"); ajv.addKeyword("x-tier");
const validateFn: ValidateFunction = ajv.compile(CONFIG_SCHEMA);

/** Defaults are produced by validating an empty object with useDefaults — one source of truth. */
export function defaults(): HarnessConfig {
  const seed: Record<string, unknown> = { $schema: CONFIG_SCHEMA.$id, schemaVersion: 1 };
  const r = validate(seed);
  if (!r.ok) throw new Error(`schema defaults do not validate: ${r.errors.join("; ")}`);
  return r.config;
}

export function validate(value: unknown): { ok: true; config: HarnessConfig } | { ok: false; errors: string[] } {
  const copy = structuredClone(value);
  if (validateFn(copy)) return { ok: true, config: copy as HarnessConfig };
  return { ok: false, errors: (validateFn.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}${e.params && "additionalProperty" in e.params ? ` (${(e.params as any).additionalProperty})` : ""}`.trim()) };
}

export function restartClassOf(keyPath: string): RestartClass {
  let node: any = CONFIG_SCHEMA;
  let cls: RestartClass = "core"; // unknown → the conservative class
  if (node["x-restart"]) cls = node["x-restart"];
  for (const part of keyPath.split(".")) {
    const next = node?.properties?.[part] ?? (node?.additionalProperties && typeof node.additionalProperties === "object" ? node.additionalProperties : undefined);
    if (!next) break;
    node = next;
    if (node["x-restart"]) cls = node["x-restart"];
  }
  return cls;
}

function diff(a: unknown, b: unknown, path: string[], out: string[]): void {
  // Check if both are plain objects (non-null, non-array)
  const aIsObj = a && typeof a === "object" && !Array.isArray(a);
  const bIsObj = b && typeof b === "object" && !Array.isArray(b);

  if (aIsObj && bIsObj) {
    // Both are objects, recurse into all keys
    const allKeys = new Set([...Object.keys(a as Record<string, unknown>), ...Object.keys(b as Record<string, unknown>)]);
    for (const k of allKeys) {
      diff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], [...path, k], out);
    }
  } else {
    // At least one is not an object, compare values
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      if (path.length > 0) {
        out.push(path.join("."));
      }
    }
  }
}

export function restartPlan(before: unknown, after: unknown): { changed: string[]; restart: { live: string[]; core: boolean; modules: string[] } } {
  const changed: string[] = [];
  diff(before, after, [], changed);
  changed.sort();

  const restart = { live: [] as string[], core: false, modules: [] as string[] };
  for (const key of changed) {
    const cls = restartClassOf(key);
    if (cls === "live") restart.live.push(key);
    else if (cls === "core") restart.core = true;
    else { const m = cls.slice("module:".length); if (!restart.modules.includes(m)) restart.modules.push(m); }
  }
  return { changed, restart };
}

export type Tier = "basic" | "advanced";

/** The `restartClassOf` walk, but resolving `x-tier` instead: nearest ancestor declaring `x-tier`
 * wins, root default `"advanced"` (the conservative class — more settings hidden, not fewer). */
export function tierOf(keyPath: string): Tier {
  let node: any = CONFIG_SCHEMA;
  let tier: Tier = "advanced";
  if (node["x-tier"]) tier = node["x-tier"];
  for (const part of keyPath.split(".")) {
    const next = node?.properties?.[part] ?? (node?.additionalProperties && typeof node.additionalProperties === "object" ? node.additionalProperties : undefined);
    if (!next) break;
    node = next;
    if (node["x-tier"]) tier = node["x-tier"];
  }
  return tier;
}

/** An annotated node (declares `x-tier`) is kept whole iff its tier equals `tier`; an unannotated
 * container is recursed through `properties` and kept iff at least one child is kept, with
 * `properties` reduced and `required` filtered to the kept keys. Returns `undefined` when the
 * whole node is dropped. */
function filterSchemaNode(node: any, tier: Tier): any {
  if (node && typeof node === "object" && "x-tier" in node) {
    return node["x-tier"] === tier ? node : undefined;
  }
  if (node && typeof node === "object" && node.properties) {
    const properties: Record<string, any> = {};
    for (const [k, v] of Object.entries<any>(node.properties)) {
      const kept = filterSchemaNode(v, tier);
      if (kept !== undefined) properties[k] = kept;
    }
    if (Object.keys(properties).length === 0) return undefined;
    const out: Record<string, any> = { ...node, properties };
    if (Array.isArray(node.required)) out.required = node.required.filter((k: string) => k in properties);
    else delete out.required;
    return out;
  }
  return undefined;
}

/** The root keeps `$schema`, `$id`, `title`, `type`, `additionalProperties` and its filtered
 * `properties`/`required` (see `filterSchemaNode`). */
export function filterSchemaByTier(schema: Record<string, any>, tier: Tier): Record<string, any> {
  const properties: Record<string, any> = {};
  for (const [k, v] of Object.entries<any>(schema.properties ?? {})) {
    const kept = filterSchemaNode(v, tier);
    if (kept !== undefined) properties[k] = kept;
  }
  const out: Record<string, any> = {};
  for (const k of ["$schema", "$id", "title", "type", "additionalProperties"]) {
    if (k in schema) out[k] = schema[k];
  }
  out.properties = properties;
  out.required = Array.isArray(schema.required) ? schema.required.filter((k: string) => k in properties) : [];
  return out;
}

/** Walks the config value tree with the same schema decisions as `filterSchemaNode`: an annotated
 * schema node keeps the value iff its tier matches `tier`; an unannotated container recurses;
 * a key the schema does not describe (or whose schema node is neither annotated nor a container)
 * is dropped. Returns `{ keep: false }` when nothing under this node survives. */
function filterConfigNode(schemaNode: any, value: unknown, tier: Tier): { keep: true; value: unknown } | { keep: false } {
  if (schemaNode && typeof schemaNode === "object" && "x-tier" in schemaNode) {
    return schemaNode["x-tier"] === tier ? { keep: true, value } : { keep: false };
  }
  if (schemaNode && typeof schemaNode === "object" && schemaNode.properties && value && typeof value === "object" && !Array.isArray(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries<any>(schemaNode.properties)) {
      if (!(k in (value as Record<string, unknown>))) continue;
      const r = filterConfigNode(v, (value as Record<string, unknown>)[k], tier);
      if (r.keep) out[k] = r.value;
    }
    return Object.keys(out).length > 0 ? { keep: true, value: out } : { keep: false };
  }
  return { keep: false };
}

export function filterConfigByTier(config: unknown, tier: Tier): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (config && typeof config === "object") {
    for (const [k, v] of Object.entries<any>(CONFIG_SCHEMA.properties ?? {})) {
      if (!(k in (config as Record<string, unknown>))) continue;
      const r = filterConfigNode(v, (config as Record<string, unknown>)[k], tier);
      if (r.keep) out[k] = r.value;
    }
  }
  return out;
}

/** Migrations vN → vN+1 register here; version 1 has none. */
const MIGRATIONS: Record<number, (c: any) => any> = {};
export function migrate(value: unknown): { config: unknown; from: number; to: number; applied: boolean } {
  const from = Number((value as any)?.schemaVersion ?? 0);
  let config = structuredClone(value) as any; let v = from;
  while (MIGRATIONS[v]) { config = MIGRATIONS[v]!(config); v += 1; config.schemaVersion = v; }
  return { config, from, to: v, applied: v !== from };
}
