// Field metadata of the config keys the Settings sections edit. There is no schema RPC (docs/rpc.md has config.get/config.set/
// config.watch only), so type, enum, bounds, default and the restart class fallback are a static copy of
// packages/config-schema/schema/config.schema.json (a test fails when it drifts). Everything the server can say stays authoritative:
// current values and the restart class per key come from `config.get`, validation from `config.set`. Follow-up: a schema RPC.
export type Kind = "bool" | "enum" | "int" | "number" | "string" | "ints" | "strings" | "json";
export type FieldMeta = { key: string; kind: Kind; def?: unknown; min?: number; max?: number; options?: readonly string[]; restart?: "live" | "core" };

const b = (key: string, def: boolean, restart: "live" | "core" = "live"): FieldMeta => ({ key, kind: "bool", def, restart });
const n = (key: string, def: number, min: number, restart: "live" | "core", max?: number): FieldMeta => ({ key, kind: "int", def, min, restart, ...(max === undefined ? {} : { max }) });
const o = (key: string): FieldMeta => ({ key, kind: "json", restart: "live" });

export const META: readonly FieldMeta[] = [
  { key: "core.logLevel", kind: "enum", def: "info", options: ["debug", "info", "warn", "error"], restart: "live" },
  n("core.recall.softBudgetMs", 400, 50, "core"), n("core.recall.hardBudgetMs", 600, 100, "live"), n("core.recall.capChars", 17000, 1000, "core"),
  n("core.capture.waitMs", 60000, 1000, "live"), n("core.shutdownBudgetMs", 30000, 1000, "live"),
  n("supervisor.graceMs", 60000, 1000, "live"), n("supervisor.healthIntervalMs", 5000, 1000, "live"),
  b("metrics.enabled", false, "core"), n("metrics.port", 9464, 1024, "core", 65535),
  n("logs.maxBytes", 20971520, 1048576, "live"), n("logs.keep", 5, 1, "live"),
  o("modules"),
  b("extensions.allowUnsigned", true), n("extensions.trashDays", 14, 1, "live", 365),
  n("extensions.limits.packageBytes", 268435456, 1048576, "live", 1073741824), n("extensions.limits.skillBytes", 16777216, 1048576, "live", 1073741824),
  { key: "embedding.useClass", kind: "enum", def: "general", options: ["general", "research", "commercial"], restart: "core" },
  b("embedding.acceptedNcLicence", false, "core"), { key: "embedding.acceptedNcLicenceAt", kind: "string", restart: "core" },
  { key: "engine.baseDbPathOverride", kind: "string", restart: "core" },
  o("providers"), o("oauth"), o("decision"), o("modelRoles"), o("modelProfiles"),
  b("models.scan.enabled", true), n("models.scan.intervalHours", 24, 1, "live", 168),
  { key: "egress.allowHosts", kind: "strings", def: [], restart: "live" },
  { key: "egress.allowPorts", kind: "ints", def: [443], min: 1, max: 65535, restart: "live" },
  b("egress.allowLoopback", false),
];

const BY_KEY = new Map(META.map((m) => [m.key, m]));
export const metaOf = (key: string): FieldMeta | undefined => BY_KEY.get(key);

/** "core.recall.softBudgetMs" -> "Soft budget ms" (same derivation as the palette: the schema has no titles). */
export function humanize(key: string): string {
  const last = key.split(".").pop() ?? key;
  const words = last.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The id of a field's control: the palette deep-links `?focus=<key>`, the key with dots turned into dashes is the anchor. */
export const fieldId = (key: string): string => `cfg-${key.replace(/\./g, "-")}`;
