import { DEFAULT_INHERITED_ENV_VARS } from "@modelcontextprotocol/sdk/client/stdio.js";
import { isSensitiveName } from "./redact.ts";
import type { McpServerDefinition, McpTransportConfig } from "./types.ts";

/** A spawn-only environment. The owner revokes its leases and clears values at the synchronous spawn boundary. */
export interface LeasedLaunchEnvironment {
  readonly env: Record<string, string>;
  readonly isolated: true;
  /** Host authority recheck at the final synchronous spawn boundary. Contains no credentials. */
  validate?(): void;
  release(): void;
}

/** Host-only packaged-extension resolver; undefined retains the legacy manually configured environment. */
export type McpLaunchEnvironment = (server: McpServerDefinition, signal?: AbortSignal) =>
  Promise<LeasedLaunchEnvironment | undefined>;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const INJECTION_ENV = /^(LD_.*|DYLD_.*|NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|PATH|PATHEXT|PYTHONSTARTUP|PYTHONPATH|PYTHONHOME|PERL5OPT|PERL5LIB|RUBYOPT|RUBYLIB|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS)$/i;

/** Copies the packaged server's complete environment without inheriting host or legacy definition variables. */
export function isolatedStdioEnv(values: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(values)) {
    if (!ENV_NAME.test(key) || INJECTION_ENV.test(key) || typeof value !== "string" || value.includes("\0")) {
      throw new Error("invalid packaged MCP environment");
    }
    env[key] = value;
  }
  return env;
}

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

/** Variables that decide which file a command name resolves to. Never taken from a server definition, whatever the letter case. */
const RESOLUTION_ENV = /^(path|pathext)$/i;

/**
 * The environment a stdio server is spawned with: the SDK's minimal inherited set, then the variables the definition
 * declares, except those that steer command resolution. The allowlist names a program, so PATH is always the harness's
 * own (audit mcp #2); config.ts refuses such a declaration up front and this keeps the rule for any other caller.
 */
export function stdioSpawnEnv(t: Extract<McpTransportConfig, { type: "stdio" }>, host: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of DEFAULT_INHERITED_ENV_VARS) {
    const value = host[key] ?? process.env[key];
    if (value !== undefined && !value.startsWith("()")) env[key] = value;
  }
  for (const [k, v] of Object.entries(buildChildEnv(t, host).env)) if (!RESOLUTION_ENV.test(k)) env[k] = v;
  return env;
}
