// Pure logic of the config sections: which fields a section shows, draft parsing, the change list, restart classes, and the
// mapping of E_CONFIG_INVALID text onto fields. No DOM, no RPC.
import type { Key } from "../../../i18n.ts";
import { isSensitiveKey } from "../../../palette/match.ts";
import { sectionOf, type SectionDef } from "../../../settings-sections.ts";
import { META, type Kind } from "./meta.ts";

export type Field = {
  key: string; kind: Kind; /** value in the running config, undefined when unset */ value: unknown; def: unknown;
  options?: readonly string[]; min?: number; max?: number;
  /** from config.get for this key: "live", "core", "module:<name>", or null when unknown */ restartClass: string | null;
  /** true when the widget cannot edit it safely: shown as formatted JSON */ readOnly: boolean;
};
export type Draft = Record<string, string | boolean>;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const pathHas = (o: unknown, key: string): unknown => key.split(".").reduce<unknown>((at, seg) => (isObj(at) ? at[seg] : undefined), o);

function derivedKind(v: unknown): Kind {
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "number";
  if (typeof v === "string") return "string";
  if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string")) return "strings";
  if (Array.isArray(v) && v.length > 0 && v.every((x) => Number.isInteger(x))) return "ints";
  return "json";
}

/** Leaves of the running configuration that the static metadata does not know (a key added by a newer harness): widgets come from
 *  the value types. `engine` is a pass-through of dozens of engine keys and stays out. */
function extraLeaves(config: Record<string, unknown>, known: ReadonlySet<string>, opaque: readonly string[]): [string, unknown][] {
  const out: [string, unknown][] = [];
  const walk = (o: Record<string, unknown>, prefix: string): void => {
    for (const [k, v] of Object.entries(o)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (known.has(key) || opaque.some((p) => key === p || key.startsWith(`${p}.`))) continue;
      if (isObj(v) && Object.keys(v).length > 0) walk(v, key); else out.push([key, v]);
    }
  };
  walk(config, "");
  return out.filter(([key]) => key !== "engine" && !key.startsWith("engine."));
}

/** The fields of a config section, in schema order. Keys that may hold secret values are never included. */
export function buildFields(config: unknown, section: SectionDef, restart: Readonly<Record<string, string | null>> = {}): Field[] {
  const cfg = isObj(config) ? config : {};
  const mine = (key: string): boolean => sectionOf(key)?.id === section.id && !isSensitiveKey(key);
  const fields: Field[] = META.filter((m) => mine(m.key)).map((m) => {
    const value = pathHas(cfg, m.key);
    return {
      key: m.key, kind: m.kind, value, def: m.def, ...(m.options ? { options: m.options } : {}), ...(m.min === undefined ? {} : { min: m.min }), ...(m.max === undefined ? {} : { max: m.max }),
      restartClass: restart[m.key] ?? m.restart ?? null, readOnly: m.kind === "json",
    };
  });
  const known = new Set(META.map((m) => m.key));
  const opaque = META.filter((m) => m.kind === "json").map((m) => m.key);
  for (const [key, value] of extraLeaves(cfg, known, opaque)) {
    if (!mine(key)) continue;
    const kind = derivedKind(value);
    fields.push({ key, kind, value, def: undefined, restartClass: restart[key] ?? null, readOnly: kind === "json" });
  }
  return fields;
}

/** The value a field currently has: the configured one, else the default. */
export const effective = (f: Field): unknown => (f.value !== undefined ? f.value : f.def);

const isList = (k: Kind): boolean => k === "strings" || k === "ints";

export function toDraftValue(f: Field): string | boolean {
  const v = effective(f);
  if (f.kind === "bool") return v === true;
  if (isList(f.kind)) return Array.isArray(v) ? v.join("\n") : "";
  return v === undefined || v === null ? "" : String(v);
}
export function initialDraft(fields: readonly Field[]): Draft {
  const d: Draft = {};
  for (const f of fields) if (!f.readOnly) d[f.key] = toDraftValue(f);
  return d;
}

export type Parsed = { ok: true; value: unknown } | { ok: false; error: Key; params?: Record<string, string | number> };

/** Turns what the user typed into the value `config.set` would send, or says what is wrong (client-side bounds from the schema). */
export function parseDraft(f: Field, raw: string | boolean): Parsed {
  if (f.kind === "bool") return { ok: true, value: raw === true };
  const text = typeof raw === "string" ? raw : String(raw);
  const bounds = (n: number): Parsed | null => {
    if (f.min !== undefined && n < f.min) return { ok: false, error: "settings.err.min", params: { min: f.min } };
    if (f.max !== undefined && n > f.max) return { ok: false, error: "settings.err.max", params: { max: f.max } };
    return null;
  };
  switch (f.kind) {
    case "enum": return f.options && !f.options.includes(text) ? { ok: false, error: "settings.err.enum" } : { ok: true, value: text };
    case "string": return { ok: true, value: text };
    case "int": case "number": {
      const s = text.trim();
      const okFormat = f.kind === "int" ? /^-?\d+$/.test(s) : s !== "" && Number.isFinite(Number(s));
      if (!okFormat) return { ok: false, error: f.kind === "int" ? "settings.err.int" : "settings.err.number" };
      return bounds(Number(s)) ?? { ok: true, value: Number(s) };
    }
    case "strings": return { ok: true, value: text.split("\n").map((l) => l.trim()).filter((l) => l !== "") };
    case "ints": {
      const items = text.split("\n").map((l) => l.trim()).filter((l) => l !== "");
      if (!items.every((s) => /^-?\d+$/.test(s))) return { ok: false, error: "settings.err.ints" };
      const nums = items.map(Number);
      for (const n of nums) { const bad = bounds(n); if (bad) return bad; }
      return { ok: true, value: nums };
    }
    default: return { ok: false, error: "settings.err.readonly" };
  }
}

export type Change = { key: string; old: unknown; value: unknown; restartClass: string | null };

/** Parses every edited field; `errors` holds the ones that do not parse, `changes` those whose value differs from the current one. */
export function collectChanges(fields: readonly Field[], draft: Draft): { changes: Change[]; errors: Record<string, { key: Key; params?: Record<string, string | number> }> } {
  const changes: Change[] = [];
  const errors: Record<string, { key: Key; params?: Record<string, string | number> }> = {};
  for (const f of fields) {
    if (f.readOnly) continue;
    const raw = draft[f.key];
    if (raw === undefined) continue;
    if (raw === toDraftValue(f)) continue;
    const p = parseDraft(f, raw);
    if (!p.ok) { errors[f.key] = { key: p.error, ...(p.params ? { params: p.params } : {}) }; continue; }
    const old = effective(f);
    if (JSON.stringify(old ?? null) === JSON.stringify(p.value) || (old === undefined && p.value === "")) continue;
    changes.push({ key: f.key, old, value: p.value, restartClass: f.restartClass });
  }
  return { changes, errors };
}

export type RestartKind = "live" | "restart" | "unknown";
export const restartKind = (cls: string | null): RestartKind => (cls === "live" ? "live" : cls === "core" || (cls !== null && cls.startsWith("module:")) ? "restart" : "unknown");

/** What a diff cell shows for a value. */
export function show(v: unknown): string {
  if (v === undefined) return "";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

/** Replaces the values of keys that may hold secrets by a mask, at any depth, before formatted JSON is shown. */
export function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, isSensitiveKey(k) ? "••••" : redact(x)]));
  return v;
}

/** Assigns the segments of an E_CONFIG_INVALID text ("/core/logLevel must be ...; ...") to the fields they name (dotted key or
 *  JSON pointer). Segments that name no field come back in `rest`. */
export function mapInvalid(text: string, keys: readonly string[]): { byKey: Record<string, string>; rest: string[] } {
  const byKey: Record<string, string> = {};
  const rest: string[] = [];
  for (const seg of text.split(/[;\n]+/).map((s) => s.trim()).filter((s) => s !== "")) {
    const hit = [...keys].sort((a, b) => b.length - a.length).find((k) => seg.includes(k) || seg.includes(`/${k.replaceAll(".", "/")}`));
    if (hit) byKey[hit] = byKey[hit] ? `${byKey[hit]}; ${seg}` : seg; else rest.push(seg);
  }
  return { byKey, rest };
}

