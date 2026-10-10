import { outputAttachment, type OutputPort } from "./outputs.ts";
import type { IdentityService } from "../../core/src/identity/service.ts";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Channel, ChannelHost, OutboundMessage } from "../../core/src/channels/types.ts";
import { TelegramApi, TelegramApiError, type TelegramUpdate, type TelegramMessage } from "./api.ts";
import { CallbackSigner } from "./callback.ts";
import { TokenBucket } from "./rate-limit.ts";
import { redactAttrs } from "./redact.ts";
import { splitMessage, escapeText } from "./split.ts";
import type {
  Attachment,
  Button,
  ChannelLogger,
  ChannelPort,
  ConfirmPrompt,
  InboundHandler,
  InboundMessage,
  LogLevel,
  OffsetStore,
  OutboundTurn,
  SecretReader,
  WebLinkProvider,
} from "./port.ts";

export interface TelegramChannelOptions {
  /** Host-supplied private pairing port; authenticated sender triple comes from Telegram, never command text. */
  pairing?: Pick<IdentityService, "claim">;
  outputs?: OutputPort;
  tokenSecret: string;
  secrets: SecretReader;
  /** Empty allows nobody, inbound and outbound. */
  allowlist: readonly (string | number)[];
  userAllowlist?: readonly (string | number)[];
  offsetStore: OffsetStore;
  logger?: ChannelLogger;
  mode?: "polling" | "webhook";
  webhook?: { url: string; secret: string; maxBodyBytes?: number };
  botId?: number;
  botUsername?: string;
  groupPolicy?: "addressed" | "all";
  maxMediaBytes?: number;
  webLinkProvider?: WebLinkProvider;
  /** Additional existing command-set entries to advertise; execution remains host-owned. */
  commands?: readonly { command: string; description: string }[];
  commandScopes?: readonly {
    type: "all_private_chats" | "all_group_chats" | "chat";
    chat_id?: string | number;
  }[];
  baseUrl?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  random?: () => number;
  pollTimeoutSec?: number;
  maxSendRetries?: number;
}
const CHAT_ID = /^-?\d{1,20}$/;
const TOKEN_FORMAT = /^\d{3,}:[A-Za-z0-9_-]{20,}$/;
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

/** Implements the current framework contract and the original #157 convenience port. */
export class TelegramChannel implements Channel, ChannelPort, ConfirmPrompt {
  readonly id = "telegram";
  readonly name = "telegram";
  readonly #o: TelegramChannelOptions;
  readonly #allow: Set<string>;
  readonly #users: Set<string> | undefined;
  readonly #handlers = new Set<InboundHandler>();
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly #global: TokenBucket;
  readonly #chats = new Map<string, TokenBucket>();
  readonly #inactive = new Set<string>();
  readonly #migrations = new Map<string, string>();
  readonly #signer: CallbackSigner;
  #host: ChannelHost | undefined;
  #api: TelegramApi | undefined;
  #token: string | undefined;
  #ac: AbortController | undefined;
  #loop: Promise<void> | undefined;
  #starting: Promise<void> | undefined;
  #offset: number | undefined;
  #botId: number | undefined;
  #botUsername: string | undefined;
  #healthy = false;
  #updates: Promise<void> = Promise.resolve();
  readonly #seen = new Set<number>();
  constructor(opts: TelegramChannelOptions) {
    this.#o = opts;
    this.#allow = new Set(opts.allowlist.map(String));
    this.#users = opts.userAllowlist && new Set(opts.userAllowlist.map(String));
    if ([...this.#allow, ...(this.#users ?? [])].some((s) => !CHAT_ID.test(s)))
      throw new RangeError("allowlist entries must be decimal chat ids");
    const max = opts.maxMediaBytes ?? 20 * 1024 * 1024;
    if (!Number.isSafeInteger(max) || max < 1 || max > 20 * 1024 * 1024)
      throw new RangeError("maxMediaBytes must be 1..20 MiB");
    if (opts.mode === "webhook") {
      const w = opts.webhook;
      if (!w || !/^[A-Za-z0-9_-]{1,256}$/.test(w.secret)) throw new Error("valid webhook secret is required");
      let u: URL;
      try {
        u = new URL(w.url);
      } catch {
        throw new Error("valid HTTPS webhook URL is required");
      }
      if (u.protocol !== "https:" || u.username || u.password) throw new Error("valid HTTPS webhook URL is required");
    }
    this.#sleep = opts.sleep ?? defaultSleep;
    this.#global = new TokenBucket(30, 1000 / 30, opts.now ?? Date.now, this.#sleep);
    this.#signer = new CallbackSigner(randomBytes(32).toString("hex"), opts.now ?? Date.now);
  }
  onMessage(handler: InboundHandler): () => void {
    this.#handlers.add(handler);
    return () => void this.#handlers.delete(handler);
  }
  start(host?: ChannelHost): Promise<void> {
    if (this.#starting) return this.#starting;
    if (this.#ac) return Promise.resolve();
    this.#starting = this.#start(host).finally(() => {
      this.#starting = undefined;
    });
    return this.#starting;
  }
  async #start(host?: ChannelHost): Promise<void> {
    const ac = new AbortController();
    this.#ac = ac;
    const signal = ac.signal;
    try {
      let token: string | null;
      try {
        token = await this.#o.secrets.reveal(this.#o.tokenSecret);
      } catch {
        throw new Error("telegram secret read failed");
      }
      if (token === null) throw new TelegramApiError("protocol", "telegram bot token secret is not set");
      if (!TOKEN_FORMAT.test(token))
        throw new TelegramApiError("protocol", "telegram bot token secret has an unexpected format");
      this.#token = token;
      this.#host = host;
      this.#api = new TelegramApi({
        token,
        ...(this.#o.baseUrl !== undefined ? { baseUrl: this.#o.baseUrl } : {}),
        ...(this.#o.fetch !== undefined ? { fetch: this.#o.fetch } : {}),
      });
      signal.throwIfAborted();
      this.#inactive.clear();
      this.#chats.clear();
      this.#offset = await this.#o.offsetStore.load();
      this.#seen.clear();
      const migrations = (await this.#o.offsetStore.loadMigrations?.()) ?? {};
      for (const [from, to] of Object.entries(migrations))
        if (this.#allow.has(from)) {
          this.#migrations.set(from, to);
          this.#allow.delete(from);
          this.#allow.add(to);
        }
      const me = await this.#api.call<{ id: number; username?: string }>("getMe", {}, signal);
      this.#botId = this.#o.botId ?? me.id;
      this.#botUsername = this.#o.botUsername ?? me.username;
      await this.#registerCommands(signal);
      if (this.#o.mode === "webhook") {
        await this.#api.call(
          "setWebhook",
          {
            url: this.#o.webhook!.url,
            secret_token: this.#o.webhook!.secret,
            allowed_updates: ["message", "callback_query"],
            drop_pending_updates: false,
          },
          signal,
        );
      } else {
        await this.#api.call("deleteWebhook", { drop_pending_updates: false }, signal);
        this.#loop = this.#poll(signal);
      }
      this.#healthy = true;
      this.#log("info", "channel.telegram.started", {
        allowed: this.#allow.size,
        resumed: this.#offset !== undefined,
      });
    } catch (e) {
      ac.abort();
      this.#healthy = false;
      this.#ac = undefined;
      this.#api = undefined;
      this.#host = undefined;
      // Preserve #157's asynchronous auth-failure behaviour for standalone users; framework start must reject.
      if (!host && e instanceof TelegramApiError && e.kind === "unauthorized") {
        this.#log("error", "channel.telegram.auth-failed", {});
        return;
      }
      throw e instanceof TelegramApiError ? e : new Error("telegram start failed");
    }
  }
  async stop(): Promise<void> {
    this.#healthy = false;
    this.#ac?.abort();
    await this.#starting?.catch(() => {});
    await this.#loop;
    await this.#updates;
    this.#signer.clear();
    this.#loop = undefined;
    this.#ac = undefined;
    this.#api = undefined;
    this.#host = undefined;
    this.#token = undefined;
    this.#log("info", "channel.telegram.stopped", {});
  }
  async health(): Promise<{ ok: boolean }> {
    return { ok: this.#healthy };
  }
  send(msg: OutboundMessage): Promise<void>;
  send(chatId: string, text: string): Promise<readonly string[]>;
  async send(msg: string | OutboundMessage, text?: string): Promise<void | readonly string[]> {
    const ids = await this.sendTurn(typeof msg === "string" ? { chatId: msg, text: text ?? "" } : msg);
    if (typeof msg === "string") return ids;
  }
  prompt(chatId: string, text: string, buttons: readonly (readonly Button[])[]): Promise<readonly string[]> {
    return this.sendTurn({ chatId, text, buttons });
  }
  async sendOutput(chatId: string, outputId: string, index = 0): Promise<readonly string[]> {
    this.#target(chatId);
    if (!this.#o.outputs) throw new Error("media output store unavailable");
    const attachment = await outputAttachment(this.#o.outputs, outputId, chatId, index);
    return this.sendTurn({ chatId, text: "", attachments: [attachment] });
  }
  async sendTurn(turn: OutboundTurn): Promise<readonly string[]> {
    if (!this.#api || !this.#ac) throw new Error("telegram channel is not started");
    const target = this.#target(turn.chatId);
    const signal = this.#ac.signal;
    const api = this.#api;
    const extra: Record<string, unknown> = {
      ...(target.thread !== undefined ? { message_thread_id: target.thread } : {}),
      ...(turn.replyTo !== undefined ? { reply_parameters: { message_id: Number(turn.replyTo) } } : {}),
    };
    const ids: string[] = [];
    if (turn.entities?.length && turn.parseMode) throw new Error("entities and parseMode are mutually exclusive");
    for (const e of turn.entities ?? [])
      if (
        !Number.isSafeInteger(e.offset) ||
        !Number.isSafeInteger(e.length) ||
        e.offset < 0 ||
        e.length < 1 ||
        e.offset + e.length > turn.text.length
      )
        throw new Error("invalid text entity range");
    const chunks = splitMessage(turn.text);
    let cursor = 0;
    for (const [i, chunk] of chunks.entries()) {
      const fields = { ...extra };
      const start = turn.text.indexOf(chunk, cursor);
      cursor = start + chunk.length;
      const entities = (turn.entities ?? []).flatMap((e) => {
        const a = Math.max(start, e.offset),
          b = Math.min(cursor, e.offset + e.length);
        return b > a ? [{ ...e, offset: a - start, length: b - a }] : [];
      });
      if (entities.length) fields.entities = entities;
      if (turn.parseMode) fields.parse_mode = turn.parseMode;
      if (i === chunks.length - 1 && turn.buttons?.length)
        fields.reply_markup = {
          inline_keyboard: turn.buttons.map((row) =>
            row.map((b) => ({
              text: b.text,
              callback_data: this.#signer.issue({
                chatId: target.thread !== undefined ? `${target.chat}:${target.thread}` : target.chat,
                data: b.data,
                ttlMs: b.ttlMs ?? 300_000,
                ...(b.senderId !== undefined ? { senderId: b.senderId } : {}),
              }),
            })),
          ),
        };
      const formatted = turn.parseMode ? escapeText(chunk, turn.parseMode) : chunk;
      try {
        ids.push(
          String(
            await this.#request(target.chat, signal, () => api.sendMessage(target.chat, formatted, signal, fields)),
          ),
        );
      } catch (e) {
        if (
          e instanceof TelegramApiError &&
          e.kind === "bad-request" &&
          /parse entities|parse.*entit|unsupported start tag/i.test(e.message) &&
          (turn.parseMode || entities.length)
        ) {
          delete fields.parse_mode;
          delete fields.entities;
          ids.push(
            String(await this.#request(target.chat, signal, () => api.sendMessage(target.chat, chunk, signal, fields))),
          );
        } else throw e;
      }
    }
    for (const a of turn.attachments ?? []) {
      if (a.data.byteLength > (this.#o.maxMediaBytes ?? 20 * 1024 * 1024))
        throw new Error("outbound media exceeds size limit");
      this.#checkMime(a.kind, a.mimeType);
      const method = {
        photo: "sendPhoto",
        document: "sendDocument",
        voice: "sendVoice",
        audio: "sendAudio",
        video: "sendVideo",
      }[a.kind] as "sendPhoto" | "sendDocument" | "sendVoice" | "sendAudio" | "sendVideo";
      const form = new FormData();
      form.set("chat_id", target.chat);
      for (const [k, v] of Object.entries(extra)) form.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
      form.set(
        a.kind,
        new Blob([new Uint8Array(a.data)], { type: a.mimeType }),
        a.filename?.replace(/[^A-Za-z0-9_.-]/g, "_") ?? `attachment.${a.kind}`,
      );
      const r = await this.#request(target.chat, signal, () => api.call<{ message_id: number }>(method, form, signal));
      ids.push(String(r.message_id));
    }
    return ids;
  }
  /** Fetch-compatible handler: the host owns HTTP/TLS, routing, timeouts and request body ingress limits. */
  async handleWebhook(request: Request): Promise<Response> {
    if (this.#o.mode !== "webhook" || !this.#ac || !this.#healthy) return new Response(null, { status: 503 });
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const digest = (s: string) => createHash("sha256").update(s).digest();
    if (
      !timingSafeEqual(
        digest(request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? ""),
        digest(this.#o.webhook!.secret),
      )
    )
      return new Response(null, { status: 403 });
    let update: TelegramUpdate;
    try {
      const max = this.#o.webhook!.maxBodyBytes ?? 1024 * 1024;
      const reader = request.body?.getReader();
      if (!reader) return new Response(null, { status: 400 });
      const parts: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const r = await reader.read();
          if (r.done) break;
          size += r.value.length;
          if (size > max) return new Response(null, { status: 413 });
          parts.push(r.value);
        }
      } finally {
        await reader.cancel();
      }
      update = JSON.parse(Buffer.concat(parts).toString("utf8")) as TelegramUpdate;
      if (
        !update ||
        !Number.isSafeInteger(update.update_id) ||
        update.update_id < 0 ||
        (!update.message && !update.callback_query)
      )
        return new Response(null, { status: 400 });
    } catch {
      return new Response(null, { status: 400 });
    }
    try {
      await this.#serialUpdate(update, false);
      return new Response(null, { status: 200 });
    } catch {
      return new Response(null, { status: 503 });
    }
  }
  #serialUpdate(u: TelegramUpdate, poll: boolean): Promise<void> {
    const run = this.#updates.then(async () => {
      if (this.#seen.has(u.update_id) || (poll && this.#offset !== undefined && u.update_id < this.#offset)) return;
      // Persist pending offset BEFORE the next getUpdates acknowledges it. A failed save is retried without redispatch.
      await this.#dispatch(u);
      this.#seen.add(u.update_id);
      if (this.#seen.size > 4096) this.#seen.delete(this.#seen.values().next().value!);
      if (poll) {
        const offset = Math.max(this.#offset ?? 0, u.update_id + 1);
        await this.#saveOffset(offset);
        this.#offset = offset;
      }
    });
    this.#updates = run.catch(() => {});
    return run;
  }
  async #saveOffset(offset: number): Promise<void> {
    while (!this.#ac?.signal.aborted) {
      try {
        await this.#o.offsetStore.save(offset);
        return;
      } catch {
        this.#log("error", "channel.telegram.offset-save-failed", {});
        await this.#sleep(1000, this.#ac!.signal);
      }
    }
    throw new Error("telegram offset persistence interrupted");
  }
  async #poll(signal: AbortSignal): Promise<void> {
    let backoff = 0;
    while (!signal.aborted) {
      try {
        const updates = await this.#api!.getUpdates(this.#offset, this.#o.pollTimeoutSec ?? 30, signal);
        backoff = 0;
        for (const u of updates) {
          if (signal.aborted) break;
          if (Number.isSafeInteger(u?.update_id)) await this.#serialUpdate(u, true);
        }
      } catch (e) {
        if (signal.aborted) break;
        const err = e instanceof TelegramApiError ? e : new TelegramApiError("protocol", "unexpected poll failure");
        if (err.kind === "unauthorized" || err.kind === "forbidden") {
          this.#healthy = false;
          this.#log("error", "channel.telegram.auth-failed", {});
          this.#host?.fail(new Error("telegram authentication failed"));
          return;
        }
        backoff = Math.min(60_000, backoff === 0 ? 1000 : backoff * 2);
        const wait =
          err.kind === "rate-limited"
            ? (err.retryAfterMs ?? 1000)
            : Math.round(backoff * (0.75 + (this.#o.random ?? Math.random)() * 0.5));
        this.#log("warn", "channel.telegram.poll-failed", {
          kind: err.kind,
          waitMs: wait,
        });
        await this.#sleep(wait, signal);
      }
    }
  }
  #target(id: string): { chat: string; thread?: number } {
    const match = /^(-?\d{1,20})(?::([1-9]\d{0,9}))?$/.exec(id);
    if (!match) throw new Error("invalid telegram conversation id");
    let chat = match[1]!;
    chat = this.#migrations.get(chat) ?? chat;
    if (!this.#allow.has(chat)) throw new Error("chat is not on the telegram allowlist");
    if (this.#inactive.has(chat)) throw new Error("telegram chat is inactive");
    return {
      chat,
      ...(match[2] !== undefined ? { thread: Number(match[2]) } : {}),
    };
  }
  async #request<T>(chat: string, signal: AbortSignal, call: () => Promise<T>): Promise<T> {
    let bucket = this.#chats.get(chat);
    if (!bucket) {
      bucket = new TokenBucket(1, chat.startsWith("-") ? 3000 : 1000, this.#o.now ?? Date.now, this.#sleep);
      this.#chats.set(chat, bucket);
    }
    const limit = bucket;
    return this.#retry(signal, async () => {
      await limit.take(signal);
      await this.#global.take(signal);
      if (this.#inactive.has(chat)) throw new Error("telegram chat is inactive");
      try {
        return await call();
      } catch (e) {
        if (e instanceof TelegramApiError && e.kind === "forbidden") this.#inactive.add(chat);
        throw e;
      }
    });
  }
  async #retry<T>(signal: AbortSignal, call: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      try {
        return await call();
      } catch (e) {
        if (
          !(e instanceof TelegramApiError) ||
          !["rate-limited", "network", "timeout"].includes(e.kind) ||
          attempt >= (this.#o.maxSendRetries ?? 3) ||
          signal.aborted
        )
          throw e;
        const wait =
          e.kind === "rate-limited"
            ? (e.retryAfterMs ?? 1000)
            : Math.round(Math.min(60_000, 1000 * 2 ** attempt) * (0.75 + (this.#o.random ?? Math.random)() * 0.5));
        this.#log("warn", "channel.telegram.request-retry", {
          kind: e.kind,
          waitMs: wait,
          attempt,
        });
        await this.#sleep(wait, signal);
      }
    }
  }
  #addressed(m: TelegramMessage, text: string): boolean {
    if (m.chat.type === "private" || this.#o.groupPolicy === "all") return true;
    if (m.reply_to_message?.from?.id === this.#botId) return true;
    const command = /^\/[a-z0-9_]+(?:@([a-z0-9_]+))?(?:\s|$)/i.exec(text);
    if (command) return !command[1] || command[1].toLowerCase() === this.#botUsername?.toLowerCase();
    const name = this.#botUsername?.toLowerCase();
    if (name && new RegExp(`(^|[^a-z0-9_])@${name}(?![a-z0-9_])`, "i").test(text)) return true;
    return (m.entities ?? m.caption_entities ?? []).some(
      (e) => e.type === "text_mention" && e.user?.id === this.#botId,
    );
  }
  async #dispatch(u: TelegramUpdate): Promise<void> {
    if (u.callback_query) {
      await this.#callback(u);
      return;
    }
    const m = u.message;
    if (!m || !Number.isSafeInteger(m.chat?.id)) return;
    const chat = String(m.chat.id);
    if (!this.#allow.has(chat)) {
      this.#log("warn", "channel.telegram.rejected", { chatId: chat });
      return;
    }
    if (m.migrate_to_chat_id !== undefined) {
      const next = String(m.migrate_to_chat_id);
      if (!CHAT_ID.test(next)) return;
      await this.#o.offsetStore.saveMigration?.(chat, next);
      this.#migrations.set(chat, next);
      this.#allow.delete(chat);
      this.#allow.add(next);
      this.#log("info", "channel.telegram.migrated", {
        chatId: chat,
        newChatId: next,
      });
      return;
    }
    if (!m.from || m.from.is_bot || m.from.id === this.#botId || (this.#users && !this.#users.has(String(m.from.id))))
      return;
    if (!["private", "group", "supergroup"].includes(m.chat.type)) return;
    const text = m.text ?? m.caption ?? "";
    if (!this.#addressed(m, text)) return;
    const chatId = m.message_thread_id !== undefined ? `${chat}:${m.message_thread_id}` : chat;
    const cmd = /^\/([a-z0-9_]+)(?:@([a-z0-9_]+))?(?:\s+([\s\S]*))?$/i.exec(text);
    if (cmd?.[2] && cmd[2].toLowerCase() !== this.#botUsername?.toLowerCase()) return;
    let attachments: Attachment[];
    try {
      attachments = await this.#media(m);
    } catch {
      this.#log("warn", "channel.telegram.media-rejected", { chatId });
      return;
    }
    if (!text && attachments.length === 0) return;
    const message: InboundMessage = {
      channel: this.name,
      chatId,
      chatKind: m.chat.type === "private" ? "direct" : "group",
      senderId: String(m.from.id),
      text: cmd ? `/${cmd[1]!.toLowerCase()}${cmd[3] ? ` ${cmd[3]}` : ""}` : text,
      messageId: String(m.message_id),
      sentAt: m.date * 1000,
      ...(m.message_thread_id !== undefined ? { threadId: m.message_thread_id } : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(cmd ? { command: { name: cmd[1]!.toLowerCase(), argument: cmd[3] ?? "" } } : {}),
    };
    if (message.command?.name === "web") {
      let reply = "/web nicht konfiguriert";
      if (message.chatKind !== "direct") reply = "Bitte /web im privaten Chat verwenden.";
      else if (this.#o.webLinkProvider) {
        try {
          const link = await this.#o.webLinkProvider.createLink(message);
          const url = new URL(link);
          if (url.protocol !== "https:" || url.username || url.password) throw new Error();
          reply = link;
        } catch {
          reply = "/web derzeit nicht verfügbar";
        }
      }
      try {
        await this.send(chatId, reply);
      } catch {
        this.#log("warn", "channel.telegram.command-send-failed", {});
      }
      return;
    }
    if (message.command?.name === "link") {
      let reply = "Pairing failed. Request a new code in My identities.";
      if (message.chatKind === "direct" && this.#o.pairing && this.#botId !== undefined) {
        try {
          const pairing = this.#o.pairing.claim({ code: message.command.argument, identity: { channel: "telegram", accountId: String(this.#botId), userId: message.senderId } });
          reply = `Pairing claimed. Pairing ID: ${pairing.pairingId}. Confirm this link in My identities. Run: plur1bus identity approve ${pairing.pairingId}`;
        } catch { /* Uniform message; the identity port owns durable rate limits. Never log the submitted code. */ }
      }
      await this.send(chatId, reply);
      return;
    }
    if (message.command?.name === "help") {
      try {
        await this.send(
          chatId,
          "/start — Start\n/help — Hilfe / Help\n/new — Neuer Chat / New chat\n/web — Im Web fortsetzen / Continue in web",
        );
      } catch {
        this.#log("warn", "channel.telegram.command-send-failed", {});
      }
      return;
    }
    await this.#emit(message);
  }
  async #emit(message: InboundMessage): Promise<void> {
    for (const h of [...this.#handlers]) {
      try {
        await h(message);
      } catch {
        this.#log("error", "channel.telegram.handler-failed", {});
      }
    }
    if (this.#host) {
      // Framework v1 is text-only: rich turns are available through onMessage, never silently claimed as core media support.
      if (!message.text || message.callback || message.attachments?.length) {
        this.#log("warn", "channel.telegram.framework-rich-turn-gap", {});
        return;
      }
      try {
        await this.#host.receive(message);
      } catch {
        this.#log("error", "channel.telegram.host-failed", {});
      }
    }
  }
  async #callback(u: TelegramUpdate): Promise<void> {
    const q = u.callback_query!;
    let text = "This button is expired or invalid. Please request a new one.";
    try {
      const m = q.message;
      if (!m || !q.data || !q.from || q.from.is_bot || (this.#users && !this.#users.has(String(q.from.id)))) return;
      const chatId = m.message_thread_id !== undefined ? `${m.chat.id}:${m.message_thread_id}` : String(m.chat.id);
      this.#target(chatId);
      const p = this.#signer.consume(q.data, chatId, String(q.from.id));
      if (!p) return;
      await this.#emit({
        channel: this.name,
        chatId,
        chatKind: m.chat.type === "private" ? "direct" : "group",
        senderId: String(q.from.id),
        text: p.data,
        messageId: String(m.message_id),
        callback: { id: q.id, data: p.data },
      });
      text = "Received.";
    } catch {
      this.#log("warn", "channel.telegram.callback-rejected", {});
    } finally {
      try {
        await this.#api!.call("answerCallbackQuery", { callback_query_id: q.id, text }, this.#ac!.signal);
      } catch {
        this.#log("warn", "channel.telegram.callback-answer-failed", {});
      }
    }
  }
  async #media(m: TelegramMessage): Promise<Attachment[]> {
    const out: Attachment[] = [];
    const signal = this.#ac!.signal;
    for (const kind of ["photo", "document", "voice", "audio", "video"] as const) {
      const media = kind === "photo" ? m.photo?.at(-1) : m[kind];
      if (!media) continue;
      const max = this.#o.maxMediaBytes ?? 20 * 1024 * 1024;
      if (media.file_size !== undefined && media.file_size > max) throw new Error("media size limit");
      const mime =
        media.mime_type ??
        (kind === "photo" ? "image/jpeg" : kind === "voice" ? "audio/ogg" : "application/octet-stream");
      this.#checkMime(kind, mime);
      const file = await this.#retry(signal, () =>
        this.#api!.call<{
          file_path?: string;
          file_size?: number;
        }>("getFile", { file_id: media.file_id }, signal),
      );
      if (!file.file_path || (file.file_size !== undefined && file.file_size > max))
        throw new Error("media size limit");
      const downloaded = await this.#retry(signal, () => this.#api!.download(file.file_path!, max, signal));
      if (downloaded.mimeType !== "application/octet-stream") this.#checkMime(kind, downloaded.mimeType);
      if (downloaded.mimeType !== "application/octet-stream" && downloaded.mimeType !== mime)
        throw new Error("media MIME mismatch");
      out.push({
        kind,
        data: downloaded.data,
        mimeType: mime,
        ...(media.file_name ? { filename: media.file_name.replace(/[^A-Za-z0-9_.-]/g, "_") } : {}),
      });
    }
    return out;
  }
  #checkMime(kind: Attachment["kind"], mime: string): void {
    const safe =
      /^(image\/(jpeg|png|webp)|audio\/(ogg|mpeg|mp4|wav|x-wav|flac)|video\/(mp4|webm)|application\/(pdf|octet-stream|zip|json)|text\/plain)$/;
    if (
      !safe.test(mime) ||
      (kind === "photo" && !mime.startsWith("image/")) ||
      ((kind === "voice" || kind === "audio") && !mime.startsWith("audio/")) ||
      (kind === "video" && !mime.startsWith("video/"))
    )
      throw new Error("unsupported media MIME type");
  }
  async #registerCommands(signal: AbortSignal): Promise<void> {
    const scopes = this.#o.commandScopes ?? [{ type: "all_private_chats" }, { type: "all_group_chats" }];
    for (const language_code of ["de", "en"]) {
      const descriptions =
        language_code === "de"
          ? ["Bot starten", "Hilfe anzeigen", "Neuen Chat beginnen", "Im Web fortsetzen"]
          : ["Start the bot", "Show help", "Start a new chat", "Continue in web"];
      const commands = new Map(
        ["start", "help", "new", "web"].map((command, i) => [command, { command, description: descriptions[i]! }]),
      );
      if (this.#o.pairing) commands.set("link", { command: "link", description: language_code === "de" ? "Kanalidentität verknüpfen" : "Link channel identity" });
      for (const c of this.#o.commands ?? []) commands.set(c.command, c);
      for (const scope of scopes)
        await this.#api!.call("setMyCommands", { commands: [...commands.values()], scope, language_code }, signal);
    }
  }
  #log(level: LogLevel, event: string, attrs: Record<string, string | number | boolean>): void {
    const safe = redactAttrs(attrs, this.#token);
    this.#o.logger?.log(level, event, safe);
    if (level !== "debug") this.#host?.log[level](event, safe);
  }
}
