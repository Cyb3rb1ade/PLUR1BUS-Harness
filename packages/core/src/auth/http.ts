import { inspect } from "node:util";
import type { Egress } from "../egress/service.ts";
import { WebFailure } from "../tools/web/failure.ts";
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

/** What the egress client's refusals and failures mean to an OAuth caller. Codes only: no text of the failure survives. */
function oauthFailure(e: unknown): OAuthHttpError {
  if (e instanceof OAuthHttpError) return e;
  if (e instanceof WebFailure) {
    // A URL the client refuses (malformed, embedded credentials, a scheme it does not speak) was an egress refusal before too.
    if (e.code === "egress-denied" || e.code === "private-address" || e.code === "not-found" || e.code === "invalid-url") return new OAuthHttpError("egress_denied");
    if (e.code === "too-large" || e.code === "unsupported-type") return new OAuthHttpError("invalid_response");
  }
  return new OAuthHttpError("transient", true);
}

/** The token POST goes through `egress.request` (the POST-capable variant): the gate and the SSRF check judge every hop,
 *  the connect is pinned to the vetted address under the original TLS name, the request and response are capped, one
 *  deadline covers the whole call, and a redirect is never followed (a 3xx is refused, so the form and its credentials
 *  never reach another host). This file opens no socket of its own. */
export function createOAuthHttp(o: { egress: Pick<Egress, "request">; timeoutMs?: number; maxBytes?: number }): OAuthHttp {
  return {
    async post(raw, form, signal) {
      try {
        const timeoutMs = o.timeoutMs ?? 30_000, maxBytes = o.maxBytes ?? 64 * 1024;
        const deadline = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
        const response = await Promise.race([
          o.egress.request(raw, {
            userAgent: "PLUR1BUS-auth", accept: "application/json", method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams(form).toString(), maxBytes, errorBodyBytes: maxBytes, timeoutMs, signal: deadline,
          }),
          new Promise<never>((_, reject) => {
            if (deadline.aborted) reject(new OAuthHttpError("transient", true));
            else deadline.addEventListener("abort", () => reject(new OAuthHttpError("transient", true)), { once: true });
          }),
        ]);
        const status = response.status;
        if (status >= 500 || status === 429 || status === 408) throw new OAuthHttpError("transient", true);
        if (status >= 300 && status < 400) throw new OAuthHttpError("redirect_refused");
        let json: unknown;
        try { json = JSON.parse(response.body.toString("utf8")); } catch { throw new OAuthHttpError("invalid_response"); }
        if (!json || typeof json !== "object" || Array.isArray(json)) throw new OAuthHttpError("invalid_response");
        const data = json as Record<string, unknown>;
        if (data.error !== undefined || status < 200 || status >= 300) throw new OAuthHttpError(typeof data.error === "string" && WIRE_ERRORS.has(data.error) ? data.error : "endpoint_rejected");
        Object.defineProperty(data, "toJSON", { value: () => ({ response: "[redacted]" }) });
        Object.defineProperty(data, inspect.custom, { value: () => ({ response: "[redacted]" }) });
        return data;
      } catch (e) { throw oauthFailure(e); }
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
