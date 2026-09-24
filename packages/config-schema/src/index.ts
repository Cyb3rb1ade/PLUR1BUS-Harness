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
ajv.addKeyword("x-restart"); ajv.addKeyword("x-reserved");
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

function flatten(value: unknown, prefix: string[], out: Map<string, unknown>): void {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (prefix.length > 0) {
      // Record all containers (empty and non-empty)
      out.set(prefix.join("."), value);
    }
    for (const [k, v] of entries) flatten(v, [...prefix, k], out);
  } else if (prefix.length > 0) {
    out.set(prefix.join("."), value);
  }
}

export function restartPlan(before: unknown, after: unknown): { changed: string[]; restart: { live: string[]; core: boolean; modules: string[] } } {
  const a = new Map<string, unknown>(); const b = new Map<string, unknown>();
  flatten(before, [], a); flatten(after, [], b);
  let changed = [...new Set([...a.keys(), ...b.keys()])].filter((k) => JSON.stringify(a.get(k)) !== JSON.stringify(b.get(k))).sort();

  // Filter: remove parent containers if a newly-added container exists (keep the new container, not its contents)
  changed = changed.filter(k => {
    const children = changed.filter(other => other.startsWith(k + "."));
    if (children.length === 0) return true; // No children, keep it

    // Check if this is a newly-added container
    const aVal = a.get(k);
    const bVal = b.get(k);
    if ((aVal === undefined || aVal === null) && bVal && typeof bVal === "object" && !Array.isArray(bVal)) {
      // Newly added container, keep it
      return true;
    }

    // Has children but not a new container, remove this parent
    return false;
  });

  // Second pass: remove children of newly-added containers
  changed = changed.filter(k => {
    const parts = k.split(".");
    for (let i = 0; i < parts.length - 1; i++) {
      const parent = parts.slice(0, i + 1).join(".");
      if (changed.includes(parent)) {
        const parentAVal = a.get(parent);
        const parentBVal = b.get(parent);
        if ((parentAVal === undefined || parentAVal === null) && parentBVal && typeof parentBVal === "object" && !Array.isArray(parentBVal)) {
          // Parent is a newly added container, remove this child
          return false;
        }
      }
    }
    return true;
  });

  const restart = { live: [] as string[], core: false, modules: [] as string[] };
  for (const key of changed) {
    const cls = restartClassOf(key);
    if (cls === "live") restart.live.push(key);
    else if (cls === "core") restart.core = true;
    else { const m = cls.slice("module:".length); if (!restart.modules.includes(m)) restart.modules.push(m); }
  }
  return { changed, restart };
}

/** Migrations vN → vN+1 register here; version 1 has none. */
const MIGRATIONS: Record<number, (c: any) => any> = {};
export function migrate(value: unknown): { config: unknown; from: number; to: number; applied: boolean } {
  const from = Number((value as any)?.schemaVersion ?? 0);
  let config = structuredClone(value) as any; let v = from;
  while (MIGRATIONS[v]) { config = MIGRATIONS[v]!(config); v += 1; config.schemaVersion = v; }
  return { config, from, to: v, applied: v !== from };
}
