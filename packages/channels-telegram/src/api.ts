import { redactString } from "./redact.ts";

export type TelegramErrorKind =
  | "bad-request"
  | "forbidden"
  | "rate-limited"
  | "unauthorized"
  | "conflict"
  | "http"
  | "network"
  | "timeout"
  | "aborted"
  | "protocol";

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

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  username?: string;
}
export interface TelegramMedia {
  file_id: string;
  file_size?: number;
  mime_type?: string;
  file_name?: string;
}
export interface TelegramMessage {
  message_id: number;
  date: number;
  text?: string;
  caption?: string;
  chat: { id: number; type: string; is_forum?: boolean };
  from?: TelegramUser;
  message_thread_id?: number;
  reply_to_message?: { from?: TelegramUser };
  entities?: {
    type: string;
    offset: number;
    length: number;
    user?: TelegramUser;
  }[];
  caption_entities?: {
    type: string;
    offset: number;
    length: number;
    user?: TelegramUser;
  }[];
  photo?: TelegramMedia[];
  document?: TelegramMedia;
  voice?: TelegramMedia;
  audio?: TelegramMedia;
  video?: TelegramMedia;
  migrate_to_chat_id?: number;
  migrate_from_chat_id?: number;
}
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: {
    id: string;
    from: TelegramUser;
    data?: string;
    message?: TelegramMessage;
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
    const body: Record<string, unknown> = {
      timeout: timeoutSec,
      allowed_updates: ["message", "callback_query"],
    };
    if (offset !== undefined) body.offset = offset;
    return this.#call<TelegramUpdate[]>("getUpdates", body, signal, (timeoutSec + 15) * 1000);
  }

  async sendMessage(
    chatId: string,
    text: string,
    signal: AbortSignal,
    extra: Record<string, unknown> = {},
  ): Promise<number> {
    const r = await this.#call<{ message_id: number }>(
      "sendMessage",
      { ...extra, chat_id: chatId, text },
      signal,
      30_000,
    );
    if (typeof r?.message_id !== "number")
      throw new TelegramApiError("protocol", "sendMessage result lacks message_id");
    return r.message_id;
  }

  call<T>(
    method:
      | "getMe"
      | "getFile"
      | "setWebhook"
      | "deleteWebhook"
      | "setMyCommands"
      | "answerCallbackQuery"
      | "sendPhoto"
      | "sendDocument"
      | "sendVoice"
      | "sendAudio"
      | "sendVideo",
    body: unknown,
    signal: AbortSignal,
  ): Promise<T> {
    return this.#call<T>(method, body, signal, 30_000);
  }

  async download(path: string, maxBytes: number, signal: AbortSignal): Promise<{ data: Uint8Array; mimeType: string }> {
    // Reject traversal, absolute paths, encoded separators and redirects before exposing the token to a destination.
    if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(path) || path.split("/").some((p) => p === "." || p === ".."))
      throw new TelegramApiError("protocol", "unsafe Telegram file path");
    try {
      const res = await this.#fetch(`${this.#base}/file/bot${this.#token}/${path}`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        redirect: "error",
      });
      if (!res.ok || !res.body) throw new TelegramApiError("protocol", "Telegram file download failed");
      const length = Number(res.headers.get("content-length"));
      if (length > maxBytes) {
        await res.body.cancel();
        throw new TelegramApiError("protocol", "Telegram file exceeds size limit");
      }
      const reader = res.body.getReader();
      const parts: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const r = await reader.read();
          if (r.done) break;
          size += r.value.length;
          if (size > maxBytes) throw new TelegramApiError("protocol", "Telegram file exceeds size limit");
          parts.push(r.value);
        }
      } finally {
        await reader.cancel();
      }
      return {
        data: Buffer.concat(parts),
        mimeType: (res.headers.get("content-type") ?? "application/octet-stream").split(";")[0]!.trim().toLowerCase(),
      };
    } catch (e) {
      if (e instanceof TelegramApiError) throw e;
      throw new TelegramApiError("network", "Telegram file download failed");
    }
  }

  async #call<T>(method: string, body: unknown, outer: AbortSignal, timeoutMs: number): Promise<T> {
    const timeout = AbortSignal.timeout(timeoutMs);
    let res: Response;
    try {
      res = await this.#fetch(`${this.#base}/bot${this.#token}/${method}`, {
        method: "POST",
        ...(body instanceof FormData
          ? { body }
          : {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
        redirect: "error",
        signal: AbortSignal.any([outer, timeout]),
      });
    } catch (err) {
      if (outer.aborted) throw new TelegramApiError("aborted", `${method} aborted`);
      if (timeout.aborted) throw new TelegramApiError("timeout", `${method} timed out`);
      // The platform's own message may embed the URL; keep only a bare error code.
      const code = (err as { cause?: { code?: unknown } })?.cause?.code;
      throw new TelegramApiError(
        "network",
        `${method} network error${typeof code === "string" && /^[A-Z_]{2,40}$/.test(code) ? ` (${code})` : ""}`,
      );
    }
    let payload:
      | {
          ok?: unknown;
          result?: unknown;
          description?: unknown;
          parameters?: { retry_after?: unknown };
        }
      | undefined;
    try {
      payload = (await res.json()) as typeof payload;
    } catch {
      payload = undefined;
    }
    if (res.ok && payload?.ok === true) return payload.result as T;
    const desc =
      typeof payload?.description === "string" ? redactString(payload.description, this.#token).slice(0, 200) : "";
    const status = res.status;
    if (status === 429) {
      const raw = Number(payload?.parameters?.retry_after ?? res.headers.get("retry-after"));
      const sec = Number.isFinite(raw) ? raw : 0;
      const retryAfterMs = Math.min(MAX_RETRY_AFTER_MS, Math.max(MIN_RETRY_AFTER_MS, Math.round(sec * 1000)));
      throw new TelegramApiError("rate-limited", `${method} rate limited`, {
        status,
        retryAfterMs,
      });
    }
    const kind: TelegramErrorKind =
      status === 400
        ? "bad-request"
        : status === 403
          ? "forbidden"
          : status === 401 || status === 404
            ? "unauthorized"
            : status === 409
              ? "conflict"
              : "http";
    throw new TelegramApiError(kind, `${method} failed with HTTP ${status}${desc ? `: ${desc}` : ""}`, { status });
  }
}
