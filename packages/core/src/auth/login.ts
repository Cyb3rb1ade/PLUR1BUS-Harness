import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { inspect } from "node:util";
import type { Clock } from "./clock.ts";
import type { EnvSnapshot } from "./env.ts";
import { AuthError, type AuthErrorCode } from "./errors.ts";
import { clientFields, OAuthHttpError, parseTokenResponse, type OAuthHttp, type TokenResponse } from "./http.ts";
import { planLogin, type LoginMethod } from "./ladder.ts";
import { noLog, type AuthLog } from "./log.ts";
import { authorizeUrl, deviceUrl, tokenUrl, validateProfile, type AuthProfile } from "./profile.ts";
import { encodeRecord, type SecretStore } from "./secret-store.ts";

/** Explicit UI ports may read sensitive URLs/codes. Generic inspection/JSON never sees those values. */
export class AuthorizationPrompt {
  readonly #url: string;
  readonly #redirect: string;
  readonly sshHint: string | undefined;
  constructor(url: string, redirect: string, hint?: string) { this.#url = url; this.#redirect = redirect; this.sshHint = hint; }
  get authorizationUrl() { return this.#url; }
  get redirectUri() { return this.#redirect; }
  toJSON() { return { authorizationUrl: "[redacted]", sshHint: this.sshHint }; }
  [inspect.custom]() { return this.toJSON(); }
}
export class DevicePrompt {
  readonly #code: string;
  readonly #uri: string;
  readonly #complete: string | undefined;
  constructor(code: string, uri: string, complete?: string) { this.#code = code; this.#uri = uri; this.#complete = complete; }
  get userCode() { return this.#code; }
  get verificationUri() { return this.#uri; }
  get verificationUriComplete() { return this.#complete; }
  toJSON() { return { userCode: "[redacted]", verificationUri: "[redacted]" }; }
  [inspect.custom]() { return this.toJSON(); }
}
export interface LoginOptions {
  profile: AuthProfile;
  store: SecretStore;
  clock: Clock;
  http: OAuthHttp;
  env: EnvSnapshot;
  pasteCallback?: boolean;
  secretRef?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  openBrowser?: (url: string) => Promise<void>;
  onAuthorization?: (prompt: AuthorizationPrompt) => Promise<void>;
  readCallback?: (prompt: AuthorizationPrompt, signal: AbortSignal) => Promise<string>;
  onDevice?: (prompt: DevicePrompt) => Promise<void>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  log?: AuthLog;
}
export interface LoginResult { profileId: string; method: LoginMethod; expiresAt: number | null }
const error = (code: AuthErrorCode = "login_failed") => new AuthError(code, code === "state_mismatch" ? "Sign-in callback did not match this login." : code === "login_timeout" ? "Sign-in timed out or was cancelled." : code === "access_denied" ? "Sign-in was declined." : code === "persist_failed" ? "Sign-in could not be saved; try again." : "Sign-in failed; try again.");

function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(error("login_timeout"));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const abort = () => { clearTimeout(timer); reject(error("login_timeout")); };
  const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
  signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
});
function callbackCode(raw: string, redirect: string, state: string): string {
  let url: URL; try { url = new URL(raw); } catch { throw error(); }
  const expected = new URL(redirect);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.username || url.password || url.hash) throw error();
  const states = url.searchParams.getAll("state");
  const actual = Buffer.from(states[0] ?? ""), wanted = Buffer.from(state);
  if (states.length !== 1 || actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) throw error("state_mismatch");
  if (url.searchParams.has("error")) throw error("access_denied");
  const codes = url.searchParams.getAll("code");
  if (codes.length !== 1 || !codes[0] || codes[0].length > 8192) throw error();
  return codes[0];
}

async function pkce(o: LoginOptions, method: LoginMethod, signal: AbortSignal): Promise<TokenResponse> {
  const p = o.profile, authorize = authorizeUrl(p), endpoint = tokenUrl(p);
  if (!authorize || !endpoint) throw error();
  const state = randomBytes(32).toString("base64url"), verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  let resolveCallback!: (raw: string) => void, rejectCallback!: (e: unknown) => void;
  const callback = new Promise<string>((resolve, reject) => { resolveCallback = resolve; rejectCallback = reject; });
  // Attach a handler immediately: browser/UI ports can fail before the caller waits for a callback.
  void callback.catch(() => {});
  let consumed = false, redirect = "";
  const server = createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8"); res.setHeader("cache-control", "no-store"); res.setHeader("referrer-policy", "no-referrer"); res.setHeader("content-security-policy", "default-src 'none'");
    if (consumed) { res.writeHead(410); res.end("Sign-in closed."); return; }
    if (req.method !== "GET" || new URL(req.url ?? "/", redirect).pathname !== "/auth/callback") { res.writeHead(404); res.end("Not found."); return; }
    consumed = true;
    try {
      if (req.headers.host !== new URL(redirect).host) throw error();
      const raw = new URL(req.url!, redirect).href; callbackCode(raw, redirect, state);
      res.writeHead(200); res.end("Sign-in complete. You may close this window."); resolveCallback(raw);
    } catch (e) { res.writeHead(400); res.end("Sign-in failed. Close this window and try again."); rejectCallback(e); }
    server.close();
  });
  try {
    // A held loopback port supplies a valid redirect even in paste mode; no fixed-port collision or wildcard bind.
    await bounded(new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }), signal);
    const port = (server.address() as { port: number }).port;
    redirect = `http://127.0.0.1:${port}/auth/callback`;
    const url = new URL(authorize);
    for (const [k, v] of Object.entries({ ...clientFields(p), response_type: "code", redirect_uri: redirect, state, code_challenge: challenge, code_challenge_method: "S256", ...(p.scopes?.length ? { scope: p.scopes.join(" ") } : {}) })) url.searchParams.set(k, v);
    const plan = planLogin(p, o.env, { pasteCallback: o.pasteCallback });
    const prompt = new AuthorizationPrompt(url.href, redirect, method === "loopback_ssh" ? plan.sshHint?.(port) : undefined);
    let raw: string;
    if (method === "paste_callback") {
      if (!o.readCallback) throw error();
      await bounded(o.onAuthorization?.(prompt) ?? Promise.resolve(), signal);
      raw = await bounded(o.readCallback(prompt, signal), signal);
    } else {
      // Do not await a potentially hanging UI port before observing the callback or timeout.
      const ui = Promise.resolve().then(async () => {
        if (method === "loopback_pkce") { if (!o.openBrowser) throw error(); await o.openBrowser(url.href); }
        else { if (!o.onAuthorization) throw error(); await o.onAuthorization(prompt); }
        return await callback;
      });
      raw = await bounded(Promise.race([callback, ui]), signal);
    }
    const code = callbackCode(raw, redirect, state);
    consumed = true;
    server.closeAllConnections(); server.close();
    return parseTokenResponse(await bounded(o.http.post(endpoint, { ...clientFields(p), grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: verifier }, signal), signal));
  } finally { server.closeAllConnections(); server.close(); }
}

async function device(o: LoginOptions, signal: AbortSignal): Promise<TokenResponse> {
  const p = o.profile, endpoint = tokenUrl(p), deviceEndpoint = deviceUrl(p);
  if (!endpoint || !deviceEndpoint) throw error();
  const data = await bounded(o.http.post(deviceEndpoint, { ...clientFields(p), ...(p.scopes?.length ? { scope: p.scopes.join(" ") } : {}) }, signal), signal);
  if (typeof data.device_code !== "string" || !data.device_code || typeof data.user_code !== "string" || !data.user_code || typeof data.verification_uri !== "string" || typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw error();
  const uri = new URL(data.verification_uri);
  if (uri.username || uri.password || (uri.protocol !== "https:" && !(uri.protocol === "http:" && uri.hostname === "127.0.0.1"))) throw error();
  if (data.interval !== undefined && (typeof data.interval !== "number" || !Number.isFinite(data.interval) || data.interval <= 0)) throw error();
  const end = o.clock.now() + data.expires_in * 1000;
  let interval = (typeof data.interval === "number" ? data.interval : 5) * 1000;
  await bounded(o.onDevice?.(new DevicePrompt(data.user_code, data.verification_uri, typeof data.verification_uri_complete === "string" ? data.verification_uri_complete : undefined)) ?? Promise.resolve(), signal);
  while (o.clock.now() < end) {
    await bounded((o.sleep ?? sleep)(Math.min(interval, end - o.clock.now()), signal), signal);
    if (o.clock.now() >= end) break;
    try {
      return parseTokenResponse(await bounded(o.http.post(endpoint, { ...clientFields(p), grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: data.device_code }, signal), signal));
    } catch (e) {
      if (!(e instanceof OAuthHttpError)) throw e;
      if (e.code === "authorization_pending") continue;
      if (e.code === "slow_down") { interval += 5000; continue; }
      if (e.retryable) { interval = Math.min(interval * 2, 60_000); continue; }
      if (e.code === "expired_token") throw error("login_timeout");
      if (e.code === "access_denied") throw error("access_denied");
      throw error();
    }
  }
  throw error("login_timeout");
}

/** In-process engine API only. Callers explicitly retry a selected fallback; denial/state failures never silently
 *  start another login. No credential leaves this function's result. */
export async function login(o: LoginOptions): Promise<LoginResult> {
  const profile = validateProfile(o.profile); // policy gate before side effects, including direct callers
  const log = o.log ?? noLog;
  const timeoutMs = o.timeoutMs ?? 600_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw error();
  const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(o.signal ? [o.signal] : [])]);
  const method = planLogin(profile, o.env, { pasteCallback: o.pasteCallback }).method;
  const ref = o.secretRef ?? profile.secret_ref;
  if (!ref) throw error();
  try {
    if (signal.aborted) throw error("login_timeout");
    const tokens = method === "device_code" ? await device({ ...o, profile }, signal) : ["loopback_pkce", "loopback_ssh", "paste_callback"].includes(method) ? await pkce({ ...o, profile }, method, signal) : (() => { throw error(); })();
    const now = o.clock.now(), expiresAt = tokens.expiresInSeconds === undefined ? undefined : now + tokens.expiresInSeconds * 1000;
    try {
      await o.store.set(ref, encodeRecord({ v: 1, accessToken: tokens.accessToken, generation: 0, ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}), ...(expiresAt !== undefined ? { expiresAt } : {}), ...(tokens.refreshExpiresInSeconds !== undefined ? { refreshExpiresAt: now + tokens.refreshExpiresInSeconds * 1000 } : {}) }));
    } catch { throw error("persist_failed"); }
    log("auth.login.ok", { profileId: profile.id, method });
    return { profileId: profile.id, method, expiresAt: expiresAt ?? null };
  } catch (e) {
    const safe = e instanceof AuthError ? error(e.code) : error(e instanceof OAuthHttpError && e.code === "access_denied" ? "access_denied" : "login_failed");
    log("auth.login.failed", { profileId: profile.id, code: safe.code }); throw safe;
  }
}
