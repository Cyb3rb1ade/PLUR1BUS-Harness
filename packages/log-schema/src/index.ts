// @plur1bus/log-schema: the D111 record schema, event catalogue, level map and redaction patterns as data, plus
// the one validator both writers and the reader use. No logger, writer, redactor or sink lives here (D111 §9: those
// are later parts). The Rust mirror is crates/plur1bus-log-schema; fixtures/vectors.json pins that both agree.
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import recordSchemaJson from "../schema/record.schema.json" with { type: "json" };
import catalogueJson from "../schema/catalogue.json" with { type: "json" };
import levelsJson from "../schema/levels.json" with { type: "json" };
import redactionJson from "../schema/redaction.json" with { type: "json" };

export type Level = "trace" | "debug" | "info" | "warn" | "error" | "fatal";
export type SourceKind = "harness" | "extension" | "provider" | "model" | "cli" | "channel" | "host" | "desktop" | "os";
export type Stream = "diagnostic" | "audit" | "payload";

export interface LevelInfo {
  name: Level;
  rank: number;
  otel: { severityNumber: number; severityText: string };
  syslog: { severity: number; name: string };
  meaning: string;
}

export interface CatalogueEntry {
  event: string;
  kinds: SourceKind[];
  stream: Stream;
  level: Level;
  levels: Level[];
  levelRule?: string;
  msg: string;
  attrs: string;
  requiredAttrs: string[];
  streamed?: boolean;
  family?: boolean;
  activity: boolean;
  since: string;
  stability: "stable" | "experimental";
  note?: string;
  examples: Array<Record<string, unknown>>;
}

export interface AttrGroup { description: string; properties: Record<string, Record<string, unknown>> }

export interface Catalogue {
  version: string;
  nameRule: string;
  streams: Stream[];
  commonAttrs: Record<string, Record<string, unknown>>;
  attrGroups: Record<string, AttrGroup>;
  events: CatalogueEntry[];
}

export const RECORD_SCHEMA = recordSchemaJson as Record<string, any>;
export const CATALOGUE = catalogueJson as unknown as Catalogue;
export const REDACTION = redactionJson as Record<string, any>;

/** Top-level keys in their written order (grep-stable). */
export const KEY_ORDER: readonly string[] = RECORD_SCHEMA["x-key-order"];
export const LIMITS: Readonly<{ msgBytes: number; attrsBytes: number; lineBytes: number; dedupWindowMs: number; rateSustainedPerSecond: number; rateBurst: number }> = RECORD_SCHEMA["x-limits"];
export const SOURCE_KINDS: readonly SourceKind[] = RECORD_SCHEMA.$defs.SourceKind.enum;

// ---- levels (§2.6) ----

export const LEVELS: readonly LevelInfo[] = (levelsJson as { levels: LevelInfo[] }).levels;
const LEVEL_BY_NAME = new Map<string, LevelInfo>(LEVELS.map((l) => [l.name, l]));

export function isLevel(value: unknown): value is Level {
  return typeof value === "string" && LEVEL_BY_NAME.has(value);
}
/** Throws on an unknown level: a level that is not in the table must never be mapped silently. */
export function levelInfo(level: string): LevelInfo {
  const info = LEVEL_BY_NAME.get(level);
  if (!info) throw new RangeError(`unknown log level: ${JSON.stringify(level)}`);
  return info;
}
export const severityNumber = (level: Level): number => levelInfo(level).otel.severityNumber;
export const severityText = (level: Level): string => levelInfo(level).otel.severityText;
export const syslogSeverity = (level: Level): number => levelInfo(level).syslog.severity;
/** Negative, zero or positive like a comparator; `compareLevels("warn", "info") > 0`. */
export const compareLevels = (a: Level, b: Level): number => levelInfo(a).rank - levelInfo(b).rank;
/** True when a record at `level` passes a minimum of `min`. */
export const levelAtLeast = (level: Level, min: Level): boolean => compareLevels(level, min) >= 0;

// ---- source keys (§2.3) ----

const SOURCE_KEY_RE = new RegExp(RECORD_SCHEMA.$defs.SourceKey.pattern);
export const isSourceKey = (value: unknown): boolean => typeof value === "string" && SOURCE_KEY_RE.test(value);

// ---- catalogue lookup (§3) ----

const EXACT = new Map<string, CatalogueEntry>();
const FAMILIES = new Map<string, CatalogueEntry>(); // "repair" -> the `repair.*` entry
for (const entry of CATALOGUE.events) {
  if (entry.family) FAMILIES.set(entry.event.slice(0, -2), entry);
  else EXACT.set(entry.event, entry);
}
const NAME_RE = new RegExp(CATALOGUE.nameRule);

/** The catalogue entry that registers `name`: an exact entry, else the `<prefix>.*` family entry. */
export function lookupEvent(name: unknown): CatalogueEntry | undefined {
  if (typeof name !== "string" || !NAME_RE.test(name)) return undefined;
  const exact = EXACT.get(name);
  if (exact) return exact;
  return FAMILIES.get(name.slice(0, name.indexOf(".")));
}

// ---- validation ----

export type ValidationCode =
  | "not_object"
  | "invalid_level"
  | "unknown_event"
  | "msg_too_long"
  | "attrs_too_large"
  | "schema"
  | "key_order"
  | "level_not_allowed"
  | "source_kind_not_allowed"
  | "stream_mismatch"
  | "attrs_invalid";

export type ValidationResult = { ok: true; entry: CatalogueEntry } | { ok: false; code: ValidationCode; detail: string };

const ajv = new ((Ajv2020 as any).default ?? Ajv2020)({ strict: true, strictTypes: false, allowUnionTypes: true, allErrors: false });
ajv.addKeyword("x-schema-version"); ajv.addKeyword("x-key-order"); ajv.addKeyword("x-limits");
const validateShape: ValidateFunction = ajv.compile(RECORD_SCHEMA);
const attrsValidators = new Map<string, ValidateFunction>();

/** The JSON Schema one event's `attrs` must satisfy: its group plus the common attrs, closed, with the entry's required list. */
export function attrsSchemaFor(entry: CatalogueEntry): Record<string, unknown> {
  const group = CATALOGUE.attrGroups[entry.attrs];
  if (!group) throw new Error(`catalogue: unknown attrs group ${entry.attrs} for ${entry.event}`);
  return { type: "object", additionalProperties: false, properties: { ...CATALOGUE.commonAttrs, ...group.properties }, required: [...entry.requiredAttrs] };
}
function attrsValidator(entry: CatalogueEntry): ValidateFunction {
  const key = `${entry.attrs}|${entry.requiredAttrs.join(",")}`;
  const cached = attrsValidators.get(key);
  if (cached) return cached;
  const compiled: ValidateFunction = ajv.compile(attrsSchemaFor(entry));
  attrsValidators.set(key, compiled);
  return compiled;
}

const utf8 = new TextEncoder();
const bytes = (s: string): number => utf8.encode(s).length;

/** RFC 3339 `YYYY-MM-DDTHH:MM:SS.mmmZ` with a real calendar date and time (no leap seconds). The schema pattern only checks the shape. */
function realTimestamp(ts: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{3}Z$/.exec(ts);
  if (!m) return false;
  const [year, month, day, hour, minute, second] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return month >= 1 && month <= 12 && day >= 1 && day <= days! && hour < 24 && minute < 60 && second < 60;
}

const fail = (code: ValidationCode, detail: string): ValidationResult => ({ ok: false, code, detail });

/**
 * Validates one record against the schema and the catalogue. The checks run in a fixed order, and the first failure
 * names the code (the Rust `validate_line` runs the same order; fixtures/vectors.json pins it):
 * object → level in the table → event registered → msg bytes → attrs bytes → JSON Schema → key order →
 * level allowed for the event → source kind allowed → stream present iff the event is wrapped output → attrs group.
 * Key order is read from the object's own key order, so pass a record parsed from a line, not a re-sorted copy.
 */
export function validateRecord(record: unknown): ValidationResult {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return fail("not_object", "a record is a JSON object");
  const r = record as Record<string, unknown>;
  if ("level" in r && !isLevel(r.level)) return fail("invalid_level", `level ${JSON.stringify(r.level)} is not one of ${LEVELS.map((l) => l.name).join(", ")}`);
  const entry = "event" in r ? lookupEvent(r.event) : undefined;
  if ("event" in r && typeof r.event === "string" && !entry) return fail("unknown_event", `event ${JSON.stringify(r.event)} is not in the catalogue`);
  if (typeof r.msg === "string" && bytes(r.msg) > LIMITS.msgBytes) return fail("msg_too_long", `msg exceeds ${LIMITS.msgBytes} bytes`);
  if ("attrs" in r && r.attrs !== null && typeof r.attrs === "object" && bytes(JSON.stringify(r.attrs)) > LIMITS.attrsBytes) return fail("attrs_too_large", `attrs exceed ${LIMITS.attrsBytes} bytes`);
  if (!validateShape(r)) {
    const e = validateShape.errors?.[0];
    return fail("schema", `${e?.instancePath || "/"} ${e?.message ?? "does not match the record schema"}`);
  }
  if (!realTimestamp(r.ts as string)) return fail("schema", "/ts is not a real RFC 3339 date and time");
  let last = -1;
  for (const key of Object.keys(r)) {
    const at = KEY_ORDER.indexOf(key);
    if (at <= last) return fail("key_order", `key ${key} is out of order; the order is ${KEY_ORDER.join(", ")}`);
    last = at;
  }
  // Past this point the event is registered (the "event" key is required and was looked up above).
  const hit = entry!;
  if (!hit.levels.includes(r.level as Level)) return fail("level_not_allowed", `${hit.event} may be written at ${hit.levels.join(", ")}, not ${String(r.level)}`);
  const source = r.source as { kind: SourceKind };
  if (!hit.kinds.includes(source.kind)) return fail("source_kind_not_allowed", `${hit.event} may only be emitted by ${hit.kinds.join(", ")}, not ${source.kind}`);
  if (Boolean(hit.streamed) !== ("stream" in r)) return fail("stream_mismatch", hit.streamed ? `${hit.event} is wrapped output and needs a stream` : `${hit.event} is not wrapped output and must not carry a stream`);
  const attrs = "attrs" in r ? r.attrs : {};
  const check = attrsValidator(hit);
  if (!check(attrs)) {
    const e = check.errors?.[0];
    return fail("attrs_invalid", `attrs${e?.instancePath ?? ""} ${e?.message ?? "do not match the event's attrs group"}`);
  }
  return { ok: true, entry: hit };
}

/** The top-level keys of a JSON object text, in order, duplicates included (`JSON.parse` would collapse them). */
function topLevelKeys(text: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
    else if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      if (depth === 1) {
        let k = j + 1;
        while (k < text.length && /\s/.test(text[k]!)) k++;
        if (text[k] === ":") keys.push(JSON.parse(text.slice(i, j + 1)) as string);
      }
      i = j;
    }
  }
  return keys;
}

/**
 * Parses one line and validates it. A JSON syntax error or a non-object is `not_object`; a repeated top-level key is
 * `key_order` (a writer never emits one, and the order check is strict).
 */
export function validateLine(line: string): ValidationResult {
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { return fail("not_object", "not valid JSON"); }
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    const keys = topLevelKeys(line);
    if (new Set(keys).size !== keys.length) return fail("key_order", "a key appears more than once");
  }
  return validateRecord(parsed);
}
