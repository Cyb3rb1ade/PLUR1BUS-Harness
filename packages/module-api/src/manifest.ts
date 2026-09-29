import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import schemaJson from "../schema/manifest.schema.json" with { type: "json" };

/** D14 `module.json`. `schema/manifest.schema.json` is the one source; the supervisor (Rust) embeds the same file. */
export const MANIFEST_SCHEMA = schemaJson as Record<string, any>;

/** Current module API major (B12). A module's `apiVersion` is supported when it is this or the one before. */
export const MODULE_API_VERSION = 1;

export interface ModuleManifest {
  name: string;
  version: string;
  apiVersion: string;
  entry: string;
  needs: string[];
  provides: string[];
  consumes: string[];
  implements: string[];
  extensionPoints: Record<string, "chain" | "collect">;
  scope: "installation" | "agent";
  restart: "on-failure" | "always" | "never";
  lifeline: boolean;
  priority: number;
  configSchema?: Record<string, unknown>;
  /** X1-R22: absent means `module`. */
  kind?: "module" | "channel";
}

/** `n` and `n−1` (B12): `v` must be a canonical decimal (no sign, no leading zero). */
export function apiVersionSupported(v: string, current: number = MODULE_API_VERSION): boolean {
  if (!/^[1-9][0-9]*$/.test(v)) return false;
  const n = Number(v);
  return n === current || (n === current - 1 && n >= 1);
}

let validateFn: ValidateFunction | undefined; // compiled on first use: importing module-api stays cheap

export function validateManifest(v: unknown): { ok: true; manifest: ModuleManifest } | { ok: false; errors: string[] } {
  if (!validateFn) {
    const ajv = new ((Ajv2020 as any).default ?? Ajv2020)({ strict: true, allErrors: true, useDefaults: true, strictSchema: false });
    ajv.addKeyword("x-stability");
    validateFn = ajv.compile(MANIFEST_SCHEMA) as ValidateFunction;
  }
  const copy = structuredClone(v);
  if (validateFn(copy)) return { ok: true, manifest: copy as ModuleManifest };
  return { ok: false, errors: (validateFn.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}${e.params && "additionalProperty" in e.params ? ` (${(e.params as any).additionalProperty})` : ""}`.trim()) };
}
