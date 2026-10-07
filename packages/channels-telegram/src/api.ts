import { redactString } from "./redact.ts";

export type TelegramErrorKind = "rate-limited" | "unauthorized" | "conflict" | "http" | "network" | "timeout" | "aborted" | "protocol";

/** Built from fixed text plus a redacted Telegram `description`; never carries the request URL. */
export class TelegramApiError extends Error {
  readonly kind: TelegramErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;
  constructor(kind: TelegramErrorKind, message: string, extra: { status?: number; retryAfterMs?: number } = {}) {
    super(message);
    this.name = "TelegramApiError";
    this.kind = kind;
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.retryAfterMs !== undefined) this.retryAfterMs = extra.retryAfterMs;
  }
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    text?: string;
    chat: { id: number; type: string };
    from?: { id: number };
  };
}

export interface ApiOptions {
  token: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

// RULING: a server-dictated retry_after is clamped to [1 s, 5 min]: 0 must not hot-loop, a huge value must not park the channel for hours.
export const MIN_RETRY_AFTER_MS = 1_000;
export const MAX_RETRY_AFTER_MS = 300_000;

export class TelegramApi {
  readonly #token: string;
  readonly #base: string;
  readonly #fetch: typeof fetch;
  constructor(opts: ApiOptions) {
    this.#token = opts.token;
    this.#base = (opts.baseUrl ?? "https://api.telegram.org").replace(/\/+$/, "");
    this.#fetch = opts.fetch ?? fetch;
  }

  getUpdates(offset: number | undefined, timeoutSec: number, signal: AbortSignal): Promise<TelegramUpdate[]> {
    const body: Record<string, unknown> = { timeout: timeoutSec, allowed_updates: ["message"] };
    if (offset !== undefined) body.offset = offset;
    return this.#call<TelegramUpdate[]>("getUpdates", body, signal, (timeoutSec + 15) * 1000);
  }

  async sendMessage(chatId: string, text: string, signal: AbortSignal): Promise<number> {
    const r = await this.#call<{ message_id: number }>("sendMessage", { chat_id: chatId, text }, signal, 30_000);
    if (typeof r?.message_id !== "number") throw new TelegramApiError("protocol", "sendMessage result lacks message_id");
    return r.message_id;
  }

  async #call<T>(method: string, body: unknown, outer: AbortSignal, timeoutMs: number): Promise<T> {
    const timeout = AbortSignal.timeout(timeoutMs);
    let res: Response;
    try {
      res = await this.#fetch(`${this.#base}/bot${this.#token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.any([outer, timeout]),
      });
    } catch (err) {
      if (outer.aborted) throw new TelegramApiError("aborted", `${method} aborted`);
      if (timeout.aborted) throw new TelegramApiError("timeout", `${method} timed out`);
      // The platform's own message may embed the URL; keep only a bare error code.
      const code = (err as { cause?: { code?: unknown } })?.cause?.code;
      throw new TelegramApiError("network", `${method} network error${typeof code === "string" && /^[A-Z_]{2,40}$/.test(code) ? ` (${code})` : ""}`);
    }
    let payload: { ok?: unknown; result?: unknown; description?: unknown; parameters?: { retry_after?: unknown } } | undefined;
    try {
      payload = (await res.json()) as typeof payload;
    } catch {
      payload = undefined;
    }
    if (res.ok && payload?.ok === true) return payload.result as T;
    const desc = typeof payload?.description === "string" ? redactString(payload.description.slice(0, 200), this.#token) : "";
    const status = res.status;
    if (status === 429) {
      const raw = Number(payload?.parameters?.retry_after ?? res.headers.get("retry-after"));
      const sec = Number.isFinite(raw) ? raw : 0;
      const retryAfterMs = Math.min(MAX_RETRY_AFTER_MS, Math.max(MIN_RETRY_AFTER_MS, Math.round(sec * 1000)));
      throw new TelegramApiError("rate-limited", `${method} rate limited`, { status, retryAfterMs });
    }
    const kind: TelegramErrorKind = status === 401 || status === 403 || status === 404 ? "unauthorized" : status === 409 ? "conflict" : "http";
    throw new TelegramApiError(kind, `${method} failed with HTTP ${status}${desc ? `: ${desc}` : ""}`, { status });
  }
}
