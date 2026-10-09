import { AuthError } from "./errors.ts";

/** ADR-005 "Auth kinds". `external_cli` is the delegated-binary pattern (a vendor CLI owns the login; the harness
 *  holds no credential). D110's federated supplier is dispatched through openai-auth; minted_ephemeral is derived by voice, never a stored profile. */
export const AUTH_KINDS = ["api_key", "oauth_pkce", "device_code", "adc", "external_cli", "federated_token"] as const;
export type AuthKind = (typeof AUTH_KINDS)[number];
export const POLICY_STATUSES = ["allowed", "restricted", "prohibited"] as const;
export type PolicyStatus = (typeof POLICY_STATUSES)[number];
export const CAPABILITIES = ["chat", "embedding", "rerank"] as const;

export interface AuthProfile {
  id: string;
  display_name: string;
  kind: AuthKind;
  capabilities: Array<(typeof CAPABILITIES)[number]>;
  base_url?: string;
  /** e.g. `Authorization: Bearer {token}` or `x-api-key: {token}`. */
  auth_header_scheme: string;
  extra_headers?: Record<string, string>;
  /** Canonical flow URLs; legacy ADR spellings remain accepted, conflicting aliases are refused. */
  authorizeUrl?: string;
  tokenUrl?: string;
  deviceUrl?: string;
  audience?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  device_authorization_endpoint?: string;
  revocation_endpoint?: string;
  scopes?: string[];
  client_registration?: "none" | "static" | "dynamic" | "dynamic_on_authorize";
  client_id?: string;
  redirect?: { type: "loopback"; port?: number };
  pkce?: "S256";
  refresh?: { mode: "rotating" | "static"; refresh_skew_seconds?: number };
  policy_status: PolicyStatus;
  policy_source: string;
  policy_checked: string;
  person_bound?: boolean;
  /** Keychain handle for a single credential. Pools list their own handles. Never a value. */
  secret_ref?: string;
}

const KEYS = new Set(["id", "display_name", "kind", "capabilities", "base_url", "auth_header_scheme", "extra_headers", "authorizeUrl", "tokenUrl", "deviceUrl", "audience", "authorization_endpoint", "token_endpoint", "device_authorization_endpoint", "revocation_endpoint", "scopes", "client_registration", "client_id", "redirect", "pkce", "refresh", "policy_status", "policy_source", "policy_checked", "person_bound", "secret_ref"]);
const ID_RE = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
export const DEFAULT_REFRESH_SKEW_SECONDS = 120; // ADR-005 "Token lifecycle"

function bad(id: unknown, why: string): never {
  throw new AuthError("invalid_profile", `Auth profile is invalid: ${why}.`);
}
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
function url(id: string, name: string, v: unknown, https = true) {
  if (v === undefined) return;
  if (!isStr(v)) bad(id, `${name} must be a URL string`);
  let u: URL;
  try { u = new URL(v); } catch { bad(id, `${name} is not a URL`); }
  if (u.username || u.password) bad(id, `${name} must not carry credentials`);
  const loop = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (https && u.protocol !== "https:" && !(u.protocol === "http:" && loop)) bad(id, `${name} must be https`);
}

/** Closed validation: an unknown field is refused (so a secret value cannot ride along under an invented name, and a
 *  later-task field is not silently half-supported). */
export function validateProfile(input: unknown): AuthProfile {
  if (!input || typeof input !== "object" || Array.isArray(input)) bad(undefined, "not an object");
  const p = input as Record<string, unknown>;
  const id = p.id;
  if (!isStr(id) || !ID_RE.test(id)) bad(id, "id must match " + ID_RE.source);
  if (id === 'openai:chatgpt-oauth-restricted') bad(id, 'superseded by openai:chatgpt-plan; sign in with ChatGPT again');
  for (const k of Object.keys(p)) if (!KEYS.has(k)) bad(id, "unknown field");
  if (!isStr(p.display_name)) bad(id, "display_name missing");
  if (!AUTH_KINDS.includes(p.kind as AuthKind)) bad(id, "kind must be one of " + AUTH_KINDS.join("|"));
  if (!POLICY_STATUSES.includes(p.policy_status as PolicyStatus)) bad(id, "policy_status missing");
  if (p.policy_status === "prohibited") bad(id, "policy_status is prohibited; a prohibited profile is never loadable (ADR-005)");
  if (!isStr(p.policy_source)) bad(id, "policy_source missing");
  if (!isStr(p.policy_checked) || (!/^\d{4}-\d{2}-\d{2}$/.test(p.policy_checked) || !Number.isFinite(Date.parse(p.policy_checked)) || new Date(p.policy_checked).toISOString().slice(0, 10) !== p.policy_checked)) bad(id, "policy_checked must be YYYY-MM-DD");
  if (!Array.isArray(p.capabilities) || p.capabilities.length === 0 || !p.capabilities.every((c) => (CAPABILITIES as readonly unknown[]).includes(c))) bad(id, "capabilities must list chat|embedding|rerank");
  if (!isStr(p.auth_header_scheme)) bad(id, "auth_header_scheme missing");
  parseHeaderScheme(id, p.auth_header_scheme);
  for (const [name, v] of Object.entries((p.extra_headers ?? {}) as Record<string, unknown>)) {
    if (typeof v !== "string" || /[\r\n]/.test(name + v) || !/^[A-Za-z0-9-]+$/.test(name)) bad(id, "extra_headers entry is malformed");
  }
  for (const f of ["authorizeUrl", "tokenUrl", "deviceUrl", "base_url", "authorization_endpoint", "token_endpoint", "device_authorization_endpoint", "revocation_endpoint"]) url(id, f, p[f]);
  const kind = p.kind as AuthKind;
  if (kind === "oauth_pkce" && !(isStr(p.authorizeUrl ?? p.authorization_endpoint) && isStr(p.tokenUrl ?? p.token_endpoint))) bad(id, "oauth_pkce needs authorization_endpoint and token_endpoint");
  if (kind === "device_code" && !(isStr(p.deviceUrl ?? p.device_authorization_endpoint) && isStr(p.tokenUrl ?? p.token_endpoint))) bad(id, "device_code needs device_authorization_endpoint and token_endpoint");
  for (const [alias, legacy] of [["authorizeUrl", "authorization_endpoint"], ["tokenUrl", "token_endpoint"], ["deviceUrl", "device_authorization_endpoint"]]) {
    if (p[alias!] !== undefined && p[legacy!] !== undefined && p[alias!] !== p[legacy!]) bad(id, "conflicting endpoint aliases");
  }
  if (p.scopes !== undefined && (!Array.isArray(p.scopes) || !p.scopes.every(s => typeof s === "string" && /^[\x21\x23-\x5b\x5d-\x7e]+$/.test(s)))) bad(id, "scopes must be OAuth scope tokens");
  for (const f of ["client_id", "audience", "secret_ref"]) if (p[f] !== undefined && (!isStr(p[f]) || /[\r\n]/.test(p[f] as string))) bad(id, "invalid identifier");
  if (p.client_registration !== undefined && !["none", "static", "dynamic", "dynamic_on_authorize"].includes(p.client_registration as string)) bad(id, "invalid client_registration");
  if (p.person_bound !== undefined && typeof p.person_bound !== "boolean") bad(id, "person_bound must be boolean");
  if (p.redirect !== undefined) {
    const r = p.redirect as Record<string, unknown>;
    if (!r || typeof r !== "object" || Array.isArray(r) || r.type !== "loopback" || Object.keys(r).some(k => !["type", "port"].includes(k))) bad(id, "invalid loopback redirect");
    if (r.port !== undefined && (!Number.isInteger(r.port) || Number(r.port) < 0 || Number(r.port) > 65535)) bad(id, "invalid redirect port");
  }
  if (p.pkce !== undefined && p.pkce !== "S256") bad(id, "pkce must be S256");
  if (p.refresh !== undefined) {
    const r = p.refresh as Record<string, unknown>;
    if (!r || typeof r !== "object" || Array.isArray(r) || Object.keys(r).some(k => !["mode", "refresh_skew_seconds"].includes(k)) || (r.mode !== "rotating" && r.mode !== "static")) bad(id, "refresh.mode must be rotating|static");
    if (r.refresh_skew_seconds !== undefined && (!Number.isInteger(r.refresh_skew_seconds) || (r.refresh_skew_seconds as number) < 0)) bad(id, "refresh_skew_seconds must be a non-negative integer");
  }
  return p as unknown as AuthProfile;
}

/** `Name: value with {token}` into its parts. A CR/LF or a scheme without `{token}` is refused (header injection). */
export function parseHeaderScheme(id: string, scheme: string): { name: string; template: string } {
  const m = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(scheme);
  if (!m || /[\r\n]/.test(scheme) || !m[2]!.includes("{token}")) bad(id, "auth_header_scheme must be `Name: value` with {token}");
  return { name: m[1]!, template: m[2]! };
}

/** Load a catalogue: every profile is validated; a duplicate id is refused. One bad profile fails the load. */
export function loadProfiles(input: unknown[]): Map<string, AuthProfile> {
  const out = new Map<string, AuthProfile>();
  for (const raw of input) {
    const p = validateProfile(raw);
    if (out.has(p.id)) bad(p.id, "duplicate id");
    out.set(p.id, p);
  }
  return out;
}

export function refreshSkewMs(p: AuthProfile): number { return (p.refresh?.refresh_skew_seconds ?? DEFAULT_REFRESH_SKEW_SECONDS) * 1000; }
export function isRefreshable(p: AuthProfile): boolean { return p.kind === "oauth_pkce" || p.kind === "device_code"; }

export const authorizeUrl = (p: AuthProfile): string | undefined => p.authorizeUrl ?? p.authorization_endpoint;
export const tokenUrl = (p: AuthProfile): string | undefined => p.tokenUrl ?? p.token_endpoint;
export const deviceUrl = (p: AuthProfile): string | undefined => p.deviceUrl ?? p.device_authorization_endpoint;
