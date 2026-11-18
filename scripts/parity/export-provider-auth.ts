// Parity vectors for the provider auth package (P4-K K4, plan P4-23): `packages/core/src/auth/`. Mode V for the decisions
// (the login ladder and its environment predicates, profile validation, the credential pool and its cooldown table, the
// redactor, the stored OAuth record) and mode W for every exchange with a token endpoint (the token POST boundary, the
// refresh owner, the credentials provider, the login flows and the Google ADC source).
//
// MODE W AT THE PORT (ruling R-K-14). The TypeScript code runs against a scripted egress: `createOAuthHttp` hands its request to
// `egress.request`, and the stand-in here first runs the checks the guarded client makes before any I/O (URL, scheme, URL
// credentials) and the real dry run of `createEgress(...).decide` over a scripted resolver, then records the request (method, URL,
// headers, body and the limits it was given) and answers from the script. The Rust replay sends the same requests through its
// own `OAuthHttp` over `egress::service::Egress` and an HTTP port double that compares each request and returns the recorded
// answer. Randomness (`randomBytes` of `node:crypto`: `state`, the PKCE verifier) is scripted as in `k3b-support.ts`; the
// refresh jitter is the `random` port. The loopback listener of the PKCE flow is the real one on 127.0.0.1 (port 0); the
// callbacks are real requests to it, recorded with the status each got.
//
// SECRETS. Every token, code, verifier, key and assertion here is invented test material made by this file. Any string that
// holds one is stored as `{ "parts": [...] }` (pieces of at most eight characters), so the repository's secret scan never sees
// a whole one; the replay joins the parts.
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/parity/export-provider-auth.ts [--check]
import { createPrivateKey } from "node:crypto";
import { inspect } from "node:util";
import { fileURLToPath } from "node:url";
import { canOpenGraphicalBrowser, isRemoteSession, type EnvSnapshot } from "../../packages/core/src/auth/env.ts";
import { planLogin } from "../../packages/core/src/auth/ladder.ts";
import { AUTH_KINDS, authorizeUrl, deviceUrl, isRefreshable, loadProfiles, parseHeaderScheme, refreshSkewMs, tokenUrl, validateProfile, type AuthProfile } from "../../packages/core/src/auth/profile.ts";
import { CredentialPool, classifyFailure, COOLDOWN_MS, RETRY_AFTER_MAX_MS, RETRY_AFTER_MIN_MS, type Strategy } from "../../packages/core/src/auth/pool.ts";
import { safeFields, scrub } from "../../packages/core/src/auth/redact.ts";
import { decodeRecord, encodeRecord, InMemorySecretStore } from "../../packages/core/src/auth/secret-store.ts";
import { clientFields, createOAuthHttp, HttpRefresher, OAuthHttpError, parseTokenResponse } from "../../packages/core/src/auth/http.ts";
import { RefreshOwner, RefreshRejected, type RefreshTimer } from "../../packages/core/src/auth/refresh.ts";
import { createCredentialsProvider } from "../../packages/core/src/auth/credentials.ts";
import { login, type LoginOptions } from "../../packages/core/src/auth/login.ts";
import { GoogleAdc } from "../../packages/core/src/auth/adc.ts";
import { AuthError } from "../../packages/core/src/auth/errors.ts";
import { createEgress } from "../../packages/core/src/egress/service.ts";
import { WebFailure } from "../../packages/core/src/tools/web/failure.ts";
import { installScriptedRandom } from "./k3b-support.ts";
import { exporterMain } from "./lib.mjs";

// --- secrets in pieces -----------------------------------------------------------------------------------------------------------
/** Markers every invented secret carries, so the pieces rule and a leak check can find them. */
export const CANARY = "CANARY";
const SECRETISH = /CANARY|PRIVATE KEY|eyJ|assertion=|code_verifier=|state=|BEGIN/;
const parts = (s: string) => ({ parts: s.match(/[\s\S]{1,8}/g) ?? [""] });
/** Every string leaf that holds secret-shaped material becomes `{ parts }`; everything else is unchanged. */
export function piecesDeep(v: unknown): unknown {
  if (typeof v === "string") return SECRETISH.test(v) ? parts(v) : v;
  if (Array.isArray(v)) return v.map(piecesDeep);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, piecesDeep(x)]));
  return v;
}

/** What a thrown value looks like in a vector: the auth code and the fields an `AuthError` carries, or the class and code. */
export function errOf(e: unknown): Record<string, unknown> {
  if (e instanceof AuthError) {
    return { kind: "auth", code: e.code, message: e.message, retryable: e.retryable, ...(e.profileId !== undefined ? { profileId: e.profileId } : {}), ...(e.credentialId !== undefined ? { credentialId: e.credentialId } : {}), ...(e.retryAfterMs !== undefined ? { retryAfterMs: e.retryAfterMs } : {}), ...(e.action !== undefined ? { action: e.action } : {}) };
  }
  if (e instanceof OAuthHttpError) return { kind: "oauth-http", code: e.code, retryable: e.retryable, message: e.message };
  if (e instanceof RefreshRejected) return { kind: "refresh-rejected", reason: e.reason };
  return { kind: "other", name: (e as Error)?.name ?? typeof e };
}

/** A clock the vector moves by hand. */
class Clock { t: number; constructor(t = 1_000_000_000_000) { this.t = t; } now() { return this.t; } }

// --- the scripted egress (mode W at the HTTP port) ------------------------------------------------------------------------------
export type Scripted = { status: number; body: string; headers?: Record<string, string> } | { fail: "too-large" | "unsupported-type" | "egress-denied" | "hang" | "error" };
export const EGRESS = { allowHosts: ["idp.example.test", "accounts.example.test", "oauth2.example.test"], allowPorts: [443], allowLoopback: false };
/** The scripted resolver: one public address for every name, a private one for `private.example.test`. */
export const RESOLVE: Record<string, string> = { "private.example.test": "10.0.0.7" };
const PUBLIC = "93.184.216.34";
export class Wire {
  readonly requests: unknown[] = [];
  readonly script: Scripted[];
  readonly egressConfig: unknown;
  readonly real;
  constructor(script: Scripted[], egressConfig: unknown = EGRESS) {
    this.script = [...script];
    this.egressConfig = egressConfig;
    this.real = createEgress({ config: () => egressConfig as never, resolver: async (h: string) => [{ address: RESOLVE[h] ?? PUBLIC, family: 4 as const }] });
  }
  egress() {
    return {
      request: async (raw: string, o: Record<string, any>) => {
        // The checks `guardedRequest` makes before any I/O (tools/web/http.ts `parseTarget`), then the gate and the SSRF check.
        let url: URL;
        try { url = new URL(raw); } catch { throw new WebFailure("invalid-url", "not a valid URL"); }
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new WebFailure("egress-denied", "scheme");
        if (url.username !== "" || url.password !== "") throw new WebFailure("invalid-url", "credentials");
        const d = await this.real.decide(raw);
        if (!d.allowed) throw new WebFailure(d.reason === "private-address" || d.reason === "not-found" || d.reason === "invalid-url" ? d.reason : "egress-denied", "denied");
        this.requests.push({
          method: o.method ?? "GET", url: raw,
          headers: { "user-agent": o.userAgent, ...(o.accept !== undefined ? { accept: o.accept } : {}), ...(o.headers ?? {}) },
          body: o.body ?? "",
          limits: { maxBytes: o.maxBytes ?? null, errorBodyBytes: o.errorBodyBytes ?? null, timeoutMs: o.timeoutMs ?? null, redirect: o.redirect ?? null },
          pin: { host: url.hostname, address: d.address, family: d.family, port: d.port },
        });
        const s = this.script.shift();
        if (!s) throw new Error("script exhausted");
        if ("fail" in s) {
          if (s.fail === "hang") return new Promise(() => {});
          if (s.fail === "error") throw new Error("socket closed");
          throw new WebFailure(s.fail, "scripted");
        }
        return { url: raw, status: s.status, headers: s.headers ?? {}, body: Buffer.from(s.body, "utf8"), redirects: [] };
      },
    };
  }
}
const json = (status: number, body: unknown): Scripted => ({ status, body: JSON.stringify(body) });

// --- V: environment predicates and the login ladder ------------------------------------------------------------------------------
const COMMON = { display_name: "Example", capabilities: ["chat"], auth_header_scheme: "Authorization: Bearer {token}", policy_status: "allowed", policy_source: "https://e.test", policy_checked: "2026-09-22" };
const LADDER_PROFILES: Record<string, Record<string, unknown>> = {
  key: { ...COMMON, id: "e:key", kind: "api_key" },
  adc: { ...COMMON, id: "e:adc", kind: "adc" },
  cli: { ...COMMON, id: "e:cli", kind: "external_cli" },
  fed: { ...COMMON, id: "e:fed", kind: "federated_token" },
  dev: { ...COMMON, id: "e:dev", kind: "device_code", device_authorization_endpoint: "https://e.test/d", token_endpoint: "https://e.test/t" },
  pkce: { ...COMMON, id: "e:pkce", kind: "oauth_pkce", authorization_endpoint: "https://e.test/a", token_endpoint: "https://e.test/t" },
  pkceDev: { ...COMMON, id: "e:pd", kind: "oauth_pkce", authorization_endpoint: "https://e.test/a", token_endpoint: "https://e.test/t", device_authorization_endpoint: "https://e.test/d" },
  pkceDevAlias: { ...COMMON, id: "e:pda", kind: "oauth_pkce", authorizeUrl: "https://e.test/a", tokenUrl: "https://e.test/t", deviceUrl: "https://e.test/d" },
};
const ENVS: Record<string, EnvSnapshot> = {};
for (const platform of ["linux", "darwin", "win32", "freebsd"] as NodeJS.Platform[]) {
  for (const [name, env] of Object.entries<Record<string, string>>({
    bare: {}, display: { DISPLAY: ":0" }, wayland: { WAYLAND_DISPLAY: "wayland-0" }, emptyDisplay: { DISPLAY: "" },
    ssh: { SSH_CONNECTION: "1 2 3 4", DISPLAY: ":0" }, sshClient: { SSH_CLIENT: "x" }, sshTty: { SSH_TTY: "/dev/pts/1" }, sshEmpty: { SSH_CONNECTION: "" },
    codespaces: { CODESPACES: "true" }, cloudShell: { CLOUD_SHELL: "1" }, gitpod: { GITPOD_WORKSPACE_ID: "w" }, vscode: { VSCODE_IPC_HOOK_CLI: "/x" },
    containers: { REMOTE_CONTAINERS: "true" }, remoteAgent: { CLAUDE_CODE_REMOTE: "1" }, lower: { ssh_connection: "1 2 3 4", display: ":0" },
  })) for (const tty of [true, false]) ENVS[`${platform}-${name}-${tty ? "tty" : "notty"}`] = { env, platform, stdoutIsTTY: tty };
}
function ladderCases() {
  const predicates = Object.entries(ENVS).map(([name, s]) => ({ name, env: s.env, platform: s.platform, tty: s.stdoutIsTTY, graphical: canOpenGraphicalBrowser(s), remote: isRemoteSession(s) }));
  const plans: unknown[] = [];
  for (const [p, raw] of Object.entries(LADDER_PROFILES)) {
    const profile = validateProfile(raw);
    for (const [e, s] of Object.entries(ENVS)) {
      if (!e.endsWith("-tty")) continue;
      for (const paste of [undefined, true, false]) {
        const plan = planLogin(profile, s, paste === undefined ? {} : { pasteCallback: paste });
        plans.push({ profile: p, env: e, ...(paste === undefined ? {} : { paste }), method: plan.method, fallbacks: plan.fallbacks, headless: plan.headless, sshHint: plan.sshHint ? plan.sshHint(47123) : null });
      }
    }
  }
  return { profiles: LADDER_PROFILES, envs: predicates, plans };
}

// --- V: profile validation ------------------------------------------------------------------------------------------------------
const BASE = { id: "example:key", display_name: "Example", kind: "api_key", capabilities: ["chat"], auth_header_scheme: "Authorization: Bearer {token}", policy_status: "allowed", policy_source: "https://example.test/terms", policy_checked: "2026-09-22", secret_ref: "ex/key" };
const OAUTH = { ...BASE, id: "example:oauth", kind: "oauth_pkce", authorization_endpoint: "https://example.test/auth", token_endpoint: "https://example.test/token", refresh: { mode: "rotating" } };
const DEVICE = { ...BASE, id: "example:dev", kind: "device_code", device_authorization_endpoint: "https://example.test/device", token_endpoint: "https://example.test/token" };
function profileInputs(): unknown[] {
  const out: unknown[] = [BASE, OAUTH, DEVICE, { ...BASE, kind: "adc" }, { ...BASE, kind: "external_cli" }, { ...BASE, kind: "federated_token" }, null, 1, "x", [], [BASE]];
  const over = (o: Record<string, unknown>, base: Record<string, unknown> = BASE) => out.push({ ...base, ...o });
  const without = (k: string, base: Record<string, unknown> = BASE) => { const c: Record<string, unknown> = { ...base }; delete c[k]; out.push(c); };
  for (const id of ["", "A", "a", "a".repeat(128), "a".repeat(129), "-a", "a b", "a:b.c-d_e", "a\n", "openai:chatgpt-oauth-restricted", 5, null]) over({ id });
  for (const k of ["id", "display_name", "kind", "capabilities", "auth_header_scheme", "policy_status", "policy_source", "policy_checked"]) without(k);
  over({ api_key: "CANARY-X" }); over({ wire_profile: "siwc" }); over({ __proto__x: 1 });
  for (const kind of ["api_key", "oauth", "token", "", 3]) over({ kind });
  for (const policy_status of ["allowed", "restricted", "prohibited", "Allowed", null]) over({ policy_status });
  for (const policy_checked of ["2026-09-22", "yesterday", "2026-02-30", "2026-02-29", "2024-02-29", "2026-13-01", "2026-00-10", "0000-01-01", "9999-12-31", "2026-9-22", " 2026-09-22", "2026-09-22\n", 20260922]) over({ policy_checked });
  for (const capabilities of [[], ["chat", "embedding", "rerank"], ["chat", "vision"], "chat", [null], ["chat", "chat"]]) over({ capabilities });
  for (const auth_header_scheme of ["x-api-key: {token}", "Authorization: Bearer x", "X: {token}\r\nEvil: 1", "X:{token}", "X :{token}", "X_Y: {token}", "X: \u2028{token}", "X: {token}\u2028", "X:\n{token}", "X: Bearer {token} {token}", "", 7, ": {token}", "Ä: {token}"]) over({ auth_header_scheme });
  for (const extra_headers of [{ "anthropic-version": "1" }, { "bad name": "1" }, { a: "x\ny" }, { a: 1 }, "ab", [ "v" ], 3, null, {}]) over({ extra_headers });
  for (const base_url of ["http://example.test/v1", "https://u:p@example.test/v1", "http://127.0.0.1:11434/v1", "http://localhost/v1", "http://LOCALHOST/v1", "http://[::1]:8/v1", "http://127.0.0.2/v1", "not a url", "", "ftp://example.test", "https://example.test/v1", { toString: () => "https://x" }]) over({ base_url });
  over({ token_endpoint: undefined }, OAUTH); without("token_endpoint", OAUTH); without("authorization_endpoint", OAUTH);
  over({ authorizeUrl: OAUTH.authorization_endpoint, tokenUrl: OAUTH.token_endpoint }, OAUTH);
  over({ authorizeUrl: "https://example.test/other" }, OAUTH); over({ tokenUrl: "https://example.test/other" }, OAUTH);
  { const c: Record<string, unknown> = { ...OAUTH, authorizeUrl: OAUTH.authorization_endpoint, tokenUrl: OAUTH.token_endpoint }; delete c.authorization_endpoint; delete c.token_endpoint; out.push(c); }
  without("device_authorization_endpoint", DEVICE); over({ deviceUrl: "https://example.test/device" }, DEVICE); over({ deviceUrl: "https://example.test/other" }, DEVICE);
  over({ token_endpoint: { toString: () => "https://example.test/token" } }, OAUTH);
  for (const scopes of [["read", "offline_access"], ["a b"], ['a"b'], ["a\\b"], [""], [], "read", [1], ["~!#[]"]]) over({ scopes });
  for (const f of ["client_id", "audience", "secret_ref"]) for (const v of ["x", "", "a\nb", 3]) over({ [f]: v });
  for (const client_registration of ["none", "static", "dynamic", "dynamic_on_authorize", "other"]) over({ client_registration });
  for (const person_bound of [true, false, "yes"]) over({ person_bound });
  for (const redirect of [{ type: "loopback" }, { type: "loopback", port: 0 }, { type: "loopback", port: 65535 }, { type: "loopback", port: 65536 }, { type: "loopback", port: -1 }, { type: "loopback", port: 1.5 }, { type: "web" }, { type: "loopback", extra: 1 }, null, []]) over({ redirect });
  for (const pkce of ["S256", "plain"]) over({ pkce });
  for (const refresh of [{ mode: "rotating" }, { mode: "static", refresh_skew_seconds: 0 }, { mode: "static", refresh_skew_seconds: 30 }, { mode: "static", refresh_skew_seconds: -1 }, { mode: "static", refresh_skew_seconds: 1.5 }, { mode: "other" }, { mode: "rotating", x: 1 }, null]) over({ refresh }, OAUTH);
  over({ revocation_endpoint: "http://example.test/r" });
  return out;
}
const JSONABLE = (v: unknown) => { try { return JSON.parse(JSON.stringify(v ?? null)); } catch { return null; } };
function profileCases() {
  const cases = profileInputs().filter((input) => JSONABLE(input) !== null || input === null).map((input) => {
    // Inputs that do not survive JSON (an object with a toString) are recorded as JSON reads them; the replay sees that.
    const asJson = JSONABLE(input);
    try {
      const p = validateProfile(asJson);
      return { input: asJson, ok: true, derived: { refreshSkewMs: refreshSkewMs(p), refreshable: isRefreshable(p), authorizeUrl: authorizeUrl(p) ?? null, tokenUrl: tokenUrl(p) ?? null, deviceUrl: deviceUrl(p) ?? null } };
    } catch (e) { return { input: asJson, ok: false, error: errOf(e) }; }
  });
  const schemes = ["x-api-key: {token}", "Authorization: Bearer {token}", "A:{token}", "A: \t {token}", "A:  {token} x {token}"].map((s) => ({ scheme: s, parsed: parseHeaderScheme("x", s) }));
  const catalogues = [[BASE, OAUTH, DEVICE], [BASE, BASE], [BASE, { ...OAUTH, policy_status: "prohibited" }], [], [{ ...BASE, id: "b:1" }, { ...BASE, id: "a:1" }]].map((list) => {
    try { return { input: list, ids: [...loadProfiles(list).keys()] }; } catch (e) { return { input: list, error: errOf(e) }; }
  });
  return { kinds: AUTH_KINDS, cases, schemes, catalogues };
}

// --- V: the credential pool ----------------------------------------------------------------------------------------------------
type PoolOp = { op: "select"; model?: string } | { op: "fail"; id: string; failure: Record<string, unknown> } | { op: "success"; id: string; model?: string }
  | { op: "advance"; ms: number } | { op: "status" } | { op: "snapshot" } | { op: "restore"; from: "last" } | { op: "entry"; id: string };
const entries = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i + 1}`, secretRef: `ref/${i + 1}`, ...(i === 0 ? { label: "first" } : {}) }));
const SEV = COOLDOWN_MS.ambiguous.several, SOLE = COOLDOWN_MS.ambiguous.sole, CSEV = COOLDOWN_MS.confirmed.several, CSOLE = COOLDOWN_MS.confirmed.sole;
const POOL_SCENARIOS: Array<{ name: string; n: number; strategy?: Strategy; ops: PoolOp[] }> = [
  { name: "ambiguous-429-boundary", n: 2, ops: [{ op: "select" }, { op: "fail", id: "c1", failure: { status: 429 } }, { op: "select" }, { op: "advance", ms: SEV - 1 }, { op: "select" }, { op: "status" }, { op: "advance", ms: 1 }, { op: "select" }, { op: "status" }] },
  { name: "confirmed-401-boundary", n: 2, ops: [{ op: "fail", id: "c1", failure: { status: 401 } }, { op: "advance", ms: CSEV - 1 }, { op: "select" }, { op: "advance", ms: 1 }, { op: "select" }] },
  { name: "sole-and-remaining-sole", n: 2, ops: [{ op: "fail", id: "c1", failure: { status: 401 } }, { op: "fail", id: "c2", failure: { status: 429 } }, { op: "select" }, { op: "advance", ms: SOLE - 1 }, { op: "select" }, { op: "advance", ms: 1 }, { op: "select" }, { op: "status" }] },
  { name: "solo-quota", n: 1, ops: [{ op: "fail", id: "c1", failure: { status: 429, hint: "quota_exhausted" } }, { op: "select" }, { op: "advance", ms: CSOLE }, { op: "select" }] },
  { name: "all-cooling-earliest", n: 2, ops: [{ op: "fail", id: "c1", failure: { status: 429, retryAfterMs: 30_000 } }, { op: "fail", id: "c2", failure: { status: 429, retryAfterMs: 10_000 } }, { op: "select" }, { op: "advance", ms: 9_999 }, { op: "select" }, { op: "advance", ms: 1 }, { op: "select" }] },
  { name: "all-cooling-rounding", n: 1, ops: [{ op: "fail", id: "c1", failure: { status: 429, retryAfterMs: 1_500 } }, { op: "select" }, { op: "advance", ms: 501 }, { op: "select" }, { op: "advance", ms: 998 }, { op: "select" }] },
  { name: "retry-after-clamp", n: 2, ops: [
    { op: "fail", id: "c1", failure: { status: 429, retryAfterMs: 5 } }, { op: "fail", id: "c1", failure: { status: 429, retryAfterMs: RETRY_AFTER_MIN_MS - 1 } }, { op: "fail", id: "c1", failure: { status: 429, retryAfterMs: RETRY_AFTER_MIN_MS } },
    { op: "fail", id: "c1", failure: { status: 429, retryAfterMs: RETRY_AFTER_MIN_MS + 1 } }, { op: "fail", id: "c1", failure: { status: 429, retryAfterMs: RETRY_AFTER_MAX_MS } }, { op: "fail", id: "c1", failure: { status: 429, retryAfterMs: RETRY_AFTER_MAX_MS + 1 } },
    { op: "fail", id: "c1", failure: { status: 429, retryAfterMs: 10 ** 12 } }, { op: "fail", id: "c1", failure: { status: 429, retryAfterMs: 2_000 } }, { op: "fail", id: "c1", failure: { status: 429, retryAfterMs: 0 } }, { op: "fail", id: "c1", failure: { status: 429, retryAfterMs: -5 } }, { op: "fail", id: "c1", failure: { status: 429, retryAfterMs: 1234.5 } }, { op: "status" }] },
  { name: "never-shortened-equal", n: 2, ops: [{ op: "fail", id: "c1", failure: { status: 429, retryAfterMs: 5_000 } }, { op: "fail", id: "c1", failure: { status: 401, retryAfterMs: 5_000 } }, { op: "status" }, { op: "success", id: "c1" }, { op: "select" }, { op: "status" }] },
  { name: "model-scope", n: 1, ops: [{ op: "fail", id: "c1", failure: { status: 429, model: "big" } }, { op: "select", model: "big" }, { op: "select", model: "small" }, { op: "select" }, { op: "status" }, { op: "advance", ms: SOLE - 1 }, { op: "select", model: "big" }, { op: "advance", ms: 1 }, { op: "select", model: "big" }, { op: "status" }] },
  { name: "model-scope-403-two", n: 2, ops: [{ op: "fail", id: "c1", failure: { status: 403, model: "m" } }, { op: "select", model: "m" }, { op: "select" }, { op: "fail", id: "c2", failure: { status: 403, model: "m" } }, { op: "select", model: "m" }, { op: "success", id: "c1", model: "m" }, { op: "select", model: "m" }, { op: "snapshot" }] },
  { name: "statuses-cool-nothing", n: 2, ops: [{ op: "fail", id: "c1", failure: { status: 503 } }, { op: "fail", id: "c1", failure: { status: 500 } }, { op: "fail", id: "c1", failure: { status: 404 } }, { op: "fail", id: "c1", failure: { status: 200 } }, { op: "fail", id: "c1", failure: { status: 400 } }, { op: "select" }, { op: "fail", id: "nope", failure: { status: 401 } }, { op: "status" }] },
  { name: "success-ends-ambiguous-only", n: 2, ops: [{ op: "fail", id: "c1", failure: { status: 429 } }, { op: "success", id: "c1" }, { op: "select" }, { op: "status" }, { op: "fail", id: "c1", failure: { status: 401 } }, { op: "success", id: "c1" }, { op: "select" }, { op: "status" }, { op: "fail", id: "c2", failure: { status: 403 } }, { op: "success", id: "c2", model: "x" }, { op: "status" }] },
  { name: "round-robin", n: 3, strategy: "round_robin", ops: [{ op: "select" }, { op: "select" }, { op: "select" }, { op: "select" }, { op: "fail", id: "c2", failure: { status: 429 } }, { op: "select" }, { op: "select" }, { op: "select" }, { op: "snapshot" }] },
  { name: "round-robin-cursor-wrap", n: 3, strategy: "round_robin", ops: [{ op: "select" }, { op: "select" }, { op: "fail", id: "c3", failure: { status: 401 } }, { op: "select" }, { op: "select" }, { op: "snapshot" }] },
  { name: "least-used", n: 3, strategy: "least_used", ops: [{ op: "select" }, { op: "select" }, { op: "select" }, { op: "select" }, { op: "fail", id: "c2", failure: { status: 429 } }, { op: "select" }, { op: "select" }, { op: "select" }, { op: "status" }] },
  { name: "fill-first", n: 2, ops: [{ op: "select" }, { op: "select" }, { op: "select" }, { op: "status" }] },
  { name: "snapshot-restore", n: 2, ops: [{ op: "fail", id: "c1", failure: { status: 429, hint: "quota_exhausted" } }, { op: "fail", id: "c2", failure: { status: 429, model: "m" } }, { op: "select" }, { op: "snapshot" }, { op: "restore", from: "last" }, { op: "status" }, { op: "select" }, { op: "select", model: "m" }] },
  { name: "empty", n: 0, ops: [{ op: "select" }, { op: "status" }, { op: "entry", id: "c1" }] },
  { name: "rate-limit-hint", n: 2, ops: [{ op: "fail", id: "c1", failure: { status: 429, hint: "rate_limit" } }, { op: "status" }, { op: "entry", id: "c1" }, { op: "entry", id: "zz" }] },
];
function poolCases() {
  const classify = [{ status: 429 }, { status: 429, model: "m" }, { status: 429, hint: "quota_exhausted" }, { status: 429, hint: "quota_exhausted", model: "m" }, { status: 429, hint: "rate_limit", model: "m" }, { status: 401 }, { status: 401, model: "m" }, { status: 403 }, { status: 403, model: "m" }, { status: 403, model: "" }, { status: 500 }, { status: 200 }, { status: 404 }, { status: 408 }]
    .map((f) => ({ failure: f, classification: classifyFailure(f as never) }));
  const scenarios = POOL_SCENARIOS.map((s) => {
    const clock = new Clock();
    const logs: unknown[] = [];
    const pool = new CredentialPool({ profileId: "e:key", entries: entries(s.n), ...(s.strategy ? { strategy: s.strategy } : {}), clock, log: (event, fields) => logs.push({ event, fields }) });
    let last: unknown;
    const steps = s.ops.map((op) => {
      try {
        switch (op.op) {
          case "select": return { out: pool.select(op.model !== undefined ? { model: op.model } : {}) };
          case "fail": return { out: pool.reportFailure(op.id, op.failure as never) };
          case "success": pool.reportSuccess(op.id, op.model); return { out: null };
          case "advance": clock.t += op.ms; return { out: null };
          case "status": return { out: pool.status() };
          case "snapshot": last = JSON.parse(JSON.stringify(pool.snapshot())); return { out: last };
          case "restore": pool.restore(last as never); return { out: pool.snapshot() };
          case "entry": return { out: pool.entry(op.id) ?? null };
        }
      } catch (e) { return { error: errOf(e) }; }
    });
    return { name: s.name, n: s.n, strategy: pool.strategy, ops: s.ops, steps, logs };
  });
  let duplicate: unknown;
  try { new CredentialPool({ profileId: "p", entries: [entries(1)[0]!, entries(1)[0]!], clock: new Clock() }); } catch (e) { duplicate = errOf(e); }
  return { cooldownMs: COOLDOWN_MS, retryAfter: { min: RETRY_AFTER_MIN_MS, max: RETRY_AFTER_MAX_MS }, start: new Clock().t, classify, scenarios, duplicate };
}

// --- V: the redactor and the stored record --------------------------------------------------------------------------------------
function redactCases() {
  const K = "CANARY-APIKEY-2b8e";
  const scrubs: Array<[string, string[]]> = [
    [`oops ${K} here`, [K]], ["Authorization: Bearer abcdef1234567890", []], ["bearer abcdefgh", []], ["Bearer abcdefg", []], ["BASIC dXNlcjpwYXNz", []],
    ["xBearer abcdefgh1", []], ["Bearer\tabcdefgh+/=~._-", []], ["Bearer  abcdefgh", []], ["Bearer   abc!defghij", []], ["Bearer\nabcdefghij Basic 123456789", []],
    ["a abc a", ["abc"]], ["aaaa aaaa", ["aaaa"]], ["xyzw", ["xyzw", "yz"]], ["one two", ["one ", "two"]], ["Bearer CANARY-X-12345678", ["CANARY-X-12345678"]],
    [`${K}${K}`, [K]], ["éééé x", ["éééé"]], ["😀😀 y", ["😀😀"]], ["no secrets", []], ["", []],
    ["Bearer abcdefgh Bearer ijklmnop", []], ["_Bearer abcdefghij", []], ["9Basic abcdefghij", []], ["Bearer abcdefghij", []], ["Bearer﻿abcdefghij", []], ["Bearer\u0085abcdefghij", []],
  ];
  return {
    scrub: scrubs.map(([text, secrets]) => ({ text, secrets, out: scrub(text, secrets) })),
    safeFields: [
      { fields: { a: `x ${K}`, n: 3, b: true, z: null }, secrets: [K] },
      { fields: { t: "Bearer abcdefghijkl", u: "fine" }, secrets: [] },
    ].map((c) => ({ ...c, out: safeFields(c.fields as never, c.secrets) })),
  };
}
function recordCases() {
  const encode = [
    { v: 1, accessToken: "CANARY-A", generation: 0 },
    { v: 1, accessToken: "CANARY-A", refreshToken: "CANARY-R", expiresAt: 1_000_000_060_000, refreshExpiresAt: 1_000_002_000_000, generation: 3, reauthRequired: true },
    { v: 1, accessToken: "CANARY-é\"\\\n", generation: 1.5, expiresAt: 0.25, refreshExpiresAt: -1 },
    { v: 1, accessToken: "", generation: -0, expiresAt: 1e21, reauthRequired: false },
  ].map((r) => ({ record: r, text: encodeRecord(r as never) }));
  const decode = [
    "{\"v\":1,\"accessToken\":\"CANARY-B\"}", "not json CANARY-C", "null", "[]", "1", "{\"v\":2,\"accessToken\":\"CANARY-D\",\"generation\":0}", "{\"v\":\"1\",\"accessToken\":\"CANARY-D\",\"generation\":0}",
    "{\"v\":1,\"accessToken\":5,\"generation\":0}", "{\"v\":1,\"accessToken\":\"CANARY-E\",\"generation\":\"0\"}", "{\"v\":1,\"accessToken\":\"CANARY-E\",\"generation\":0,\"refreshToken\":null}",
    "{\"v\":1,\"accessToken\":\"CANARY-E\",\"generation\":0,\"refreshToken\":7}", "{\"v\":1,\"accessToken\":\"CANARY-E\",\"generation\":0,\"expiresAt\":\"1\"}", "{\"v\":1,\"accessToken\":\"CANARY-E\",\"generation\":0,\"refreshExpiresAt\":null}",
    "{\"v\":1,\"accessToken\":\"CANARY-F\",\"generation\":2,\"refreshToken\":\"CANARY-G\",\"expiresAt\":5,\"refreshExpiresAt\":6,\"reauthRequired\":0,\"extra\":\"x\"}",
    "{\"v\":1,\"accessToken\":\"CANARY-H\",\"generation\":1e3,\"reauthRequired\":\"\"}", "{\"v\":1,\"accessToken\":\"CANARY-I\",\"generation\":0,\"reauthRequired\":null}", " {\"v\":1,\"accessToken\":\"CANARY-J\",\"generation\":0} ",
    "{\"v\":1,\"v\":1,\"accessToken\":\"CANARY-K\",\"generation\":0,\"generation\":4}",
  ].map((raw) => {
    try { const r = decodeRecord(raw, "p"); return { raw, record: { ...r }, text: encodeRecord(r), json: JSON.stringify(r) }; } catch (e) { return { raw, error: errOf(e) }; }
  });
  return { encode, decode };
}

// --- W: the token POST boundary (auth/http.ts) -----------------------------------------------------------------------------------
const TOKEN = "https://idp.example.test/token";
const OK_TOKEN = { access_token: "CANARY-ACCESS-1", token_type: "Bearer", expires_in: 3600 };
type HttpCase = { name: string; url?: string; form?: Record<string, string>; script: Scripted[]; options?: { timeoutMs?: number; maxBytes?: number }; egress?: unknown };
const HTTP_CASES: HttpCase[] = [
  { name: "ok", form: { grant_type: "refresh_token", refresh_token: "CANARY-r 1&2", client_id: "cé*-._~!'()" }, script: [json(200, OK_TOKEN)] },
  { name: "ok-empty-form", form: {}, script: [json(200, OK_TOKEN)] },
  { name: "limits", form: { a: "b" }, options: { timeoutMs: 1000, maxBytes: 1024 }, script: [json(200, OK_TOKEN)] },
  ...[200, 201, 204, 299, 300, 301, 302, 307, 308, 399, 400, 401, 403, 404, 407, 408, 409, 429, 499, 500, 502, 503, 599].map((status) => ({ name: `status-${status}`, script: [json(status, status < 300 ? OK_TOKEN : { error: "invalid_grant" })] })),
  ...["invalid_grant", "authorization_pending", "slow_down", "expired_token", "access_denied", "invalid_client", "invalid_request", "unsupported_grant_type", "invalid_scope", "server_error", "", "INVALID_GRANT"].map((error) => ({ name: `wire-error-${error || "empty"}`, script: [json(400, { error, error_description: "CANARY-ACCESS-desc" })] })),
  { name: "error-on-200", script: [json(200, { ...OK_TOKEN, error: "access_denied" })] },
  { name: "error-null-on-200", script: [json(200, { ...OK_TOKEN, error: null })] },
  { name: "error-number", script: [json(400, { error: 7 })] },
  { name: "not-json", script: [{ status: 200, body: "CANARY-ACCESS-raw" }] },
  { name: "truncated-json", script: [{ status: 200, body: JSON.stringify(OK_TOKEN).slice(0, 20) }] },
  { name: "json-array", script: [{ status: 200, body: "[1,2]" }] },
  { name: "json-null", script: [{ status: 200, body: "null" }] },
  { name: "json-string", script: [{ status: 200, body: "\"x\"" }] },
  { name: "empty-body", script: [{ status: 200, body: "" }] },
  { name: "not-json-500", script: [{ status: 500, body: "<html>" }] },
  { name: "not-json-302", script: [{ status: 302, body: "" }] },
  { name: "not-json-400", script: [{ status: 400, body: "nope" }] },
  { name: "bom-json", script: [{ status: 200, body: "﻿" + JSON.stringify(OK_TOKEN) }] },
  { name: "whitespace-json", script: [{ status: 200, body: " \n" + JSON.stringify(OK_TOKEN) + "\t" }] },
  { name: "too-large", script: [{ fail: "too-large" }] },
  { name: "unsupported-type", script: [{ fail: "unsupported-type" }] },
  { name: "refused-at-a-hop", script: [{ fail: "egress-denied" }] },
  { name: "socket-error", script: [{ fail: "error" }] },
  { name: "timeout", options: { timeoutMs: 25 }, script: [{ fail: "hang" }] },
  { name: "unlisted-host", url: "https://other.example.test/token", script: [] },
  { name: "private-resolution", url: "https://private.example.test/token", egress: { ...EGRESS, allowHosts: [...EGRESS.allowHosts, "private.example.test"] }, script: [] },
  { name: "plain-http-public", url: "http://idp.example.test/token", egress: { ...EGRESS, allowPorts: [80, 443] }, script: [] },
  { name: "url-credentials", url: "https://user:pw@idp.example.test/token", script: [] },
  { name: "ftp-scheme", url: "ftp://idp.example.test/token", script: [] },
  { name: "not-a-url", url: "not a url", script: [] },
  { name: "unlisted-port", url: "https://idp.example.test:8443/token", script: [] },
  { name: "loopback-allowed", url: "http://127.0.0.1:4555/token", egress: { allowHosts: ["127.0.0.1"], allowPorts: [4555], allowLoopback: true }, script: [json(200, OK_TOKEN)] },
  { name: "loopback-off", url: "http://127.0.0.1:4555/token", egress: { allowHosts: ["127.0.0.1"], allowPorts: [4555], allowLoopback: false }, script: [] },
];
async function httpCases() {
  const posts = [];
  for (const c of HTTP_CASES) {
    const wire = new Wire(c.script, c.egress ?? EGRESS);
    const http = createOAuthHttp({ egress: wire.egress() as never, ...(c.options ?? {}) });
    const form = c.form ?? { grant_type: "refresh_token", refresh_token: "CANARY-REFRESH-9c1d", client_secret: "CANARY-SECRET-1" };
    let result: unknown;
    try {
      const data = await http.post(c.url ?? TOKEN, form);
      result = { ok: Object.fromEntries(Object.entries(data)), json: JSON.stringify(data) };
    } catch (e) { result = { error: errOf(e), leaks: JSON.stringify(e).includes("CANARY") || inspect(e).includes("CANARY") }; }
    posts.push({ name: c.name, url: c.url ?? TOKEN, form: Object.entries(form), options: c.options ?? {}, egress: c.egress ?? EGRESS, script: c.script, requests: wire.requests, result });
  }
  const parse = [
    OK_TOKEN, { ...OK_TOKEN, token_type: "bearer" }, { ...OK_TOKEN, token_type: "BEARER" }, { ...OK_TOKEN, token_type: "mac" }, { ...OK_TOKEN, token_type: undefined },
    { ...OK_TOKEN, access_token: "" }, { ...OK_TOKEN, access_token: "CANARY-a\nb" }, { ...OK_TOKEN, access_token: "CANARY-a\rb" }, { ...OK_TOKEN, access_token: 5 },
    { ...OK_TOKEN, refresh_token: "CANARY-R" }, { ...OK_TOKEN, refresh_token: "" }, { ...OK_TOKEN, refresh_token: null }, { ...OK_TOKEN, refresh_token: 3 },
    { ...OK_TOKEN, expires_in: 0 }, { ...OK_TOKEN, expires_in: -1 }, { ...OK_TOKEN, expires_in: 0.5 }, { ...OK_TOKEN, expires_in: "3600" }, { ...OK_TOKEN, expires_in: null }, { ...OK_TOKEN, expires_in: undefined },
    { ...OK_TOKEN, refresh_expires_in: 86400 }, { ...OK_TOKEN, refresh_expires_in: 0 }, { ...OK_TOKEN, refresh_expires_in: "1" }, { ...OK_TOKEN, scope: "a b", id_token: "x" },
  ].map((data) => {
    const input = JSON.parse(JSON.stringify(data));
    try { const t = parseTokenResponse(input); return { input, ok: { accessToken: t.accessToken, refreshToken: t.refreshToken ?? null, expiresInSeconds: t.expiresInSeconds ?? null, refreshExpiresInSeconds: t.refreshExpiresInSeconds ?? null }, json: JSON.stringify(t), leaks: inspect(t).includes("CANARY") }; }
    catch (e) { return { input, error: errOf(e) }; }
  });
  const client = [{}, { client_id: "c1" }, { audience: "aud" }, { client_id: "c1", audience: "aud" }, { client_id: "c1", client_registration: "dynamic" }, { client_registration: "static", client_id: "c2" }].map((over) => {
    const p = validateProfile({ ...OAUTH, ...over });
    try { return { profile: over, fields: clientFields(p) }; } catch (e) { return { profile: over, error: errOf(e) }; }
  });
  return { posts, parse, client, base: OAUTH };
}

// --- W: the refresh owner over HttpRefresher (auth/refresh.ts) ------------------------------------------------------------------
const OAUTH_IDP = { id: "e:oauth", display_name: "Example", kind: "oauth_pkce", capabilities: ["chat"], auth_header_scheme: "Authorization: Bearer {token}", authorization_endpoint: "https://idp.example.test/authorize", token_endpoint: "https://idp.example.test/token", client_id: "test-harness-client", refresh: { mode: "rotating", refresh_skew_seconds: 120 }, policy_status: "allowed", policy_source: "https://e.test", policy_checked: "2026-09-22" };
const REF = "e/oauth/1";
/** The secret store of the vectors: in memory, every `set` recorded, failures scripted for `get` and `set`. */
class Store extends InMemorySecretStore {
  failGets = 0;
  override async get(ref: string) { if (this.failGets > 0) { this.failGets--; throw new Error("keychain locked CANARY-GET"); } return super.get(ref); }
  /** What is stored, without spending a scripted failure. */
  peek(ref: string) { return super.get(ref); }
}
class Timer implements RefreshTimer {
  readonly active = new Map<number, { delay: number; cb: () => void }>();
  n = 0;
  schedule(cb: () => void, delay: number) { const id = ++this.n; this.active.set(id, { delay, cb }); return () => { this.active.delete(id); }; }
  view() { return [...this.active.values()].map((t) => t.delay); }
}
export type RefreshOp = { op: "seed"; record: Record<string, unknown> | string } | { op: "fresh" } | { op: "concurrent"; n: number } | { op: "invalidate"; generation: number }
  | { op: "advance"; ms: number } | { op: "fire" } | { op: "close" } | { op: "failSets"; n: number } | { op: "failGets"; n: number } | { op: "newOwner" } | { op: "delete" };
type RefreshScenario = { name: string; profile?: Record<string, unknown>; random?: number[]; script: Scripted[]; ops: RefreshOp[] };
const rec = (o: Record<string, unknown>, now = 1_000_000_000_000) => ({ v: 1, accessToken: "CANARY-ACCESS-0", refreshToken: "CANARY-REFRESH-0", expiresAt: now + 60_000, generation: 0, ...o });
const tok = (n: number, o: Record<string, unknown> = {}) => json(200, { access_token: `CANARY-ACCESS-${n}`, refresh_token: `CANARY-REFRESH-${n}`, token_type: "Bearer", expires_in: 3600, ...o });
const T0 = 1_000_000_000_000;
const REFRESH_SCENARIOS: RefreshScenario[] = [
  { name: "concurrent-callers-share-one-refresh", script: [tok(1)], ops: [{ op: "seed", record: rec({}) }, { op: "concurrent", n: 10 }, { op: "fresh" }] },
  { name: "restart-continues-with-the-rotated-token", script: [tok(1), tok(2)], ops: [{ op: "seed", record: rec({}) }, { op: "fresh" }, { op: "newOwner" }, { op: "advance", ms: 3_500_000 }, { op: "fresh" }] },
  { name: "invalid-grant-is-reauth-and-stops", script: [json(400, { error: "invalid_grant", error_description: "CANARY-REFRESH-0 is spent" }), tok(2)], ops: [{ op: "seed", record: rec({}) }, { op: "fresh" }, { op: "fresh" }, { op: "seed", record: rec({}) }, { op: "fresh" }] },
  { name: "known-refresh-expiry-boundary", script: [tok(1)], ops: [{ op: "seed", record: rec({ refreshExpiresAt: T0 - 1 }) }, { op: "fresh" }, { op: "seed", record: rec({ refreshExpiresAt: T0 }) }, { op: "fresh" }, { op: "seed", record: rec({ refreshExpiresAt: T0 + 1 }) }, { op: "fresh" }] },
  { name: "transient-keeps-the-login", random: [0.5], script: [json(503, {}), json(503, {}), tok(1)], ops: [{ op: "seed", record: rec({}) }, { op: "fresh" }, { op: "advance", ms: 120_000 }, { op: "fresh" }, { op: "advance", ms: 60_000 }, { op: "fresh" }] },
  { name: "unknown-failure-is-transient", script: [{ fail: "error" }], ops: [{ op: "seed", record: rec({ expiresAt: T0 - 1 }) }, { op: "fresh" }] },
  { name: "rate-limited-with-retry-after", script: [{ status: 429, body: "{\"error\":\"slow_down\"}", headers: { "retry-after": "30" } }], ops: [{ op: "seed", record: rec({ expiresAt: T0 }) }, { op: "fresh" }] },
  { name: "unauthorized-401", script: [json(401, { error: "invalid_client" })], ops: [{ op: "seed", record: rec({ expiresAt: T0 - 1 }) }, { op: "fresh" }] },
  { name: "not-json-and-truncated", script: [{ status: 200, body: "CANARY-ACCESS-raw" }, { status: 200, body: "{\"access_token\":\"CANARY-ACC" }], ops: [{ op: "seed", record: rec({ expiresAt: T0 - 1 }) }, { op: "fresh" }, { op: "advance", ms: 2_000 }, { op: "fresh" }] },
  { name: "timeout-is-transient", script: [{ fail: "too-large" }], ops: [{ op: "seed", record: rec({ expiresAt: T0 - 1 }) }, { op: "fresh" }] },
  { name: "rotated-token-the-store-refuses", script: [tok(1)], ops: [{ op: "seed", record: rec({}) }, { op: "failSets", n: 1 }, { op: "fresh" }, { op: "fresh" }] },
  { name: "invalidate-generation", script: [tok(1)], ops: [{ op: "seed", record: rec({ expiresAt: T0 + 3_600_000 }) }, { op: "invalidate", generation: 5 }, { op: "fresh" }, { op: "invalidate", generation: 0 }, { op: "fresh" }, { op: "invalidate", generation: 0 }] },
  { name: "no-stored-credential", script: [], ops: [{ op: "fresh" }, { op: "invalidate", generation: 0 }] },
  { name: "unreadable-store-and-record", script: [], ops: [{ op: "failGets", n: 1 }, { op: "fresh" }, { op: "seed", record: "{not json CANARY-REFRESH-x" }, { op: "fresh" }, { op: "seed", record: rec({ reauthRequired: true }) }, { op: "fresh" }] },
  { name: "skew-boundary-no-jitter", random: [0], script: [tok(1)], ops: [{ op: "seed", record: rec({ expiresAt: T0 + 120_001 }) }, { op: "fresh" }, { op: "seed", record: rec({ expiresAt: T0 + 120_000 }) }, { op: "fresh" }] },
  { name: "skew-with-full-jitter", random: [1], script: [tok(1)], ops: [{ op: "seed", record: rec({ expiresAt: T0 + 150_001 }) }, { op: "fresh" }, { op: "advance", ms: 1 }, { op: "fresh" }] },
  { name: "custom-skew-zero", profile: { ...OAUTH_IDP, refresh: { mode: "static", refresh_skew_seconds: 0 } }, random: [0.9], script: [tok(1)], ops: [{ op: "seed", record: rec({ expiresAt: T0 + 1 }) }, { op: "fresh" }, { op: "advance", ms: 1 }, { op: "fresh" }] },
  { name: "still-valid-boundary-on-transient", random: [0], script: [json(500, {}), json(500, {})], ops: [{ op: "seed", record: rec({ expiresAt: T0 + 1 }) }, { op: "fresh" }, { op: "seed", record: rec({ expiresAt: T0 }) }, { op: "advance", ms: 1_000 }, { op: "fresh" }] },
  { name: "backoff-boundary", random: [0], script: [json(500, {}), json(500, {}), tok(1)], ops: [{ op: "seed", record: rec({ expiresAt: T0 - 1 }) }, { op: "fresh" }, { op: "advance", ms: 999 }, { op: "fresh" }, { op: "advance", ms: 1 }, { op: "fresh" }, { op: "advance", ms: 2_000 }, { op: "fresh" }] },
  { name: "backoff-grows-and-caps", random: [0], script: Array.from({ length: 12 }, () => json(502, {})), ops: [{ op: "seed", record: rec({ expiresAt: T0 - 1 }) }, ...Array.from({ length: 12 }, () => [{ op: "fresh" } as RefreshOp, { op: "advance", ms: 61_000 } as RefreshOp]).flat()] },
  { name: "no-refresh-token-in-answer-keeps-the-old", script: [json(200, { access_token: "CANARY-ACCESS-1", token_type: "Bearer", expires_in: 3600 })], ops: [{ op: "seed", record: rec({ refreshExpiresAt: T0 + 9_000_000 }) }, { op: "fresh" }] },
  { name: "refresh-expiry-in-answer", script: [tok(1, { refresh_expires_in: 86_400 }), tok(2)], ops: [{ op: "seed", record: rec({ refreshExpiresAt: T0 + 9_000_000 }) }, { op: "fresh" }, { op: "advance", ms: 3_600_000 }, { op: "fresh" }] },
  { name: "answer-without-expiry", script: [json(200, { access_token: "CANARY-ACCESS-1", refresh_token: "CANARY-REFRESH-1", token_type: "Bearer" })], ops: [{ op: "seed", record: rec({}) }, { op: "fresh" }, { op: "advance", ms: 99_999_999 }, { op: "fresh" }] },
  { name: "narrower-scope-is-not-checked-here", script: [tok(1, { scope: "openid" })], ops: [{ op: "seed", record: rec({}) }, { op: "fresh" }] },
  { name: "no-refresh-token-stored", script: [], ops: [{ op: "seed", record: rec({ refreshToken: undefined }) }, { op: "fresh" }, { op: "seed", record: rec({ refreshToken: "", expiresAt: T0 }) }, { op: "fresh" }, { op: "seed", record: rec({ refreshToken: undefined, expiresAt: undefined }) }, { op: "fresh" }] },
  { name: "proactive-timer", random: [1], script: [tok(1)], ops: [{ op: "seed", record: rec({ expiresAt: T0 + 3_600_000 }) }, { op: "fresh" }, { op: "fire" }, { op: "close" }] },
  { name: "timer-backs-off-and-retries", random: [0], script: [json(503, {}), json(503, {}), json(503, {}), tok(1)], ops: [{ op: "seed", record: rec({ expiresAt: T0 + 20_000 }) }, { op: "fresh" }, { op: "fresh" }, { op: "fire" }, { op: "advance", ms: 25_000 }, { op: "fresh" }, { op: "fire" }, { op: "close" }] },
  { name: "short-lived-token-spins-no-faster-than-a-second", random: [0], script: [tok(1, { expires_in: 0.5 })], ops: [{ op: "seed", record: rec({ expiresAt: T0 - 1 }) }, { op: "fresh" }] },
  { name: "clock-jumps-back-and-forward", random: [0], script: [tok(1)], ops: [{ op: "seed", record: rec({ expiresAt: T0 + 3_600_000 }) }, { op: "fresh" }, { op: "advance", ms: -7_200_000 }, { op: "fresh" }, { op: "advance", ms: 11_000_000 }, { op: "fresh" }] },
  { name: "dynamic-registration-is-transient", profile: { ...OAUTH_IDP, client_registration: "dynamic" }, script: [], ops: [{ op: "seed", record: rec({ expiresAt: T0 - 1 }) }, { op: "fresh" }] },
  { name: "audience-and-no-client", profile: { ...OAUTH_IDP, client_id: undefined, audience: "api://x" }, script: [tok(1)], ops: [{ op: "seed", record: rec({}) }, { op: "fresh" }] },
  { name: "refused-endpoint", profile: { ...OAUTH_IDP, token_endpoint: "https://other.example.test/token" }, script: [], ops: [{ op: "seed", record: rec({ expiresAt: T0 - 1 }) }, { op: "fresh" }] },
  { name: "closed-owner-schedules-nothing", random: [0], script: [json(503, {})], ops: [{ op: "seed", record: rec({ expiresAt: T0 - 1 }) }, { op: "close" }, { op: "fresh" }] },
];
const leaseView = (r: { record: Record<string, any>; refreshed: boolean }) => ({ refreshed: r.refreshed, record: encodeRecord(r.record as never) });
async function runRefresh(s: RefreshScenario) {
  const clock = new Clock(T0), store = new Store(), timer = new Timer(), wire = new Wire(s.script);
  const draws = [...(s.random ?? [0.5])];
  const random = () => (draws.length > 1 ? draws.shift()! : draws[0]!);
  const logs: unknown[] = [];
  const profile = validateProfile(JSON.parse(JSON.stringify(s.profile ?? OAUTH_IDP)));
  const make = () => new RefreshOwner({ store, clock, timer, random, refresher: new HttpRefresher(createOAuthHttp({ egress: wire.egress() as never })), log: (event, fields) => logs.push({ event, fields }) });
  let owner = make();
  const steps = [];
  for (const op of s.ops) {
    let out: unknown = null;
    try {
      switch (op.op) {
        case "seed": await store.set(REF, typeof op.record === "string" ? op.record : encodeRecord(op.record as never)); break;
        case "delete": await store.delete(REF); break;
        case "fresh": out = leaseView(await owner.fresh(profile, REF, "c1")); break;
        case "concurrent": out = (await Promise.all(Array.from({ length: op.n }, () => owner.fresh(profile, REF, "c1")))).map(leaseView); break;
        case "invalidate": await owner.invalidate(profile, REF, "c1", op.generation); break;
        case "advance": clock.t += op.ms; break;
        case "fire": {
          const [id, t] = [...timer.active.entries()].at(-1) ?? [];
          if (t) { timer.active.delete(id!); clock.t += t.delay; t.cb(); for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); }
          out = t ? { fired: t.delay } : { fired: null };
          break;
        }
        case "close": owner.close(); break;
        case "failSets": store.failSets = op.n; break;
        case "failGets": store.failGets = op.n; break;
        case "newOwner": owner.close(); owner = make(); break;
      }
      steps.push({ out, now: clock.t, stored: (await store.peek(REF)) ?? null, timers: timer.view() });
    } catch (e) {
      steps.push({ error: errOf(e), leaks: JSON.stringify(e).includes("CANARY") || inspect(e).includes("CANARY") || String((e as Error).message).includes("CANARY"), now: clock.t, stored: (await store.peek(REF)) ?? null, timers: timer.view() });
    }
  }
  owner.close();
  return { name: s.name, profile: JSON.parse(JSON.stringify(s.profile ?? OAUTH_IDP)), random: s.random ?? [0.5], start: T0, ref: REF, ops: s.ops, script: s.script, steps, requests: wire.requests, logs };
}
async function refreshCases() { const out = []; for (const s of REFRESH_SCENARIOS) out.push(await runRefresh(s)); return { egress: EGRESS, resolve: RESOLVE, public: PUBLIC, scenarios: out }; }

// --- W: the credentials provider (auth/credentials.ts) ---------------------------------------------------------------------------
const KEY_PROFILE = { ...COMMON, id: "e:key", kind: "api_key", auth_header_scheme: "x-api-key: {token}", extra_headers: { "anthropic-version": "1" } };
const ADC_PROFILE = { ...COMMON, id: "e:adc", kind: "adc" };
const CLI_PROFILE = { ...COMMON, id: "e:cli", kind: "external_cli" };
const FED_PROFILE = { ...COMMON, id: "e:fed", kind: "federated_token" };
const DYN_PROFILE = { ...OAUTH_IDP, id: "e:dyn", client_registration: "dynamic_on_authorize" };
type CredOp = { op: "get"; profileId: string; model?: string } | { op: "report"; lease: number; result: Record<string, unknown> } | { op: "advance"; ms: number } | { op: "seed"; ref: string; value: string } | { op: "status"; profileId: string } | { op: "close" };
type CredScenario = { name: string; profiles: Array<{ profile: Record<string, unknown>; entries: Array<{ id: string; secretRef: string }>; strategy?: Strategy }>; adc?: Array<{ accessToken: string; expiresAt: number | null } | "fail">; script: Scripted[]; ops: CredOp[] };
const CRED_SCENARIOS: CredScenario[] = [
  { name: "api-key-header-and-extra-headers", profiles: [{ profile: KEY_PROFILE, entries: [{ id: "a", secretRef: "k/1" }] }], script: [], ops: [{ op: "seed", ref: "k/1", value: "CANARY-APIKEY-1" }, { op: "get", profileId: "e:key" }, { op: "report", lease: 0, result: { ok: true } }] },
  { name: "secret-ref-is-a-pool-of-one", profiles: [{ profile: { ...KEY_PROFILE, secret_ref: "k/solo" }, entries: [] }], script: [], ops: [{ op: "seed", ref: "k/solo", value: "CANARY-APIKEY-2" }, { op: "get", profileId: "e:key" }, { op: "status", profileId: "e:key" }] },
  { name: "ten-concurrent-leases-one-refresh", profiles: [{ profile: OAUTH_IDP, entries: [{ id: "a", secretRef: "o/1" }] }], script: [tok(1)], ops: [{ op: "seed", ref: "o/1", value: encodeRecord(rec({ expiresAt: T0 + 1000 }) as never) }, ...Array.from({ length: 10 }, () => ({ op: "get", profileId: "e:oauth" }) as CredOp)] },
  { name: "401-refreshes-once-then-cools", profiles: [{ profile: OAUTH_IDP, entries: [{ id: "a", secretRef: "o/1" }, { id: "b", secretRef: "o/2" }] }], script: [tok(1)], ops: [
    { op: "seed", ref: "o/1", value: encodeRecord(rec({ expiresAt: T0 + 3_600_000 }) as never) }, { op: "seed", ref: "o/2", value: encodeRecord(rec({ accessToken: "CANARY-B", refreshToken: "CANARY-BR", expiresAt: T0 + 3_600_000 }) as never) },
    { op: "get", profileId: "e:oauth" }, { op: "report", lease: 0, result: { ok: false, status: 401 } }, { op: "get", profileId: "e:oauth" }, { op: "report", lease: 1, result: { ok: false, status: 401 } }, { op: "get", profileId: "e:oauth" }, { op: "status", profileId: "e:oauth" }] },
  { name: "429-failover-and-recovery", profiles: [{ profile: KEY_PROFILE, entries: [{ id: "a", secretRef: "k/1" }, { id: "b", secretRef: "k/2" }] }], script: [], ops: [
    { op: "seed", ref: "k/1", value: "CANARY-K1" }, { op: "seed", ref: "k/2", value: "CANARY-K2" }, { op: "get", profileId: "e:key" }, { op: "report", lease: 0, result: { ok: false, status: 429 } },
    { op: "get", profileId: "e:key" }, { op: "advance", ms: 59_999 }, { op: "get", profileId: "e:key" }, { op: "advance", ms: 1 }, { op: "get", profileId: "e:key" }, { op: "status", profileId: "e:key" }] },
  { name: "dead-refresh-fails-over-alone-reauth", profiles: [{ profile: OAUTH_IDP, entries: [{ id: "a", secretRef: "o/1" }, { id: "b", secretRef: "o/2" }] }, { profile: { ...OAUTH_IDP, id: "e:solo" }, entries: [{ id: "a", secretRef: "o/1" }] }], script: [json(400, { error: "invalid_grant" })], ops: [
    { op: "seed", ref: "o/1", value: encodeRecord(rec({ accessToken: "CANARY-D", refreshToken: "CANARY-DR", expiresAt: T0 - 1 }) as never) }, { op: "seed", ref: "o/2", value: encodeRecord(rec({ accessToken: "CANARY-OK", refreshToken: "CANARY-OKR", expiresAt: T0 + 3_600_000 }) as never) },
    { op: "get", profileId: "e:oauth" }, { op: "get", profileId: "e:solo" }, { op: "status", profileId: "e:oauth" }] },
  { name: "every-pooled-credential-dead", profiles: [{ profile: KEY_PROFILE, entries: [{ id: "a", secretRef: "gone/1" }, { id: "b", secretRef: "gone/2" }] }], script: [], ops: [{ op: "get", profileId: "e:key" }, { op: "status", profileId: "e:key" }, { op: "advance", ms: 3_600_000 }, { op: "get", profileId: "e:key" }] },
  { name: "typed-errors", profiles: [{ profile: CLI_PROFILE, entries: [] }, { profile: ADC_PROFILE, entries: [] }, { profile: KEY_PROFILE, entries: [{ id: "a", secretRef: "gone" }] }, { profile: FED_PROFILE, entries: [] }, { profile: DYN_PROFILE, entries: [] }, { profile: { ...KEY_PROFILE, id: "e:empty" }, entries: [] }], script: [], ops: [
    { op: "get", profileId: "e:cli" }, { op: "get", profileId: "e:adc" }, { op: "get", profileId: "nope" }, { op: "get", profileId: "e:key" }, { op: "get", profileId: "e:fed" }, { op: "get", profileId: "e:dyn" }, { op: "get", profileId: "e:empty" }] },
  { name: "adc-source", profiles: [{ profile: ADC_PROFILE, entries: [] }], adc: [{ accessToken: "CANARY-ADC", expiresAt: 5 }, "fail", { accessToken: "CANARY-ADC2", expiresAt: null }], script: [], ops: [{ op: "get", profileId: "e:adc" }, { op: "get", profileId: "e:adc" }, { op: "get", profileId: "e:adc" }, { op: "report", lease: 0, result: { ok: false, status: 401 } }] },
  { name: "report-model-scoped-and-success", profiles: [{ profile: KEY_PROFILE, entries: [{ id: "a", secretRef: "k/1" }, { id: "b", secretRef: "k/2" }] }], script: [], ops: [
    { op: "seed", ref: "k/1", value: "CANARY-K1" }, { op: "seed", ref: "k/2", value: "CANARY-K2" }, { op: "get", profileId: "e:key", model: "big" }, { op: "report", lease: 0, result: { ok: false, status: 429, model: "big" } },
    { op: "get", profileId: "e:key", model: "big" }, { op: "get", profileId: "e:key", model: "small" }, { op: "report", lease: 1, result: { ok: true, model: "big" } }, { op: "status", profileId: "e:key" }] },
  { name: "401-on-a-refreshed-or-unknown-lease", profiles: [{ profile: OAUTH_IDP, entries: [{ id: "a", secretRef: "o/1" }] }], script: [tok(1)], ops: [
    { op: "seed", ref: "o/1", value: encodeRecord(rec({ expiresAt: T0 - 1 }) as never) }, { op: "get", profileId: "e:oauth" }, { op: "report", lease: 0, result: { ok: false, status: 401 } }, { op: "status", profileId: "e:oauth" }] },
  { name: "marker-hostile-and-corrupt", profiles: [{ profile: OAUTH_IDP, entries: [{ id: "x", secretRef: "o/2" }, { id: "y", secretRef: "o/missing" }] }], script: [], ops: [{ op: "seed", ref: "o/2", value: "{not json CANARY-APIKEY-2b8e" }, { op: "get", profileId: "e:oauth" }, { op: "status", profileId: "e:oauth" }] },
];
async function credentialsCases() {
  const out = [];
  for (const s of CRED_SCENARIOS) {
    const clock = new Clock(T0), store = new Store(), wire = new Wire(s.script), logs: unknown[] = [];
    const adc = [...(s.adc ?? [])];
    const provider = createCredentialsProvider({
      profiles: s.profiles.map((p) => ({ profile: validateProfile(JSON.parse(JSON.stringify(p.profile))), entries: p.entries, ...(p.strategy ? { strategy: p.strategy } : {}) })),
      store, clock, refresher: new HttpRefresher(createOAuthHttp({ egress: wire.egress() as never })), log: (event, fields) => logs.push({ event, fields }),
      ...(s.adc ? { adc: { token: async () => { const t = adc.shift(); if (!t || t === "fail") throw new Error("metadata server said CANARY-ADC-fail"); return t; } } } : {}),
    });
    const leases: any[] = [];
    const steps = [];
    for (const op of s.ops) {
      try {
        let res: unknown = null;
        if (op.op === "get") {
          const l = await provider.getAuthorization({ profileId: op.profileId, ...(op.model !== undefined ? { model: op.model } : {}) });
          leases.push(l);
          res = { profileId: l.profileId, credentialId: l.credentialId, header: l.header, headers: l.headers({ "anthropic-version": "1", "x-api-key": "shadowed" }), expiresAt: l.expiresAt, refreshed: l.refreshed, generation: l.generation, json: JSON.stringify(l), string: String(l), leaks: inspect(l).includes("CANARY") };
        } else if (op.op === "report") await provider.reportResult(leases[op.lease], op.result as never);
        else if (op.op === "advance") clock.t += op.ms;
        else if (op.op === "seed") await store.set(op.ref, op.value);
        else if (op.op === "status") res = provider.pool(op.profileId)?.status() ?? null;
        else if (op.op === "close") provider.close();
        steps.push({ out: res });
      } catch (e) { steps.push({ error: errOf(e), leaks: JSON.stringify(e).includes("CANARY") || inspect(e).includes("CANARY") }); }
    }
    provider.close();
    out.push({ name: s.name, profiles: JSON.parse(JSON.stringify(s.profiles)), adc: s.adc ?? null, start: T0, script: s.script, ops: s.ops, steps, requests: wire.requests, logs });
  }
  return out;
}

// --- W: login flows and Google ADC -----------------------------------------------------------------------------------------------
/** Fixed test keys (PKCS #8 DER, base64), generated once for these vectors; the PEM armour is assembled at run time so the
 *  repository never holds a whole private-key header. They sign nothing outside this file and the Rust replay. */
export const TEST_RSA_PKCS8 = [
  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCiPyGykV+NE0ud+fSLrFbataT6CFOVhyi33P4Vm8r+qE26CSFJ",
  "xXLKDRkD80riFwVE8j6bn2PhqZK3PcSwYSGNaeM+8XqPSPFcztzRTylsWVIIKfCl3gpm+ARYcZ5uQWKx6uxoptaiy0Yz4TxMb3UX",
  "AGnu+5UNk1AMh0SHdhptTcNF3Se9P7OZHQ5TAPeibbTbeIc6D7tp03ViUJiIE5JuSsw6gTVvSoO0rWM4uOAY8w0JaFnHl7T1kvHB",
  "NkqRjiKEqB5Xig4hxdUYwECYIIEiNLJPa2YwZr4eeNI6doylVwLOo200TLJif1HM13i58AkNOu83nRrzHdxrP2enji63AgMBAAEC",
  "ggEAGYlMOXnOCztNPIkZ513xsazDUaM73J4QV5gN2cLSmXBOA4jqV10faxPSqx+A2sL6zlY+amoU43C4KeUr7wLqsAJJhR+mxaSa",
  "cJwSf1MxVt9cHPLU8JZZFsnUjUMcx4e9C/nIydPwlmDeJM4/mlw0lrE2+ylX1XIpOD+WFqgNEsTZXJznAV4Y9EqcQWtGf+bwMXqx",
  "X54A4AbcNb8sG7QIoY2sKwvsMERwxaFdTzVeowWeeUs4s5O0v4h+SOZuSIeIcWDKH/p+uN9g4DmiLIOKFc4shSl0pH3bzaMXMSgS",
  "/BZGGhTSJ2+CSZAHGQ2nGA/CHCuCgA2zawPSuLJJtOFRAQKBgQDPGL9ErKxYEacx9SfneV9TLpVnZduRRBUd09St9HN46h3yhPv5",
  "KbsO2x/5nNfWG4IULhTqVGPWXPDbyvKcmzKQDi0GtgthMByZ88bZitanUcKB4iQEDENxqNuiVzWNgpaKKD/x1J8AuA2Z4PaQ73Ot",
  "RVDgQFS+cyCkYQ40XifUgQKBgQDIjyRmGSkA4iHWaNRGdU/MziV97pOBCQkQVojGl+P+eYVI4HqCFKchzmfW2DH/+oGjPGwhLabe",
  "fbMKiSumpFaI4puqiSH8pqhrFAkaQrqvN7VQe9KrCJoe+upTi503t6FFJLDCkiRuaBjnBj3e8B0my7iN5a56BBDU89sFfjAHNwKB",
  "gFhzkmWrdmSbDZUJx0RXE368m7UwzOmrcXVu3xx5FsSjAa1uXQxbZXh/4JVFBu58iz9BO0+mQYnx4jGN6bc3lg3u8A44vH2DBgQ/",
  "GUQax3lpMzE0O/u6nSezXjNlGgtZpiBV9pG8JTkyYyTA766Rhw+PVm6hK1C4bU2n4mA9greBAoGBAKaqvbbS5c5EHZaOWwmKZ5xt",
  "G58BajbrCUs4fkV66A8LcYXUdjova4yeeJCD7VkqFh1PExSnWWq/zs/MmifLndX3ayFXAJVy8ba6Wa4nEfiWNOkDXVigt2NTZPO0",
  "rBwnT6+kA/hNdlUB0N/7weLIa5FX7rCM1Ge1hT9SvwpbiRIVAoGAT0z5Zuao8aYoCFcDVxMkSS09T5wIMYmAyeHYG9ZYOxlcRPrF",
  "6OBUAiHCUhjR8twegUCuAnUojCUOktQ9ndAecorLhtpboUK6MwUk1xbU2ibgDVhMfNvaWlL2zDqaZ3G8QTgL7KWvLyfFV5ce8YRb",
  "eQxzzlM8/VfltZFCPknHxoE=",
].join("");
const TEST_EC_PKCS8 = [
  "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg0JHSiBgmqHD9wBhAmYq/zfZPKwbjuh+gVElcO63WvvShRANCAAQ6",
  "RpLAaeag8gMnGhG3LpIV9fV3b4d8VJo4GrME7Uzi+h8OCnlcGM1sBNR/vUcDYFdmL2ustRTq0rxt+oY3z3H2",
].join("");
export const armour = (label: string, b64: string) => ["-----BEGIN ", label, "-----\n", ...(b64.match(/.{1,64}/g) ?? []).map((l) => l + "\n"), "-----END ", label, "-----\n"].join("");

import { request as httpRequest } from "node:http";
/** One request to the loopback listener with a chosen Host header; the answer's status, body and the headers it set. A
 *  request the listener never answers (its handler threw) is `{ noAnswer: true }` after two seconds. */
function hit(port: number, method: string, target: string, host: string): Promise<unknown> {
  return new Promise((resolve) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path: target, headers: { host }, agent: false, timeout: 2000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c as Buffer));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8"), headers: Object.fromEntries(["content-type", "cache-control", "referrer-policy", "content-security-policy", "retry-after"].filter((h) => res.headers[h] !== undefined).map((h) => [h, res.headers[h]])) }));
    });
    req.on("timeout", () => { req.destroy(); resolve({ noAnswer: true }); });
    req.on("error", () => resolve({ refused: true }));
    req.end();
  });
}
/** The loopback port in recorded text, so the fixture does not depend on the port the system handed out. */
const portless = (v: unknown, port: number): unknown => {
  if (typeof v === "string") return v.replace(new RegExp(`-L ${port}:127\\.0\\.0\\.1:${port}(?![0-9])`, "g"), "-L $PORT:127.0.0.1:$PORT").replace(new RegExp(`((?:127\\.0\\.0\\.1|localhost)(?::|%3A))${port}(?![0-9])`, "g"), "$1$PORT");
  if (Array.isArray(v)) return v.map((x) => portless(x, port));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, portless(x, port)]));
  return v;
};
/** `target` replaces path and query; `divergence` marks a request TypeScript's handler cannot answer, where the port answers
 *  as it does for any other path (the answer of the scenario's first callback, a plain 404). */
type Callback = { method?: string; path?: string; query?: string; host?: string; target?: string; divergence?: string };
type LoginScenario = {
  name: string; profile?: Record<string, unknown>; env?: keyof typeof LOGIN_ENVS; paste?: boolean; method?: string; secretRef?: string; timeoutMs?: number;
  script: Scripted[]; callbacks?: Callback[]; pasted?: string; browser?: "fail" | "absent"; ui?: "absent"; failSets?: number;
};
const LOGIN_ENVS = { mac: { env: {}, platform: "darwin", stdoutIsTTY: true }, ssh: { env: { SSH_CONNECTION: "1 2 3 4" }, platform: "linux", stdoutIsTTY: true } } as const;
const PKCE_PROFILE = { ...OAUTH_IDP, id: "test:oauth", scopes: ["test.read", "offline_access"], pkce: "S256", redirect: { type: "loopback" }, secret_ref: "auth/test" };
const DEVICE_PROFILE = { ...PKCE_PROFILE, id: "test:device", kind: "device_code", device_authorization_endpoint: "https://idp.example.test/device" };
const GOOD = "code=CANARY-CODE-1&state=$STATE";
const DEV_OK = json(200, { device_code: "CANARY-DEVICE", user_code: "CANARY-USER", verification_uri: "https://idp.example.test/verify", expires_in: 120, interval: 1 });
const LOGIN_SCENARIOS: LoginScenario[] = [
  { name: "loopback-ok", script: [tok(1)], callbacks: [{ query: GOOD }, { query: GOOD }] },
  { name: "loopback-forged-first", script: [tok(1)], callbacks: [{ query: "code=CANARY-CODE-X&state=forged" }, { query: "code=CANARY-CODE-X" }, { query: "state=$STATE&state=$STATE&code=CANARY-CODE-X" }, { path: "/other", query: GOOD }, { method: "POST", query: GOOD }, { query: GOOD, host: "evil.example" }, { query: GOOD, host: "localhost:$PORT" }, { query: GOOD }] },
  { name: "loopback-error-parameter", script: [], callbacks: [{ query: "error=access_denied&state=$STATE" }] },
  { name: "loopback-missing-code", script: [], callbacks: [{ query: "state=$STATE" }] },
  { name: "loopback-empty-code", script: [], callbacks: [{ query: "code=&state=$STATE" }] },
  { name: "loopback-two-codes", script: [], callbacks: [{ query: "code=a&code=b&state=$STATE" }] },
  { name: "loopback-rate-limit", timeoutMs: 400, script: [], callbacks: Array.from({ length: 12 }, (_, i) => ({ query: `code=x&state=forged-${i}` })) },
  { name: "loopback-timeout", timeoutMs: 150, script: [], callbacks: [{ query: "code=x&state=wrong" }] },
  // K4-D3 (divergence): a request target that is no URL against the redirect makes TypeScript's handler throw (no answer;
  // in the core an uncaught exception). The port answers 404, as for any other path, and the genuine callback still ends it.
  { name: "loopback-unparsable-target", script: [tok(1)], callbacks: [{ path: "/other", query: "x=1" }, { target: "//[", divergence: "K4-D3" }, { target: "http://[", divergence: "K4-D3" }, { query: GOOD }] },
  { name: "loopback-browser-fails", script: [], browser: "fail" },
  { name: "loopback-no-browser-port", script: [], browser: "absent" },
  { name: "loopback-exchange-invalid-grant", script: [json(400, { error: "invalid_grant" })], callbacks: [{ query: GOOD }] },
  { name: "loopback-exchange-access-denied", script: [json(400, { error: "access_denied" })], callbacks: [{ query: GOOD }] },
  { name: "loopback-exchange-5xx", script: [json(503, {})], callbacks: [{ query: GOOD }] },
  { name: "loopback-exchange-not-json", script: [{ status: 200, body: "<html>CANARY-ACCESS-x" }], callbacks: [{ query: GOOD }] },
  { name: "loopback-no-refresh-token", script: [json(200, { access_token: "CANARY-ACCESS-1", token_type: "Bearer" })], callbacks: [{ query: GOOD }] },
  { name: "loopback-refresh-expiry", script: [tok(1, { refresh_expires_in: 86_400 })], callbacks: [{ query: GOOD }] },
  { name: "loopback-persist-fails", script: [tok(1)], callbacks: [{ query: GOOD }], failSets: 1 },
  { name: "ssh-hint", env: "ssh", method: "loopback_ssh", script: [tok(1)], callbacks: [{ query: GOOD }] },
  { name: "ssh-no-ui-port", env: "ssh", method: "loopback_ssh", ui: "absent", script: [] },
  { name: "paste-ok", paste: true, script: [tok(1)], pasted: "http://127.0.0.1:$PORT/auth/callback?code=CANARY-CODE-1&state=$STATE" },
  ...([
    ["paste-wrong-state", "http://127.0.0.1:$PORT/auth/callback?code=c&state=nope"], ["paste-state-twice", "http://127.0.0.1:$PORT/auth/callback?code=c&state=$STATE&state=$STATE"],
    ["paste-no-state", "http://127.0.0.1:$PORT/auth/callback?code=c"], ["paste-error", "http://127.0.0.1:$PORT/auth/callback?error=access_denied&state=$STATE"],
    ["paste-error-other", "http://127.0.0.1:$PORT/auth/callback?error=server_error&code=c&state=$STATE"], ["paste-no-code", "http://127.0.0.1:$PORT/auth/callback?state=$STATE"],
    ["paste-long-code", `http://127.0.0.1:$PORT/auth/callback?code=${"c".repeat(8193)}&state=$STATE`], ["paste-max-code", `http://127.0.0.1:$PORT/auth/callback?code=${"c".repeat(8192)}&state=$STATE`],
    ["paste-other-host", "http://localhost:$PORT/auth/callback?code=c&state=$STATE"], ["paste-other-path", "http://127.0.0.1:$PORT/auth/other?code=c&state=$STATE"],
    ["paste-fragment", "http://127.0.0.1:$PORT/auth/callback?code=c&state=$STATE#x"], ["paste-credentials", "http://u:p@127.0.0.1:$PORT/auth/callback?code=c&state=$STATE"],
    ["paste-not-a-url", "code=c&state=$STATE"], ["paste-https", "https://127.0.0.1:$PORT/auth/callback?code=c&state=$STATE"], ["paste-other-port", "http://127.0.0.1:1/auth/callback?code=c&state=$STATE"],
    ["paste-encoded-state", "http://127.0.0.1:$PORT/auth/callback?code=c+d%20e&state=$STATE"], ["paste-trailing-slash", "http://127.0.0.1:$PORT/auth/callback/?code=c&state=$STATE"],
  ] as const).map(([name, pasted]) => ({ name, paste: true, script: [tok(1)], pasted })),
  { name: "method-not-in-plan", method: "device_code", script: [] },
  { name: "federated-is-refused", profile: { ...PKCE_PROFILE, kind: "federated_token" }, script: [] },
  { name: "dynamic-on-authorize-is-refused", profile: { ...PKCE_PROFILE, client_registration: "dynamic_on_authorize" }, script: [] },
  { name: "no-secret-ref", profile: { ...PKCE_PROFILE, secret_ref: undefined }, script: [] },
  { name: "bad-timeout", timeoutMs: 0, script: [] },
  { name: "api-key-has-no-flow", profile: { ...COMMON, id: "e:key", kind: "api_key", secret_ref: "k" }, script: [] },
  { name: "device-ok", profile: DEVICE_PROFILE, script: [DEV_OK, json(400, { error: "authorization_pending" }), json(400, { error: "slow_down" }), json(503, {}), tok(1)] },
  { name: "device-denied", profile: DEVICE_PROFILE, script: [DEV_OK, json(400, { error: "access_denied", error_description: "CANARY-ACCESS-x" })] },
  { name: "device-expired-token", profile: DEVICE_PROFILE, script: [DEV_OK, json(400, { error: "expired_token" })] },
  { name: "device-other-error", profile: DEVICE_PROFILE, script: [DEV_OK, json(400, { error: "invalid_client" })] },
  { name: "device-runs-out", profile: DEVICE_PROFILE, script: [json(200, { device_code: "CANARY-DEVICE", user_code: "CANARY-USER", verification_uri: "https://idp.example.test/verify", expires_in: 3, interval: 1 }), json(400, { error: "authorization_pending" }), json(400, { error: "authorization_pending" }), json(400, { error: "authorization_pending" })] },
  { name: "device-default-interval-and-backoff", profile: DEVICE_PROFILE, script: [json(200, { device_code: "CANARY-DEVICE", user_code: "CANARY-USER", verification_uri: "https://idp.example.test/verify", verification_uri_complete: "https://idp.example.test/verify?c=1", expires_in: 100 }), json(500, {}), json(502, {}), json(429, {}), tok(1)] },
  ...([
    ["device-bad-uri-http", { verification_uri: "http://idp.example.test/verify" }], ["device-loopback-uri", { verification_uri: "http://127.0.0.1:9/verify" }], ["device-uri-credentials", { verification_uri: "https://u:p@idp.example.test/v" }],
    ["device-no-code", { device_code: "" }], ["device-no-user-code", { user_code: undefined }], ["device-bad-expiry", { expires_in: 0 }], ["device-string-expiry", { expires_in: "120" }],
    ["device-bad-interval", { interval: 0 }], ["device-null-interval", { interval: null }], ["device-not-a-url", { verification_uri: "not a url" }],
  ] as const).map(([name, over]) => ({ name, profile: DEVICE_PROFILE, script: [json(200, { device_code: "CANARY-DEVICE", user_code: "CANARY-USER", verification_uri: "https://idp.example.test/verify", expires_in: 120, interval: 1, ...over }), tok(1)] })),
  { name: "device-endpoint-refused", profile: { ...DEVICE_PROFILE, device_authorization_endpoint: "https://other.example.test/device" }, script: [] },
];

async function runLogin(s: LoginScenario) {
  const random = installScriptedRandom();
  // A scenario with a divergence records the exception TypeScript's handler throws instead of letting it end the exporter.
  const uncaught: string[] = [];
  const onUncaught = (e: unknown): void => { uncaught.push((e as Error).name); };
  const catching = (s.callbacks ?? []).some((c) => c.divergence !== undefined);
  if (catching) process.on("uncaughtException", onUncaught);
  try {
    const clock = new Clock(T0), store = new Store(), wire = new Wire(s.script), logs: unknown[] = [], events: unknown[] = [];
    store.failSets = s.failSets ?? 0;
    let port = 0, state = "", callbacksDone: Promise<void> = Promise.resolve();
    const answers: unknown[] = [];
    const learn = (url: string) => {
      const u = new URL(url);
      state = u.searchParams.get("state") ?? "";
      port = Number(new URL(u.searchParams.get("redirect_uri") ?? "http://127.0.0.1:0").port);
    };
    const sub = (t: string) => t.replaceAll("$STATE", state).replaceAll("$PORT", String(port));
    const sendCallbacks = async () => {
      for (const c of s.callbacks ?? []) {
        const target = c.target ?? `${c.path ?? "/auth/callback"}?${sub(c.query ?? "")}`;
        const before = uncaught.length;
        const response = await hit(port, c.method ?? "GET", target, sub(c.host ?? "127.0.0.1:$PORT"));
        const threw = uncaught.slice(before);
        answers.push({ request: { method: c.method ?? "GET", target, host: sub(c.host ?? "127.0.0.1:$PORT") }, response, ...(threw.length > 0 ? { threw } : {}),
          ...(c.divergence ? { divergence: c.divergence, rust: (answers[0] as { response: unknown }).response } : {}) });
      }
    };
    const profile = JSON.parse(JSON.stringify(s.profile ?? PKCE_PROFILE));
    const o: LoginOptions = {
      profile, store, clock, http: createOAuthHttp({ egress: wire.egress() as never }), env: LOGIN_ENVS[s.env ?? "mac"] as never,
      ...(s.paste ? { pasteCallback: true } : {}), ...(s.method ? { method: s.method as never } : {}), ...(s.timeoutMs !== undefined ? { timeoutMs: s.timeoutMs } : {}),
      log: (event, fields) => logs.push({ event, fields }),
      sleep: async (ms) => { events.push({ sleep: ms }); clock.t += ms; },
      onDevice: async (p) => { events.push({ device: { userCode: p.userCode, verificationUri: p.verificationUri, complete: p.verificationUriComplete ?? null, json: JSON.stringify(p) } }); },
    };
    if (s.browser !== "absent") o.openBrowser = async (url) => { events.push({ browser: url }); learn(url); if (s.browser === "fail") throw new Error("no browser CANARY-ACCESS-b"); callbacksDone = sendCallbacks(); await callbacksDone; };
    if (s.ui !== "absent") o.onAuthorization = async (p) => { events.push({ authorization: { url: p.authorizationUrl, redirect: p.redirectUri, sshHint: p.sshHint ?? null, json: JSON.stringify(p) } }); learn(p.authorizationUrl); if (!s.paste) { callbacksDone = sendCallbacks(); await callbacksDone; } };
    if (s.paste) o.readCallback = async () => sub(s.pasted ?? "");
    let result: unknown;
    try { result = { ok: await login(o) }; } catch (e) { result = { error: errOf(e), leaks: JSON.stringify(e).includes("CANARY") || inspect(e).includes("CANARY") }; }
    await callbacksDone;
    const after = port ? await hit(port, "GET", "/auth/callback?late=1", `127.0.0.1:${port}`) : null;
    const out = { name: s.name, profile, env: s.env ?? "mac", paste: s.paste ?? false, method: s.method ?? null, timeoutMs: s.timeoutMs ?? null, browser: s.browser ?? "present", ui: s.ui ?? "present", failSets: s.failSets ?? 0,
      start: T0, script: s.script, pasted: s.pasted ? sub(s.pasted) : null, events, callbacks: answers, afterwards: after, result, stored: (await store.peek(profile.secret_ref ?? "auth/test")) ?? null, requests: wire.requests, logs, clock: clock.t };
    return portless(out, port);
  } finally { random.restore(); if (catching) process.off("uncaughtException", onUncaught); }
}
async function loginCases() { const out = []; for (const s of LOGIN_SCENARIOS) out.push(await runLogin(s)); return { egress: EGRESS, resolve: RESOLVE, public: PUBLIC, envs: LOGIN_ENVS, scenarios: out }; }

// ADC: the files the source reads, by path; a path that is not listed is missing.
type AdcScenario = { name: string; profile?: Record<string, unknown>; env?: Record<string, string>; platform?: string; home?: string; files: Record<string, string>; script: Scripted[]; ops: Array<{ op: "token" } | { op: "advance"; ms: number } | { op: "concurrent"; n: number }> };
const ADC_P = { ...COMMON, id: "g:adc", kind: "adc", scopes: ["https://www.googleapis.com/auth/cloud-platform"] };
const HOME = "/home/test";
const POSIX_PATH = `${HOME}/.config/gcloud/application_default_credentials.json`;
const USER = (o: Record<string, unknown> = {}) => JSON.stringify({ type: "authorized_user", client_id: "adc-client", client_secret: "CANARY-SECRET-adc", refresh_token: "CANARY-REFRESH-adc", token_uri: "https://oauth2.example.test/token", ...o });
const SA = (o: Record<string, unknown> = {}) => JSON.stringify({ type: "service_account", client_email: "robot@example.test", private_key_id: "kid-1", private_key: armour("PRIVATE KEY", TEST_RSA_PKCS8), token_uri: "https://oauth2.example.test/token", ...o });
const ADC_SCENARIOS: AdcScenario[] = [
  { name: "authorized-user", files: { [POSIX_PATH]: USER() }, script: [tok(1), tok(2)], ops: [{ op: "token" }, { op: "advance", ms: 3_600_000 - 120_000 - 1 }, { op: "token" }, { op: "advance", ms: 1 }, { op: "token" }] },
  { name: "authorized-user-without-rotation", files: { [POSIX_PATH]: USER() }, script: [json(200, { access_token: "CANARY-ACCESS-1", token_type: "Bearer", expires_in: 100 }), json(200, { access_token: "CANARY-ACCESS-2", token_type: "Bearer", expires_in: 100 })], ops: [{ op: "token" }, { op: "advance", ms: 100_000 }, { op: "token" }] },
  { name: "concurrent-share-one-exchange", files: { [POSIX_PATH]: USER() }, script: [tok(1)], ops: [{ op: "concurrent", n: 5 }] },
  { name: "env-path-wins", env: { GOOGLE_APPLICATION_CREDENTIALS: "/etc/adc.json" }, files: { "/etc/adc.json": USER({ client_id: "env-client" }), [POSIX_PATH]: USER() }, script: [tok(1)], ops: [{ op: "token" }] },
  { name: "windows-appdata", platform: "win32", home: "C:\\Users\\test", env: { APPDATA: "D:\\Roaming" }, files: { "D:\\Roaming\\gcloud\\application_default_credentials.json": USER() }, script: [tok(1)], ops: [{ op: "token" }] },
  { name: "windows-home", platform: "win32", home: "C:\\Users\\test", files: { "C:\\Users\\test\\AppData\\Roaming\\gcloud\\application_default_credentials.json": USER() }, script: [tok(1)], ops: [{ op: "token" }] },
  { name: "profile-token-url-wins", profile: { ...ADC_P, token_endpoint: "https://accounts.example.test/token" }, files: { [POSIX_PATH]: USER() }, script: [tok(1)], ops: [{ op: "token" }] },
  { name: "default-endpoint-is-egress-checked", files: { [POSIX_PATH]: USER({ token_uri: undefined }) }, script: [], ops: [{ op: "token" }] },
  { name: "service-account", files: { [POSIX_PATH]: SA() }, script: [tok(1)], ops: [{ op: "token" }] },
  { name: "service-account-audience-no-kid", profile: { ...ADC_P, audience: "https://aud.example.test", scopes: ["a", "b"] }, files: { [POSIX_PATH]: SA({ private_key_id: undefined }) }, script: [tok(1)], ops: [{ op: "token" }] },
  { name: "service-account-without-scopes", profile: { ...ADC_P, scopes: undefined }, files: { [POSIX_PATH]: SA() }, script: [], ops: [{ op: "token" }] },
  { name: "service-account-ec-key", files: { [POSIX_PATH]: SA({ private_key: armour("PRIVATE KEY", TEST_EC_PKCS8) }) }, script: [], ops: [{ op: "token" }] },
  { name: "service-account-garbage-key", files: { [POSIX_PATH]: SA({ private_key: "CANARY-not-a-key" }) }, script: [], ops: [{ op: "token" }] },
  { name: "service-account-pkcs1", files: { [POSIX_PATH]: SA({ private_key: armour("RSA PRIVATE KEY", createPrivateKey({ key: Buffer.from(TEST_RSA_PKCS8, "base64"), format: "der", type: "pkcs8" }).export({ format: "der", type: "pkcs1" }).toString("base64")) }) }, script: [tok(1)], ops: [{ op: "token" }] },
  { name: "missing-file", files: {}, script: [], ops: [{ op: "token" }] },
  { name: "oversized-file", files: { [POSIX_PATH]: USER({ pad: "x".repeat(64 * 1024) }) }, script: [], ops: [{ op: "token" }] },
  { name: "not-json", files: { [POSIX_PATH]: "{CANARY" }, script: [], ops: [{ op: "token" }] },
  { name: "foreign-type", files: { [POSIX_PATH]: JSON.stringify({ type: "external_account" }) }, script: [], ops: [{ op: "token" }] },
  { name: "array", files: { [POSIX_PATH]: "[]" }, script: [], ops: [{ op: "token" }] },
  { name: "missing-secret", files: { [POSIX_PATH]: USER({ client_secret: "" }) }, script: [], ops: [{ op: "token" }] },
  { name: "answer-without-expiry", files: { [POSIX_PATH]: USER() }, script: [json(200, { access_token: "CANARY-ACCESS-1", token_type: "Bearer" })], ops: [{ op: "token" }] },
  { name: "invalid-grant", files: { [POSIX_PATH]: USER() }, script: [json(400, { error: "invalid_grant" })], ops: [{ op: "token" }] },
  { name: "not-adc-profile", profile: { ...COMMON, id: "g:key", kind: "api_key" }, files: { [POSIX_PATH]: USER() }, script: [], ops: [{ op: "token" }] },
  { name: "invalid-profile", profile: { ...ADC_P, policy_status: "prohibited" }, files: {}, script: [], ops: [{ op: "token" }] },
];
async function adcCases() {
  const out = [];
  for (const s of ADC_SCENARIOS) {
    const clock = new Clock(T0), wire = new Wire(s.script), reads: string[] = [];
    const profile = JSON.parse(JSON.stringify(s.profile ?? ADC_P));
    const files = JSON.parse(JSON.stringify(s.files)) as Record<string, string>;
    const adc = new GoogleAdc({ http: createOAuthHttp({ egress: wire.egress() as never }), clock, env: () => s.env ?? {}, homedir: () => s.home ?? HOME, platform: (s.platform ?? "linux") as never,
      readFile: async (p) => { reads.push(p); if (!(p in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return files[p]!; } });
    const steps = [];
    for (const op of s.ops) {
      try {
        if (op.op === "advance") { clock.t += op.ms; steps.push({ out: null }); continue; }
        const view = (t: { accessToken: string; expiresAt: number }) => ({ accessToken: t.accessToken, expiresAt: t.expiresAt, json: JSON.stringify(t), leaks: inspect(t).includes("CANARY") });
        if (op.op === "concurrent") steps.push({ out: (await Promise.all(Array.from({ length: op.n }, () => adc.token(profile)))).map(view) });
        else steps.push({ out: view(await adc.token(profile)) });
      } catch (e) { steps.push({ error: errOf(e), leaks: JSON.stringify(e).includes("CANARY") || inspect(e).includes("CANARY") }); }
    }
    out.push({ name: s.name, profile, env: s.env ?? {}, platform: s.platform ?? "linux", home: s.home ?? HOME, files, start: T0, script: s.script, ops: s.ops, steps, reads, requests: wire.requests });
  }
  return { egress: EGRESS, resolve: RESOLVE, public: PUBLIC, scenarios: out };
}

export async function buildProviderAuthVectors() {
  // `AbortSignal.timeout` does not keep the process alive; the timeout cases need it to.
  const keepAlive = setInterval(() => {}, 1_000);
  try { return await build(); } finally { clearInterval(keepAlive); }
}
async function build() {
  return piecesDeep({
    ladder: ladderCases(), profile: profileCases(), pool: poolCases(), redact: redactCases(), records: recordCases(),
    http: await httpCases(), refresh: await refreshCases(), credentials: { egress: EGRESS, resolve: RESOLVE, public: PUBLIC, scenarios: await credentialsCases() },
    login: await loginCases(), adc: await adcCases(),
  }) as Record<string, unknown>;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await exporterMain({ area: "provider-auth", build: buildProviderAuthVectors });
}
