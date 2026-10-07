import { isAbsolute } from "node:path";
import { isSecretName } from "../secrets/types.ts";
import { McpClientError } from "./errors.ts";
import { DEFAULT_TIMEOUTS, type McpPolicy, type McpScope, type McpServerDefinition, type McpTimeouts, type McpTransportConfig, type McpTrust } from "./types.ts";

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const BARE_COMMAND = /^[A-Za-z0-9._+-]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,128}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_ARGS = 64;
const MAX_ARG_LENGTH = 4096;
const MIN_MS = 50;
const MAX_MS = 3_600_000;

// RULING: loader- and interpreter-injection variables are refused in a server definition (fail closed): they turn
// "run this allowlisted command" into "run this command with attacker-chosen code".
const FORBIDDEN_ENV = /^(LD_.*|DYLD_.*|NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|PYTHONSTARTUP|PYTHONPATH|PERL5OPT|RUBYOPT|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS)$/i;

const invalid = (name: string | null, msg: string): never => { throw new McpClientError("invalid-config", msg, { server: name }); };

function str(v: unknown, what: string, name: string | null): string {
  if (typeof v !== "string" || v.length === 0 || CONTROL.test(v)) invalid(name, `${what} must be a non-empty string without control characters`);
  return v as string;
}

function validateScope(raw: unknown, name: string): McpScope {
  const r = (raw ?? { kind: "installation" }) as { kind?: unknown; agentId?: unknown };
  if (r.kind === "installation") return { kind: "installation" };
  if (r.kind === "agent") {
    const agentId = str(r.agentId, "scope.agentId", name);
    if (agentId.length > 128) invalid(name, "scope.agentId is too long");
    return { kind: "agent", agentId };
  }
  return invalid(name, "scope.kind must be \"installation\" or \"agent\"");
}

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

function validateTransport(raw: unknown, name: string, policy: Pick<McpPolicy, "allowedCommands">): McpTransportConfig {
  const t = raw as Record<string, unknown> | null;
  if (t === null || typeof t !== "object") return invalid(name, "transport is required");
  if (t.type === "stdio") {
    const command = str(t.command, "transport.command", name);
    // ADR-014 §7: stdio only from an allowlisted command, spawned directly (no shell) with an argument array.
    if (isAbsolute(command)) {
      if (!policy.allowedCommands.includes(command)) throw new McpClientError("not-allowed", `command is not on the allowlist: ${command}`, { server: name });
    } else {
      if (!BARE_COMMAND.test(command)) invalid(name, "transport.command must be a bare command name or an absolute path, with no arguments inside it");
      if (!policy.allowedCommands.includes(command)) throw new McpClientError("not-allowed", `command is not on the allowlist: ${command}`, { server: name });
    }
    const argsRaw = t.args ?? [];
    if (!Array.isArray(argsRaw) || argsRaw.length > MAX_ARGS) return invalid(name, `transport.args must be an array of at most ${MAX_ARGS} strings`);
    const args = argsRaw.map((a) => {
      if (typeof a !== "string" || a.includes("\u0000") || a.length > MAX_ARG_LENGTH) invalid(name, "transport.args entries must be strings without NUL, at most 4096 characters");
      return a as string;
    });
    const envRaw = (t.env ?? {}) as Record<string, unknown>;
    if (typeof envRaw !== "object" || envRaw === null || Array.isArray(envRaw)) return invalid(name, "transport.env must be an object");
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(envRaw)) {
      if (!ENV_NAME.test(k)) invalid(name, `transport.env has an invalid variable name: ${k}`);
      if (FORBIDDEN_ENV.test(k)) invalid(name, `transport.env may not set ${k}`);
      if (typeof v !== "string" || v.includes("\u0000")) invalid(name, `transport.env.${k} must be a string`);
      env[k] = v as string;
    }
    const fromRaw = t.fromHost ?? [];
    if (!Array.isArray(fromRaw)) return invalid(name, "transport.fromHost must be an array of variable names");
    const fromHost = fromRaw.map((k) => {
      if (typeof k !== "string" || !ENV_NAME.test(k) || FORBIDDEN_ENV.test(k)) invalid(name, "transport.fromHost entries must be plain variable names");
      return k as string;
    });
    if (t.cwd !== undefined && (typeof t.cwd !== "string" || !isAbsolute(t.cwd) || CONTROL.test(t.cwd))) invalid(name, "transport.cwd must be an absolute path");
    return { type: "stdio", command, args, env, fromHost, ...(typeof t.cwd === "string" ? { cwd: t.cwd } : {}) };
  }
  if (t.type === "http") {
    const urlStr = str(t.url, "transport.url", name);
    let u: URL;
    try { u = new URL(urlStr); } catch { return invalid(name, "transport.url is not a valid URL"); }
    if (u.username !== "" || u.password !== "") invalid(name, "transport.url must not carry credentials");
    // RULING: plain http only for loopback; everything else must be https.
    if (u.protocol === "http:") { if (!isLoopbackHost(u.hostname)) invalid(name, "transport.url must be https unless it is a loopback address"); }
    else if (u.protocol !== "https:") invalid(name, "transport.url must be http(s)");
    const hRaw = (t.headers ?? {}) as Record<string, unknown>;
    if (typeof hRaw !== "object" || hRaw === null || Array.isArray(hRaw)) return invalid(name, "transport.headers must be an object");
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(hRaw)) {
      if (!HEADER_NAME.test(k)) invalid(name, `transport.headers has an invalid header name: ${k}`);
      if (typeof v !== "string" || CONTROL.test(v)) invalid(name, `transport.headers.${k} must be a string without control characters`);
      headers[k] = v as string;
    }
    return { type: "http", url: u.toString(), headers };
  }
  return invalid(name, "transport.type must be \"stdio\" or \"http\"");
}

function validateTimeouts(raw: unknown, name: string): McpTimeouts {
  const out = { ...DEFAULT_TIMEOUTS };
  if (raw === undefined) return out;
  if (typeof raw !== "object" || raw === null) return invalid(name, "timeouts must be an object");
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(k in DEFAULT_TIMEOUTS)) invalid(name, `unknown timeout: ${k}`);
    if (typeof v !== "number" || !Number.isInteger(v) || v < MIN_MS || v > MAX_MS) invalid(name, `timeouts.${k} must be an integer from ${MIN_MS} to ${MAX_MS}`);
    out[k as keyof McpTimeouts] = v as number;
  }
  return out;
}

export function validateDefinition(raw: unknown, policy: Pick<McpPolicy, "allowedCommands">): McpServerDefinition {
  if (raw === null || typeof raw !== "object") return invalid(null, "a server definition must be an object");
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" && NAME.test(r.name) ? r.name : invalid(null, "name must match [a-z0-9][a-z0-9_-]{0,63}");
  const trust: McpTrust = r.trust === undefined ? "untrusted" : r.trust === "operator-vetted" || r.trust === "untrusted" ? r.trust : invalid(name, "trust must be \"untrusted\" or \"operator-vetted\"");
  let reconnect: McpServerDefinition["reconnect"];
  if (r.reconnect !== undefined) {
    const p = r.reconnect as Record<string, unknown>;
    if (!p || typeof p !== "object" || Array.isArray(p) || Object.keys(p).some(k => !["maxAttempts", "initialDelayMs", "maxDelayMs"].includes(k)) ||
        !Number.isInteger(p.maxAttempts) || Number(p.maxAttempts) < 0 || Number(p.maxAttempts) > 10 ||
        !Number.isInteger(p.initialDelayMs) || Number(p.initialDelayMs) < 50 || Number(p.initialDelayMs) > 60000 ||
        !Number.isInteger(p.maxDelayMs) || Number(p.maxDelayMs) < Number(p.initialDelayMs) || Number(p.maxDelayMs) > 60000) invalid(name, "reconnect policy is invalid");
    reconnect = { maxAttempts: Number(p.maxAttempts), initialDelayMs: Number(p.initialDelayMs), maxDelayMs: Number(p.maxDelayMs) };
  }
  if (r.authSecret !== undefined && !isSecretName(r.authSecret)) invalid(name, "authSecret must be a secret name");
  return { ...(reconnect ? { reconnect } : {}), ...(typeof r.authSecret === "string" ? { authSecret: r.authSecret } : {}), name, scope: validateScope(r.scope, name), transport: validateTransport(r.transport, name, policy), trust, timeouts: validateTimeouts(r.timeouts, name) };
}
