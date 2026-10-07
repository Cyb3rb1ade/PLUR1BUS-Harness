import { TelegramApi, TelegramApiError, type TelegramUpdate } from "./api.ts";
import { redactAttrs } from "./redact.ts";
import { splitMessage } from "./split.ts";
import type { ChannelLogger, ChannelPort, InboundHandler, LogLevel, OffsetStore, SecretReader } from "./port.ts";

export interface TelegramChannelOptions {
  /** Name of the bot-token secret in the secret store. The token itself is never accepted here. */
  tokenSecret: string;
  secrets: SecretReader;
  /** Allowed chat ids. RULING: no default; an empty list allows nothing, in both directions. */
  allowlist: readonly (string | number)[];
  offsetStore: OffsetStore;
  logger?: ChannelLogger;
  /** Test seams. */
  baseUrl?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  pollTimeoutSec?: number;
  /** Retries of a rate-limited send (429). */
  maxSendRetries?: number;
}

const CHAT_ID = /^-?\d{1,20}$/;
const TOKEN_FORMAT = /^\d{3,}:[A-Za-z0-9_-]{20,}$/;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

export function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export class TelegramChannel implements ChannelPort {
  readonly id = "telegram";
  readonly #o: TelegramChannelOptions;
  readonly #allow: ReadonlySet<string>;
  readonly #handlers = new Set<InboundHandler>();
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  #api: TelegramApi | undefined;
  #token: string | undefined;
  #ac: AbortController | undefined;
  #loop: Promise<void> | undefined;
  #offset: number | undefined;

  constructor(opts: TelegramChannelOptions) {
    this.#o = opts;
    const allow = new Set<string>();
    for (const v of opts.allowlist) {
      const s = String(v);
      if (!CHAT_ID.test(s)) throw new RangeError("allowlist entries must be decimal chat ids"); // never echo the entry
      allow.add(s);
    }
    this.#allow = allow;
    this.#sleep = opts.sleep ?? defaultSleep;
  }

  onMessage(handler: InboundHandler): () => void {
    this.#handlers.add(handler);
    return () => void this.#handlers.delete(handler);
  }

  async start(): Promise<void> {
    if (this.#loop) return;
    const token = await this.#o.secrets.reveal(this.#o.tokenSecret);
    if (token === null) throw new Error("telegram bot token secret is not set");
    if (!TOKEN_FORMAT.test(token)) throw new Error("telegram bot token secret has an unexpected format");
    this.#token = token;
    this.#api = new TelegramApi({
      token,
      ...(this.#o.baseUrl !== undefined ? { baseUrl: this.#o.baseUrl } : {}),
      ...(this.#o.fetch !== undefined ? { fetch: this.#o.fetch } : {}),
    });
    this.#offset = await this.#o.offsetStore.load();
    this.#ac = new AbortController();
    this.#log("info", "channel.telegram.started", { allowed: this.#allow.size, resumed: this.#offset !== undefined });
    this.#loop = this.#poll(this.#ac.signal);
  }

  async stop(): Promise<void> {
    this.#ac?.abort();
    await this.#loop;
    this.#loop = undefined;
    this.#ac = undefined;
    this.#log("info", "channel.telegram.stopped", {});
  }

  async send(chatId: string, text: string): Promise<readonly string[]> {
    if (!this.#api) throw new Error("telegram channel is not started");
    // RULING: outbound is allowlisted too; a chat that may not talk to the bot is not talked to.
    if (!this.#allow.has(chatId)) throw new Error("chat is not on the telegram allowlist");
    const ids: string[] = [];
    const signal = this.#ac?.signal ?? new AbortController().signal;
    for (const chunk of splitMessage(text)) {
      ids.push(String(await this.#sendChunk(this.#api, chatId, chunk, signal)));
    }
    return ids;
  }

  async #sendChunk(api: TelegramApi, chatId: string, chunk: string, signal: AbortSignal): Promise<number> {
    const max = this.#o.maxSendRetries ?? 3;
    for (let attempt = 0; ; attempt++) {
      try {
        return await api.sendMessage(chatId, chunk, signal);
      } catch (err) {
        if (!(err instanceof TelegramApiError) || err.kind !== "rate-limited" || attempt >= max || signal.aborted) throw err;
        this.#log("warn", "channel.telegram.rate-limited", { method: "sendMessage", retryAfterMs: err.retryAfterMs ?? 0, attempt });
        await this.#sleep(err.retryAfterMs ?? 1_000, signal);
        if (signal.aborted) throw err;
      }
    }
  }

  async #poll(signal: AbortSignal): Promise<void> {
    const api = this.#api!;
    let backoff = 0;
    while (!signal.aborted) {
      let updates: TelegramUpdate[];
      try {
        updates = await api.getUpdates(this.#offset, this.#o.pollTimeoutSec ?? 30, signal);
        backoff = 0;
      } catch (err) {
        if (signal.aborted) break;
        const e = err instanceof TelegramApiError ? err : new TelegramApiError("protocol", "unexpected poll failure");
        if (e.kind === "unauthorized") {
          // RULING: a rejected token is not retried; polling stops until the channel is restarted with a fixed secret.
          this.#log("error", "channel.telegram.auth-failed", { status: e.status ?? 0 });
          return;
        }
        const wait = e.kind === "rate-limited" ? (e.retryAfterMs ?? BACKOFF_MIN_MS) : (backoff = Math.min(BACKOFF_MAX_MS, backoff === 0 ? BACKOFF_MIN_MS : backoff * 2));
        this.#log("warn", "channel.telegram.poll-failed", { kind: e.kind, waitMs: wait });
        await this.#sleep(wait, signal);
        continue;
      }
      for (const u of updates) {
        if (typeof u?.update_id !== "number") continue;
        await this.#dispatch(u);
        // RULING: at-most-once. The offset advances after dispatch whatever the handlers did, so a poison message is not replayed forever.
        this.#offset = u.update_id + 1;
        try {
          await this.#o.offsetStore.save(this.#offset);
        } catch {
          this.#log("error", "channel.telegram.offset-save-failed", {});
        }
      }
    }
  }

  async #dispatch(u: TelegramUpdate): Promise<void> {
    const m = u.message;
    if (!m || typeof m.text !== "string" || m.text.length === 0 || typeof m.chat?.id !== "number") return; // text only
    const chatId = String(m.chat.id);
    if (!this.#allow.has(chatId)) {
      // No reply and no content: an unlisted chat learns nothing about the bot.
      this.#log("warn", "channel.telegram.rejected", { chatId });
      return;
    }
    const message = {
      channel: this.id,
      chatId,
      messageId: String(m.message_id),
      ...(m.from ? { senderId: String(m.from.id) } : {}),
      text: m.text,
      sentAt: m.date * 1000,
    };
    for (const h of [...this.#handlers]) {
      try {
        await h(message);
      } catch (err) {
        this.#log("error", "channel.telegram.handler-failed", { error: err instanceof Error ? err.name : "unknown" });
      }
    }
  }

  #log(level: LogLevel, event: string, attrs: Record<string, string | number | boolean>): void {
    this.#o.logger?.log(level, event, redactAttrs(attrs, this.#token));
  }
}

