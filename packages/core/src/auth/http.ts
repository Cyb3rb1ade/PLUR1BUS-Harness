import * as http from "node:http";
import * as https from "node:https";
import { inspect } from "node:util";
import type { Egress } from "../egress/service.ts";
import { tokenUrl, validateProfile, type AuthProfile } from "./profile.ts";
import { RefreshRejected, type Refresher, type RefreshResult } from "./refresh.ts";

export interface OAuthHttp { post(url: string, form: Record<string, string>, signal?: AbortSignal): Promise<Record<string, unknown>> }
const WIRE_ERRORS = new Set(["invalid_grant", "authorization_pending", "slow_down", "expired_token", "access_denied", "invalid_client", "invalid_request", "unsupported_grant_type"]);
/** No response text, endpoint, form or foreign error survives this boundary. */
export class OAuthHttpError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, retryable = false) { super("OAuth endpoint request failed."); this.name = "OAuthHttpError"; this.code = code; this.retryable = retryable; }
}

/** Egress currently exposes a GET client. For token POSTs use its checked/pinned address, original TLS name,
 *  bounded body and whole-request deadline. Never follow redirects carrying credentials. */
export function createOAuthHttp(o: { egress: Pick<Egress, "decide">; timeoutMs?: number; maxBytes?: number }): OAuthHttp {
  return {
    async post(raw, form, signal) {
      try {
        const timeoutMs = o.timeoutMs ?? 30_000;
        const deadline = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
        const decision = await Promise.race([o.egress.decide(raw), new Promise<never>((_, reject) => {
          if (deadline.aborted) reject(new OAuthHttpError("transient", true));
          else deadline.addEventListener("abort", () => reject(new OAuthHttpError("transient", true)), { once: true });
        })]);
        if (!decision.allowed) throw new OAuthHttpError("egress_denied");
        deadline.throwIfAborted();
        const url = new URL(raw);
        if (url.username || url.password || !["https:", "http:"].includes(url.protocol)) throw new OAuthHttpError("invalid_request");
        const body = new URLSearchParams(form).toString();
        return await new Promise<Record<string, unknown>>((resolve, reject) => {
          const request = (url.protocol === "https:" ? https : http).request(url, {
            method: "POST", agent: false, signal: deadline,
            lookup: (_hostname, options, cb) => {
              if (typeof options === "object" && options.all) cb(null, [{ address: decision.address, family: decision.family }]);
              else cb(null, decision.address, decision.family);
            },
            headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "content-length": Buffer.byteLength(body), "user-agent": "PLUR1BUS-auth" },
          }, response => {
            const chunks: Buffer[] = []; let size = 0;
            response.on("data", chunk => {
              size += chunk.length;
              if (size > (o.maxBytes ?? 64 * 1024)) { response.destroy(); request.destroy(); reject(new OAuthHttpError("invalid_response")); }
              else chunks.push(Buffer.from(chunk));
            });
            response.on("error", () => reject(new OAuthHttpError("transient", true)));
            response.on("end", () => {
              try {
                const status = response.statusCode ?? 0;
                if (status >= 500 || status === 429 || status === 408) throw new OAuthHttpError("transient", true);
                if (status >= 300 && status < 400) throw new OAuthHttpError("redirect_refused");
                const json: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                if (!json || typeof json !== "object" || Array.isArray(json)) throw new OAuthHttpError("invalid_response");
                const data = json as Record<string, unknown>;
                if (data.error !== undefined || status < 200 || status >= 300) throw new OAuthHttpError(typeof data.error === "string" && WIRE_ERRORS.has(data.error) ? data.error : "endpoint_rejected");
                Object.defineProperty(data, "toJSON", { value: () => ({ response: "[redacted]" }) });
                Object.defineProperty(data, inspect.custom, { value: () => ({ response: "[redacted]" }) });
                resolve(data);
              } catch (e) { reject(e instanceof OAuthHttpError ? e : new OAuthHttpError("invalid_response")); }
            });
          });
          request.on("error", () => reject(new OAuthHttpError("transient", true)));
          request.end(body);
        });
      } catch (e) { throw e instanceof OAuthHttpError ? e : new OAuthHttpError("transient", true); }
    },
  };
}

/** Private fields prevent tokens appearing in snapshots/inspection of transport results. */
export class TokenResponse implements RefreshResult {
  readonly #data: RefreshResult;
  constructor(data: RefreshResult) { this.#data = data; }
  get accessToken() { return this.#data.accessToken; }
  get refreshToken() { return this.#data.refreshToken; }
  get expiresInSeconds() { return this.#data.expiresInSeconds; }
  get refreshExpiresInSeconds() { return this.#data.refreshExpiresInSeconds; }
  toJSON() { return { token: "[redacted]" }; }
  [inspect.custom]() { return this.toJSON(); }
}

export function parseTokenResponse(data: Record<string, unknown>): TokenResponse {
  if (typeof data.access_token !== "string" || !data.access_token || /[\r\n]/.test(data.access_token)) throw new OAuthHttpError("invalid_response");
  if (typeof data.token_type !== "string" || data.token_type.toLowerCase() !== "bearer") throw new OAuthHttpError("invalid_response");
  if (data.refresh_token !== undefined && (typeof data.refresh_token !== "string" || !data.refresh_token)) throw new OAuthHttpError("invalid_response");
  for (const k of ["expires_in", "refresh_expires_in"]) if (data[k] !== undefined && (typeof data[k] !== "number" || !Number.isFinite(data[k]) || Number(data[k]) <= 0)) throw new OAuthHttpError("invalid_response");
  return new TokenResponse({ accessToken: data.access_token, ...(typeof data.refresh_token === "string" ? { refreshToken: data.refresh_token } : {}), ...(typeof data.expires_in === "number" ? { expiresInSeconds: data.expires_in } : {}), ...(typeof data.refresh_expires_in === "number" ? { refreshExpiresInSeconds: data.refresh_expires_in } : {}) });
}

export function clientFields(p: AuthProfile): Record<string, string> {
  if (p.client_registration === "dynamic") throw new OAuthHttpError("unsupported_registration");
  return { ...(p.client_id ? { client_id: p.client_id } : {}), ...(p.audience ? { audience: p.audience } : {}) };
}

export class HttpRefresher implements Refresher {
  readonly #http: OAuthHttp;
  constructor(http: OAuthHttp) { this.#http = http; }
  async refresh(req: { profile: AuthProfile; refreshToken: string }): Promise<RefreshResult> {
    try {
      const p = validateProfile(req.profile), endpoint = tokenUrl(p);
      if (!endpoint) throw new OAuthHttpError("invalid_request");
      return parseTokenResponse(await this.#http.post(endpoint, { ...clientFields(p), grant_type: "refresh_token", refresh_token: req.refreshToken }));
    } catch (e) { throw new RefreshRejected(e instanceof OAuthHttpError && e.code === "invalid_grant" ? "invalid_grant" : "transient"); }
  }
}
