import { redactString } from "./redact.ts";

export type SlackErrorKind =
  | "unauthorized"
  | "forbidden"
  | "bad-request"
  | "rate-limited"
  | "http"
  | "network"
  | "timeout"
  | "aborted"
  | "protocol";

/** Built from fixed text plus a sanitised Slack error code; never carries a request URL, header or token. */
export class SlackApiError extends Error {
  readonly kind: SlackErrorKind;
  readonly status?: number;
  readonly code?: string;
  readonly retryAfterMs?: number;
  constructor(kind: SlackErrorKind, message: string, extra: { status?: number; code?: string; retryAfterMs?: number } = {}) {
    super(message);
    this.name = "SlackApiError";
    this.kind = kind;
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.code !== undefined) this.code = extra.code;
    if (extra.retryAfterMs !== undefined) this.retryAfterMs = extra.retryAfterMs;
  }
}

// RULING: a server-dictated Retry-After is clamped to [1 s, 5 min]: 0 must not hot-loop, a huge value must not park the channel for hours.
export const MIN_RETRY_AFTER_MS = 1_000;
export const MAX_RETRY_AFTER_MS = 300_000;

export const DEFAULT_BASE_URL = "https://slack.com/api";
const UNAUTHORIZED = new Set(["invalid_auth", "not_authed", "account_inactive", "token_revoked", "token_expired", "invalid_token"]);
const RETRYABLE_SERVER = new Set(["internal_error", "service_unavailable", "fatal_error", "request_timeout", "team_added_to_org"]);
const FORBIDDEN = new Set([
  "missing_scope",
  "not_in_channel",
  "channel_not_found",
  "is_archived",
  "user_not_in_channel",
  "no_permission",
  "restricted_action",
  "access_denied",
  "cannot_dm_bot",
  "user_disabled",
  "not_allowed_token_type",
]);

export interface SlackApiOptions {
  botToken: string;
  appToken: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}
export interface CallOptions {
  token?: "bot" | "app";
  /** application/x-www-form-urlencoded (required by the files.* upload methods). */
  form?: boolean;
  timeoutMs?: number;
}
export interface SlackFile {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
  file_access?: string;
}

export class SlackApi {
  readonly #bot: string;
  readonly #app: string;
  readonly #base: string;
  readonly #fetch: typeof fetch;
  readonly #hosts: ReadonlySet<string>;
  constructor(opts: SlackApiOptions) {
    this.#bot = opts.botToken;
    this.#app = opts.appToken;
    this.#base = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#fetch = opts.fetch ?? fetch;
    const hosts = new Set(["files.slack.com"]);
    if (opts.baseUrl !== undefined) hosts.add(new URL(this.#base).host);
    this.#hosts = hosts;
  }

  async call<T>(method: string, body: Record<string, unknown>, outer: AbortSignal, o: CallOptions = {}): Promise<T> {
    const timeout = AbortSignal.timeout(o.timeoutMs ?? 30_000);
    const token = o.token === "app" ? this.#app : this.#bot;
    let res: Response;
    try {
      res = await this.#fetch(`${this.#base}/${method}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": o.form ? "application/x-www-form-urlencoded" : "application/json; charset=utf-8",
        },
        body: o.form
          ? new URLSearchParams(Object.entries(body).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]))
          : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.any([outer, timeout]),
      });
    } catch (err) {
      if (outer.aborted) throw new SlackApiError("aborted", `${method} aborted`);
      if (timeout.aborted) throw new SlackApiError("timeout", `${method} timed out`);
      const code = (err as { cause?: { code?: unknown } })?.cause?.code;
      throw new SlackApiError(
        "network",
        `${method} network error${typeof code === "string" && /^[A-Z_]{2,40}$/.test(code) ? ` (${code})` : ""}`,
      );
    }
    let payload: { ok?: unknown; error?: unknown } & Record<string, unknown> | undefined;
    try {
      payload = (await res.json()) as typeof payload;
    } catch {
      payload = undefined;
    }
    const status = res.status;
    if (status === 429 || payload?.error === "ratelimited" || payload?.error === "rate_limited") {
      const sec = Number(res.headers.get("retry-after"));
      const ms = Math.min(MAX_RETRY_AFTER_MS, Math.max(MIN_RETRY_AFTER_MS, Math.round((Number.isFinite(sec) ? sec : 0) * 1000)));
      throw new SlackApiError("rate-limited", `${method} rate limited`, { status, retryAfterMs: ms });
    }
    if (res.ok && payload?.ok === true) return payload as T;
    const code =
      typeof payload?.error === "string" && /^[a-z0-9_]{1,64}$/.test(payload.error) ? payload.error : undefined;
    const extra = { status, ...(code !== undefined ? { code } : {}) };
    const suffix = code ? `: ${code}` : "";
    if (status === 401 || (code && UNAUTHORIZED.has(code)))
      throw new SlackApiError("unauthorized", `${method} unauthorized${suffix}`, extra);
    if (status === 403 || (code && FORBIDDEN.has(code)))
      throw new SlackApiError("forbidden", `${method} forbidden${suffix}`, extra);
    if (status >= 500 || (code && RETRYABLE_SERVER.has(code)))
      throw new SlackApiError("http", `${method} failed with HTTP ${status}${suffix}`, extra);
    if (res.ok && !payload) throw new SlackApiError("protocol", `${method} returned a non-JSON response`, extra);
    throw new SlackApiError("bad-request", `${method} failed${suffix}`, extra);
  }

  /** apps.connections.open with the app-level token. The returned URL carries a ticket: never log it. */
  async openSocketUrl(signal: AbortSignal): Promise<string> {
    const r = await this.call<{ url?: unknown }>("apps.connections.open", {}, signal, { token: "app", form: true });
    if (typeof r.url !== "string") throw new SlackApiError("protocol", "apps.connections.open returned no url");
    return r.url;
  }

  #checkHost(raw: string, what: string): URL {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new SlackApiError("protocol", `unsafe Slack ${what} URL`);
    }
    const loopbackSeam = this.#hosts.has(u.host) && u.host !== "files.slack.com";
    if ((u.protocol !== "https:" && !(loopbackSeam && u.protocol === "http:")) || !this.#hosts.has(u.host) || u.username || u.password)
      throw new SlackApiError("protocol", `unsafe Slack ${what} URL`);
    return u;
  }

  /** Downloads a private file with the bot token. Only files.slack.com is acceptable; redirects are followed manually and
   *  every hop is re-validated, so the Authorization header can never reach another host. */
  async download(url: string, maxBytes: number, signal: AbortSignal): Promise<{ data: Uint8Array; mimeType: string }> {
    let target = this.#checkHost(url, "file");
    try {
      for (let hop = 0; hop < 4; hop++) {
        const res = await this.#fetch(target, {
          headers: { authorization: `Bearer ${this.#bot}` },
          redirect: "manual",
          signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        });
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get("location");
          await res.body?.cancel();
          if (!loc) throw new SlackApiError("protocol", "Slack file download failed");
          target = this.#checkHost(new URL(loc, target).toString(), "file");
          continue;
        }
        if (!res.ok || !res.body) throw new SlackApiError("protocol", "Slack file download failed");
        const type = (res.headers.get("content-type") ?? "application/octet-stream").split(";")[0]!.trim().toLowerCase();
        if (type === "text/html") {
          // Slack answers an expired/unauthorised download with a sign-in page, not an error status.
          await res.body.cancel();
          throw new SlackApiError("protocol", "Slack file download returned a web page");
        }
        const length = Number(res.headers.get("content-length"));
        if (length > maxBytes) {
          await res.body.cancel();
          throw new SlackApiError("protocol", "Slack file exceeds size limit");
        }
        const reader = res.body.getReader();
        const parts: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const r = await reader.read();
            if (r.done) break;
            size += r.value.length;
            if (size > maxBytes) throw new SlackApiError("protocol", "Slack file exceeds size limit");
            parts.push(r.value);
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
        return { data: Buffer.concat(parts), mimeType: type };
      }
      throw new SlackApiError("protocol", "Slack file download redirected too often");
    } catch (e) {
      if (e instanceof SlackApiError) throw e;
      throw new SlackApiError("network", "Slack file download failed");
    }
  }

  /** POSTs the bytes to the one-time upload URL returned by files.getUploadURLExternal. No bearer token is needed or sent. */
  async uploadBytes(uploadUrl: string, data: Uint8Array, signal: AbortSignal): Promise<void> {
    const target = this.#checkHost(uploadUrl, "upload");
    let res: Response;
    try {
      res = await this.#fetch(target, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array(data),
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
      });
    } catch {
      if (signal.aborted) throw new SlackApiError("aborted", "file upload aborted");
      throw new SlackApiError("network", "file upload network error");
    }
    await res.body?.cancel().catch(() => {});
    if (res.status === 429) {
      const sec = Number(res.headers.get("retry-after"));
      const ms = Math.min(MAX_RETRY_AFTER_MS, Math.max(MIN_RETRY_AFTER_MS, Math.round((Number.isFinite(sec) ? sec : 0) * 1000)));
      throw new SlackApiError("rate-limited", "file upload rate limited", { status: 429, retryAfterMs: ms });
    }
    if (!res.ok) throw new SlackApiError(res.status >= 500 ? "http" : "bad-request", `file upload failed with HTTP ${res.status}`, { status: res.status });
  }

  redact(s: string): string {
    return redactString(s, this.#bot, this.#app);
  }
}
