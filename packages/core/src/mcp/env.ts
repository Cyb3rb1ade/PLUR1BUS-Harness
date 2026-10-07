import { isSensitiveName } from "./redact.ts";
import type { McpTransportConfig } from "./types.ts";

export interface ChildEnv {
  /** Declared variables only; the SDK adds its own minimal inherited set (PATH, HOME, USER, ...). */
  env: Record<string, string>;
  /** Names of everything declared, for logs. Values are never logged (ADR-014 §7). */
  names: string[];
  /** Values to hand to the redactor: sensitive-looking names and every `fromHost` value. */
  secrets: string[];
  /** `fromHost` names that were not set in the host environment. */
  missing: string[];
}

export function buildChildEnv(t: Extract<McpTransportConfig, { type: "stdio" }>, host: NodeJS.ProcessEnv): ChildEnv {
  const env: Record<string, string> = {};
  const secrets: string[] = [];
  const missing: string[] = [];
  for (const [k, v] of Object.entries(t.env)) {
    env[k] = v;
    if (isSensitiveName(k)) secrets.push(v);
  }
  for (const k of t.fromHost) {
    const v = host[k];
    if (v === undefined) { missing.push(k); continue; }
    env[k] = v;
    secrets.push(v); // RULING: everything copied from the harness's own environment is treated as secret
  }
  return { env, names: Object.keys(env).sort(), secrets, missing };
}
