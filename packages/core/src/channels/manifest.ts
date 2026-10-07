// The channel manifest (`channel.json` next to a channel's `module.json`; a channel is a D14 module with kind "channel").
// One JSON Schema is the source; the small validator below interprets exactly the keywords it uses, so the core needs no
// extra dependency. Closed object: an unknown property is a refusal, like every D14 manifest.

export const CHANNEL_API_VERSIONS = ["1"] as const;

export const CHANNEL_MANIFEST_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "PLUR1BUS channel manifest",
  type: "object",
  additionalProperties: false,
  required: ["name", "version", "kind", "apiVersion"],
  properties: {
    name: { type: "string", pattern: "^[a-z][a-z0-9-]{1,31}$" },
    version: { type: "string", pattern: "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$" },
    kind: { const: "channel" },
    apiVersion: { enum: [...CHANNEL_API_VERSIONS] },
    displayName: { type: "string", minLength: 1, maxLength: 64 },
    chatKinds: { type: "array", items: { enum: ["direct", "group", "broadcast"] }, minItems: 1, uniqueItems: true, default: ["direct"] },
    startDelayMs: { type: "integer", minimum: 0, maximum: 600_000, default: 0 },
    maxRestarts: { type: "integer", minimum: 0, maximum: 100, default: 8 },
  },
} as const;

export interface ChannelManifest {
  name: string;
  version: string;
  kind: "channel";
  apiVersion: "1";
  displayName?: string;
  chatKinds: ("direct" | "group" | "broadcast")[];
  startDelayMs: number;
  maxRestarts: number;
}

type S = Record<string, any>;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function check(s: S, v: unknown, path: string, errors: string[]): unknown {
  if ("const" in s && v !== s.const) { errors.push(`${path} must be ${JSON.stringify(s.const)}`); return v; }
  if (s.enum && !s.enum.includes(v)) { errors.push(`${path} must be one of ${s.enum.join(", ")}`); return v; }
  if (s.type === "string") {
    if (typeof v !== "string") { errors.push(`${path} must be a string`); return v; }
    if (s.minLength !== undefined && v.length < s.minLength) errors.push(`${path} is too short`);
    if (s.maxLength !== undefined && v.length > s.maxLength) errors.push(`${path} is too long`);
    if (s.pattern && !new RegExp(s.pattern).test(v)) errors.push(`${path} does not match ${s.pattern}`);
  } else if (s.type === "integer") {
    if (typeof v !== "number" || !Number.isInteger(v)) { errors.push(`${path} must be an integer`); return v; }
    if (s.minimum !== undefined && v < s.minimum) errors.push(`${path} must be >= ${s.minimum}`);
    if (s.maximum !== undefined && v > s.maximum) errors.push(`${path} must be <= ${s.maximum}`);
  } else if (s.type === "array") {
    if (!Array.isArray(v)) { errors.push(`${path} must be an array`); return v; }
    if (s.minItems !== undefined && v.length < s.minItems) errors.push(`${path} needs at least ${s.minItems} item(s)`);
    if (s.uniqueItems && new Set(v).size !== v.length) errors.push(`${path} must not repeat items`);
    if (s.items) v.forEach((x, i) => check(s.items, x, `${path}/${i}`, errors));
  } else if (s.type === "object") {
    if (!isObj(v)) { errors.push(`${path} must be an object`); return v; }
    const out: Record<string, unknown> = { ...v };
    for (const k of s.required ?? []) if (!(k in v)) errors.push(`${path}/${k} is required`);
    for (const k of Object.keys(v)) if (!(k in s.properties) && s.additionalProperties === false) errors.push(`${path}/${k} is not allowed`);
    for (const [k, sub] of Object.entries<S>(s.properties)) {
      if (k in v) out[k] = check(sub, v[k], `${path}/${k}`, errors);
      else if ("default" in sub) out[k] = structuredClone(sub.default);
    }
    return out;
  }
  return v;
}

export function validateChannelManifest(v: unknown): { ok: true; manifest: ChannelManifest } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const out = check(CHANNEL_MANIFEST_SCHEMA as S, structuredCloneSafe(v), "", errors);
  return errors.length ? { ok: false, errors } : { ok: true, manifest: out as ChannelManifest };
}

function structuredCloneSafe(v: unknown): unknown {
  try { return structuredClone(v); } catch { return Symbol.for("uncloneable"); }
}
