import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Import, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import names from "../generated/names.json" with { type: "json" };
import schemaJson from "../schema/rpc.schema.json" with { type: "json" };

const Ajv2020 = ((Ajv2020Import as any).default ?? Ajv2020Import) as typeof Ajv2020Import.default;
const addFormats = ((addFormatsImport as any).default ?? addFormatsImport) as typeof addFormatsImport.default;

export type * from "../generated/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const RPC_VERSION: string = names.rpc;
export const METHODS = Object.freeze(names.methods) as readonly string[];
export const NOTIFICATIONS = Object.freeze(names.notifications) as readonly string[];
export const ERROR_CODES = Object.freeze(names.errors) as readonly string[];
export type ErrorCode = (typeof ERROR_CODES)[number];
export const SCHEMA = schemaJson as Record<string, unknown>;

const ajv = new Ajv2020({ strict: true, allErrors: true, useDefaults: false, allowUnionTypes: true });
addFormats(ajv);
ajv.addKeyword("x-rpc-version");
ajv.addKeyword("x-stability");
ajv.addKeyword("x-since");
ajv.addKeyword("x-deprecated");
ajv.addSchema(schemaJson);
const SCHEMA_ID: string = (schemaJson as any).$id;

const cache = new Map<string, ValidateFunction>();
function validator(pointer: string): ValidateFunction {
  let v = cache.get(pointer);
  if (!v) { v = ajv.compile({ $ref: `${SCHEMA_ID}#${pointer}` }); cache.set(pointer, v); }
  return v;
}

export type Validation = { ok: true } | { ok: false; errors: string[] };
function run(v: ValidateFunction, value: unknown): Validation {
  if (v(value)) return { ok: true };
  return { ok: false, errors: (v.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim()) };
}
export function validateParams(method: string, value: unknown): Validation {
  if (!METHODS.includes(method)) return { ok: false, errors: [`unknown method ${method}`] };
  return run(validator(`/$defs/methods/${method}/params`), value);
}
export function validateResult(method: string, value: unknown): Validation {
  if (!METHODS.includes(method)) return { ok: false, errors: [`unknown method ${method}`] };
  return run(validator(`/$defs/methods/${method}/result`), value);
}
export function validateNotification(name: string, value: unknown): Validation {
  if (!NOTIFICATIONS.includes(name)) return { ok: false, errors: [`unknown notification ${name}`] };
  return run(validator(`/$defs/notifications/${name}`), value);
}
export function validateJournalLine(value: unknown): Validation { return run(validator("/$defs/JournalLine"), value); }
export function validateRequest(value: unknown): Validation { return run(validator("/$defs/Request"), value); }
export function validateErrorObject(value: unknown): Validation { return run(validator("/$defs/ErrorObject"), value); }

export interface Fixtures {
  methods: Record<string, { params: unknown; result: unknown }>;
  errors: Record<string, { jsonrpc: "2.0"; id: number | string; error: { code: number; message: string; data?: { error: string; reason?: string; detail?: string; ids?: Record<string, string> } } }>;
  notifications: Record<string, unknown>;
}
export function loadFixtures(root = join(here, "..", "fixtures")): Fixtures {
  const read = (dir: string) => Object.fromEntries(readdirSync(join(root, dir)).filter((f) => f.endsWith(".json")).map((f) => [f.slice(0, -5), JSON.parse(readFileSync(join(root, dir, f), "utf8"))]));
  return { methods: read("methods"), errors: read("errors"), notifications: read("notifications") } as Fixtures;
}

export interface Deprecation { since: string; removeAfter: string; replacement: string }
export interface CapabilityEntry { stability: "experimental" | "stable"; since: string; deprecated?: Deprecation }
export interface Capabilities {
  methods: Record<string, CapabilityEntry>;
  notifications: Record<string, CapabilityEntry>;
  extensionPoints: Record<string, CapabilityEntry>;
  features: readonly string[];
}

/** Builds `Capabilities` from the schema's own x-stability/x-since/x-deprecated annotations (ADR-016 §3): the
 *  keys and their entries always match what this rpc-schema version actually ships, never a hand-kept list. */
export function buildCapabilities(features: readonly string[]): Capabilities {
  const schema = SCHEMA as any;
  const entry = (def: { "x-stability": "experimental" | "stable"; "x-since": string; "x-deprecated"?: Deprecation }): CapabilityEntry => ({
    stability: def["x-stability"],
    since: def["x-since"],
    ...(def["x-deprecated"] ? { deprecated: def["x-deprecated"] } : {}),
  });
  const map = (defs: Record<string, any>): Record<string, CapabilityEntry> => Object.fromEntries(Object.entries(defs).map(([name, def]) => [name, entry(def)]));
  return {
    methods: map(schema.$defs.methods),
    notifications: map(schema.$defs.notifications),
    extensionPoints: {},
    features: [...features].sort(),
  };
}
