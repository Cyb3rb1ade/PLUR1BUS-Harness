import { randomBytes } from "node:crypto";
import type { Channel, ChannelHealth, ChannelHost, OutboundMessage } from "../../core/src/channels/types.ts";
import { DiscordApi, DiscordApiError } from "./api.ts";
import { CallbackSigner } from "./callback.ts";
import {
  parseConfig,
  splitOptions,
  SNOWFLAKE,
  type DiscordChannelOptions,
  type DiscordConfig,
  type DiscordDeps,
  type ParsedConfig,
} from "./config.ts";
import { Gateway, DEFAULT_GATEWAY_URL } from "./gateway.ts";
import { MESSAGES, type Messages } from "./messages.ts";
import { toPlatformMarkdown } from "./markdown.ts";
import { outputAttachment } from "./outputs.ts";
import type {
  ApprovalChoice,
  ApprovalDecision,
  ApprovalPrompt,
  Attachment,
  ChannelCapabilities,
  DecisionHandler,
  GatewaySession,
  InboundHandler,
  OutboundTurn,
  RichInbound,
  SentRef,
  WebSocketLike,
} from "./port.ts";
import { redactAttrs } from "./redact.ts";
import { type Sleep } from "./rate-limit.ts";
import { splitMessage, DISCORD_MAX_TEXT } from "./split.ts";

const TOKEN_FORMAT = /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}$/;
const INTERACTION_TOKEN = /^[A-Za-z0-9_.-]{10,200}$/;
const EPHEMERAL = 64;
const ACK_DEADLINE_MS = 2500;
const DEFAULT_APPROVAL_TTL_MS = 5 * 60_000;
const MAX_APPROVAL_TTL_MS = 24 * 60 * 60_000;
const DEDUPE_LIMIT = 4096;
/** How long `start()` waits for the first READY before it resolves anyway (health then reports "reconnecting"). */
const READY_WAIT_MS = 30_000;
const DM_CHANNEL_LIMIT = 4096;
const INBOUND_MIME =
  /^(image\/(jpeg|png|webp)|audio\/(ogg|mpeg|mp4|wav|x-wav|flac|webm)|video\/(mp4|webm)|application\/(pdf|json|zip|octet-stream)|text\/plain)$/;
const OUTBOUND_MIME = /^(image\/(jpeg|png|webp)|audio\/(ogg|mpeg|mp4|wav|x-wav|flac)|video\/(mp4|webm)|application\/pdf|text\/plain)$/;
const CAPABILITIES: ChannelCapabilities = {
  threads: true,
  edit: true,
  typing: true,
  attachmentsIn: true,
  attachmentsOut: true,
  reactions: false,
  buttons: true,
  approvalMode: "buttons",
  markdown: "converted",
  maxMessageChars: DISCORD_MAX_TEXT,
};

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

interface DiscordUser {
  id?: unknown;
  bot?: unknown;
}
interface DiscordMessagePayload {
  id?: unknown;
  channel_id?: unknown;
  guild_id?: unknown;
  type?: unknown;
  content?: unknown;
  timestamp?: unknown;
  author?: DiscordUser;
  mentions?: unknown;
  referenced_message?: { author?: DiscordUser } | null;
  message_reference?: { message_id?: unknown } | null;
  attachments?: unknown;
}
interface DiscordInteraction {
  id?: unknown;
  token?: unknown;
  type?: unknown;
  guild_id?: unknown;
  channel_id?: unknown;
  user?: DiscordUser;
  member?: { user?: DiscordUser };
  data?: {
    name?: unknown;
    custom_id?: unknown;
    options?: { name?: unknown; type?: unknown; value?: unknown }[];
  };
}
interface PromptState {
  chatId: string;
  text: string;
  choices: readonly ApprovalChoice[];
  decided: boolean;
  expires: number;
}

export interface DiscordChannelState {
  started: boolean;
  connected: boolean;
}

/** Discord channel: lean REST v10 + Gateway v10 clients, rich inbound/outbound ports, D109 buttons and `/link` pairing.
 *  `accountId` for pairing is the bot's own user id (READY / `GET /users/@me`). */
export class DiscordChannel implements Channel {
  readonly name = "discord" as const;
  readonly capabilities: ChannelCapabilities = CAPABILITIES;
  readonly #o: DiscordChannelOptions;
  readonly #c: ParsedConfig;
  readonly #msgs: Messages;
  readonly #handlers = new Set<InboundHandler>();
  readonly #decisionHandlers = new Set<DecisionHandler>();
  readonly #signer: CallbackSigner;
  readonly #prompts = new Map<string, PromptState>();
  readonly #seen = new Set<string>();
  readonly #dmChannels = new Map<string, string>();
  /** Thread channel id -> parent channel id, learned from THREAD_CREATE / THREAD_UPDATE / GUILD_CREATE. */
  readonly #threadParents = new Map<string, string>();
  readonly #sleep: Sleep;
  readonly #now: () => number;
  #host: ChannelHost | undefined;
  #api: DiscordApi | undefined;
  #token: string | undefined;
  #ac: AbortController | undefined;
  #starting: Promise<void> | undefined;
  #loop: Promise<void> | undefined;
  #gateway: Gateway | undefined;
  #botId: string | undefined;
  #resume: GatewaySession | undefined;
  #connected = false;
  #fatal = false;
  #gate: ((outcome: "ready" | "fatal") => void) | undefined;
  #chain: Promise<void> = Promise.resolve();
  #stateChain: Promise<void> = Promise.resolve();

  constructor(opts: DiscordChannelOptions) {
    this.#c = parseConfig(splitOptions(opts as unknown as Record<string, unknown>));
    this.#o = opts;
    this.#msgs = MESSAGES[this.#c.locale];
    this.#sleep = opts.sleep ?? defaultSleep;
    this.#now = opts.now ?? Date.now;
    this.#signer = new CallbackSigner(randomBytes(32).toString("hex"), this.#now);
  }

  onMessage(handler: InboundHandler): () => void {
    this.#handlers.add(handler);
    return () => void this.#handlers.delete(handler);
  }
  onDecision(handler: DecisionHandler): () => void {
    this.#decisionHandlers.add(handler);
    return () => void this.#decisionHandlers.delete(handler);
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
    this.#fatal = false;
    try {
      let token: string | null;
      try {
        token = await this.#o.secrets.reveal(this.#c.tokenSecret);
      } catch {
        throw new DiscordApiError("protocol", "discord secret read failed");
      }
      if (token === null) throw new DiscordApiError("protocol", "discord bot token secret is not set");
      if (!TOKEN_FORMAT.test(token)) throw new DiscordApiError("protocol", "discord bot token secret has an unexpected format");
      this.#token = token;
      this.#host = host;
      const api = new DiscordApi({
        token,
        ...(this.#o.baseUrl !== undefined ? { baseUrl: this.#o.baseUrl } : {}),
        ...(this.#o.cdnHosts !== undefined ? { cdnHosts: this.#o.cdnHosts } : {}),
        ...(this.#o.fetch !== undefined ? { fetch: this.#o.fetch } : {}),
        sleep: this.#sleep,
        random: this.#o.random ?? Math.random,
        now: this.#now,
      });
      this.#api = api;
      // Identity discovery: a bad token fails here with 401 and start rejects without retrying.
      const me = await api.request<{ id?: unknown }>({ method: "GET", path: "/users/@me", signal });
      if (typeof me.id !== "string" || !SNOWFLAKE.test(me.id)) throw new DiscordApiError("protocol", "discord identity is invalid");
      this.#botId = me.id;
      const appId = this.#c.applicationId ?? me.id;
      await this.#registerCommands(api, appId, signal);
      const stored = this.#resume ?? (await this.#o.stateStore?.load());
      const session = stored && stored.botId === me.id ? stored : undefined;
      this.#resume = session;
      const gateway = new Gateway({
        token,
        intents: this.#c.intents,
        url: this.#o.gatewayUrl ?? DEFAULT_GATEWAY_URL,
        webSocket: this.#o.webSocket ?? defaultWebSocket,
        signal,
        sleep: this.#sleep,
        random: this.#o.random ?? Math.random,
        now: this.#now,
        session,
        botId: me.id,
        onReady: (info, resumed) => this.#onReady(info.botId, resumed),
        onDispatch: (t, d) => this.#onDispatch(t, d),
        onConnection: (up) => {
          this.#connected = up;
        },
        onSession: (s) => this.#persist(s),
        onFatal: (code) => this.#onFatal(code),
        log: (level, event, attrs) => this.#log(level, event, attrs),
      });
      this.#gateway = gateway;
      // start() resolves once the first READY arrives, so health() is meaningful on return. A fatal close rejects it;
      // a slow network resolves after READY_WAIT_MS and the channel keeps reconnecting in the background.
      const gate = new Promise<"ready" | "fatal">((resolve) => (this.#gate = resolve));
      this.#loop = gateway.run().catch(() => this.#log("error", "channel.discord.gateway-crashed", {}));
      const timer = new AbortController();
      const outcome = await Promise.race([gate, this.#sleep(READY_WAIT_MS, timer.signal).then(() => "timeout" as const)]);
      timer.abort();
      signal.throwIfAborted();
      if (outcome === "fatal") throw new DiscordApiError("unauthorized", "discord gateway refused the connection");
      if (outcome === "timeout") this.#log("warn", "channel.discord.ready-timeout", { waitMs: READY_WAIT_MS });
      this.#log("info", "channel.discord.started", { resumed: session !== undefined, commands: this.#pairing ? 2 : 1 });
    } catch (e) {
      ac.abort();
      this.#connected = false;
      this.#ac = undefined;
      this.#api = undefined;
      this.#host = undefined;
      this.#token = undefined;
      this.#gateway = undefined;
      throw e instanceof DiscordApiError ? e : new Error("discord start failed");
    }
  }

  async stop(): Promise<void> {
    const wasRunning = this.#ac !== undefined;
    this.#ac?.abort();
    this.#connected = false;
    await this.#starting?.catch(() => {});
    await this.#loop;
    await this.#chain;
    await this.#stateChain;
    this.#signer.clear();
    this.#prompts.clear();
    this.#loop = undefined;
    this.#gateway = undefined;
    this.#ac = undefined;
    this.#api = undefined;
    this.#host = undefined;
    this.#token = undefined;
    if (wasRunning) this.#log("info", "channel.discord.stopped", {});
  }

  async health(): Promise<ChannelHealth> {
    const started = this.#ac !== undefined && !this.#ac.signal.aborted;
    const ok = started && this.#connected && !this.#fatal;
    const detail = this.#fatal ? "authentication failed" : ok ? "connected" : started ? "reconnecting" : "stopped";
    return { ok, detail };
  }

  /** Resolves when every inbound event received so far has been processed. For tests and hosts that need a barrier. */
  idle(): Promise<void> {
    return this.#chain;
  }

  send(msg: OutboundMessage): Promise<void> {
    return this.sendTurn({ ...msg }).then(() => undefined);
  }

  /** Framework-independent conveniences, same behaviour as `sendTurn`. */
  async sendOutput(chatId: string, outputId: string, index = 0): Promise<SentRef[]> {
    this.#target(chatId);
    if (!this.#o.outputs) throw new Error("media output store unavailable");
    const attachment = await outputAttachment(this.#o.outputs, outputId, chatId, this.#c.maxMediaBytes, index);
    return this.sendTurn({ chatId, text: "", attachments: [attachment] });
  }

  async sendTurn(turn: OutboundTurn): Promise<SentRef[]> {
    const { api, signal } = this.#live();
    const chat = this.#target(turn.chatId, turn.threadId);
    if (turn.replyTo !== undefined && !SNOWFLAKE.test(turn.replyTo)) throw new Error("invalid reply target");
    const converted = toPlatformMarkdown(turn.text);
    const texts = converted.trim() ? splitMessage(converted, DISCORD_MAX_TEXT) : [];
    for (const a of turn.attachments ?? []) this.#checkOutbound(a);
    const components = turn.buttons ? this.#approvalRows(chat, turn.buttons) : undefined;
    const items: Array<{ content?: string; file?: Attachment }> = [
      ...texts.map((content) => ({ content })),
      ...(turn.attachments ?? []).map((file) => ({ file })),
    ];
    if (items.length === 0 && components) items.push({});
    const refs: SentRef[] = [];
    for (const [i, item] of items.entries()) {
      const reference = i === 0 && turn.replyTo !== undefined ? { message_reference: { message_id: turn.replyTo, fail_if_not_exists: false } } : {};
      const last = i === items.length - 1;
      const payload: Record<string, unknown> = {
        allowed_mentions: { parse: [] },
        ...(item.content !== undefined ? { content: item.content } : {}),
        ...reference,
        ...(last && components ? { components } : {}),
      };
      let res: { id?: unknown };
      if (item.file) {
        const form = new FormData();
        form.set("payload_json", JSON.stringify(payload));
        form.set("files[0]", new Blob([new Uint8Array(item.file.data)], { type: item.file.mimeType }), safeName(item.file));
        res = await api.request<{ id?: unknown }>({ method: "POST", path: `/channels/${chat}/messages`, form, signal });
      } else {
        res = await api.request<{ id?: unknown }>({ method: "POST", path: `/channels/${chat}/messages`, json: payload, signal });
      }
      if (typeof res.id !== "string") throw new DiscordApiError("protocol", "discord returned no message id");
      refs.push({ chatId: chat, messageId: res.id });
    }
    return refs;
  }

  async edit(ref: SentRef, text: string): Promise<void> {
    const { api, signal } = this.#live();
    const chat = this.#target(ref.chatId);
    if (!SNOWFLAKE.test(ref.messageId)) throw new Error("invalid message reference");
    const content = toPlatformMarkdown(text);
    if (!content.trim()) throw new RangeError("edit text is empty");
    if (content.length > DISCORD_MAX_TEXT) throw new RangeError("edit text exceeds the message limit; split it first");
    await api.request({
      method: "PATCH",
      path: `/channels/${chat}/messages/${ref.messageId}`,
      json: { content, allowed_mentions: { parse: [] } },
      signal,
    });
  }

  async typing(chatId: string): Promise<void> {
    const { api, signal } = this.#live();
    const chat = this.#target(chatId);
    await api.request({ method: "POST", path: `/channels/${chat}/typing`, signal });
  }

  /** D109 approval UI: one message with one button per choice. Only `approverIds` may press, once, before the TTL. */
  async prompt(req: ApprovalPrompt): Promise<{ promptId: string; refs: SentRef[] }> {
    this.#live();
    const chat = this.#target(req.chatId, req.threadId);
    if (req.choices.length < 1 || req.choices.length > 5) throw new RangeError("1..5 choices required");
    const ids = new Set<string>();
    for (const c of req.choices) {
      if (!/^[a-z][a-z0-9_-]{0,15}$/.test(c.id) || ids.has(c.id)) throw new RangeError("choice ids must be unique slugs");
      if (!c.label || c.label.length > 80) throw new RangeError("choice labels are 1..80 characters");
      ids.add(c.id);
    }
    if (req.approverIds.length < 1 || req.approverIds.some((a) => !SNOWFLAKE.test(a)))
      throw new RangeError("approverIds must be non-empty snowflakes");
    const ttlMs = req.ttlMs ?? DEFAULT_APPROVAL_TTL_MS;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > MAX_APPROVAL_TTL_MS) throw new RangeError("approval TTL must be 1 ms..24 h");
    const promptId = randomBytes(16).toString("base64url");
    this.#prunePrompts();
    this.#prompts.set(promptId, { chatId: chat, text: req.text, choices: req.choices, decided: false, expires: this.#now() + ttlMs });
    try {
      const refs = await this.sendTurn({
        chatId: chat,
        text: req.text,
        buttons: { promptId, choices: req.choices, approverIds: req.approverIds, ttlMs },
      });
      return { promptId, refs };
    } catch (e) {
      this.#prompts.delete(promptId);
      this.#signer.revokeWhere((d) => d.startsWith(`${promptId}|`));
      throw e;
    }
  }

  // ---- internals -----------------------------------------------------------------------------------------------

  get #pairing(): boolean {
    return this.#o.pairing !== undefined;
  }

  #live(): { api: DiscordApi; signal: AbortSignal } {
    if (!this.#api || !this.#ac || this.#ac.signal.aborted) throw new Error("discord channel is not started");
    return { api: this.#api, signal: this.#ac.signal };
  }

  /** Outbound conversation check: listed chats (a thread counts as its parent), or a DM channel a listed DM sender opened. */
  #outboundAllowed(chat: string): boolean {
    if (this.#c.allowlist.has(chat)) return true;
    const parent = this.#threadParents.get(chat);
    if (parent !== undefined && this.#c.allowlist.has(parent)) return true;
    const sender = this.#dmChannels.get(chat);
    return sender !== undefined && this.#c.dmAllowlist.has(sender);
  }

  #target(chatId: string, threadId?: string): string {
    if (!SNOWFLAKE.test(chatId)) throw new Error("invalid discord conversation id");
    if (threadId !== undefined && threadId !== chatId) throw new Error("threadId must equal chatId (threads are chats)");
    if (!this.#outboundAllowed(chatId)) throw new Error("chat is not on the discord allowlist");
    return chatId;
  }

  #checkOutbound(a: Attachment): void {
    if (a.data.byteLength < 1 || a.data.byteLength > this.#c.maxMediaBytes) throw new Error("outbound media exceeds size limit");
    if (!OUTBOUND_MIME.test(a.mimeType)) throw new Error("unsupported media MIME type");
  }

  #approvalRows(chat: string, b: NonNullable<OutboundTurn["buttons"]>): unknown[] {
    const buttons = b.choices.map((c, i) => {
      const deny = /^(deny|reject|no|decline)/.test(c.id);
      const custom_id = this.#signer.issue({
        chatId: chat,
        senders: b.approverIds,
        data: `${b.promptId}|${c.id}`,
        ttlMs: b.ttlMs ?? DEFAULT_APPROVAL_TTL_MS,
      });
      return { type: 2, style: deny ? 4 : i === 0 ? 1 : 2, label: c.label, custom_id };
    });
    const rows: unknown[] = [];
    for (let i = 0; i < buttons.length; i += 5) rows.push({ type: 1, components: buttons.slice(i, i + 5) });
    return rows;
  }

  #prunePrompts(): void {
    const now = this.#now();
    for (const [id, p] of this.#prompts) if (p.expires <= now) this.#prompts.delete(id);
    while (this.#prompts.size > 2000) this.#prompts.delete(this.#prompts.keys().next().value!);
  }

  #onReady(botId: string, resumed: boolean): void {
    if (botId !== this.#botId) {
      this.#log("error", "channel.discord.identity-mismatch", {});
      this.#fatal = true;
      this.#gate?.("fatal");
      this.#ac?.abort();
      this.#host?.fail(new Error("discord identity changed"));
      return;
    }
    this.#connected = true;
    this.#gate?.("ready");
    this.#log("info", resumed ? "channel.discord.resumed" : "channel.discord.ready", {});
  }

  #onFatal(code: number): void {
    this.#connected = false;
    this.#fatal = true;
    this.#resume = undefined;
    this.#gate?.("fatal");
    this.#log("error", "channel.discord.gateway-refused", { closeCode: code });
    this.#host?.fail(new Error(`discord gateway refused the connection (close ${code})`));
  }

  #persist(s: GatewaySession | undefined): void {
    if (s === undefined) {
      this.#resume = undefined;
    } else {
      this.#resume = s;
    }
    const store = this.#o.stateStore;
    if (!store) return;
    this.#stateChain = this.#stateChain
      .then(() => (s === undefined ? store.clear() : store.save(s)))
      .catch(() => this.#log("error", "channel.discord.state-save-failed", {}));
  }

  #onDispatch(t: string, d: unknown): void {
    if (!this.#ac || this.#ac.signal.aborted) return;
    this.#chain = this.#chain
      .then(async () => {
        if (t === "MESSAGE_CREATE") await this.#message(d as DiscordMessagePayload);
        else if (t === "INTERACTION_CREATE") await this.#interaction(d as DiscordInteraction);
        else if (t === "THREAD_CREATE" || t === "THREAD_UPDATE") this.#rememberThread(d);
        else if (t === "GUILD_CREATE") for (const th of (d as { threads?: unknown[] } | null)?.threads ?? []) this.#rememberThread(th);
      })
      .catch(() => this.#log("error", "channel.discord.dispatch-failed", {}));
  }

  #rememberThread(d: unknown): void {
    const t = d as { id?: unknown; parent_id?: unknown } | null;
    if (typeof t?.id !== "string" || !SNOWFLAKE.test(t.id)) return;
    if (typeof t.parent_id !== "string" || !SNOWFLAKE.test(t.parent_id)) return;
    this.#threadParents.delete(t.id);
    this.#threadParents.set(t.id, t.parent_id);
    if (this.#threadParents.size > DM_CHANNEL_LIMIT) this.#threadParents.delete(this.#threadParents.keys().next().value!);
  }

  #remember(id: string): boolean {
    if (this.#seen.has(id)) return true;
    this.#seen.add(id);
    if (this.#seen.size > DEDUPE_LIMIT) this.#seen.delete(this.#seen.values().next().value!);
    return false;
  }

  async #message(d: DiscordMessagePayload): Promise<void> {
    const author = d.author;
    if (typeof d.id !== "string" || !SNOWFLAKE.test(d.id)) return;
    if (typeof d.channel_id !== "string" || !SNOWFLAKE.test(d.channel_id)) return;
    if (typeof author?.id !== "string" || !SNOWFLAKE.test(author.id)) return;
    // Loop prevention: bots (including this one) never trigger a turn. Only default and reply message types count.
    if (author.bot === true || author.id === this.#botId) return;
    if (d.type !== 0 && d.type !== 19) return;
    if (this.#remember(d.id)) return;
    const chat = d.channel_id;
    const sender = author.id;
    const dm = d.guild_id === undefined || d.guild_id === null;
    if (dm) {
      if (!this.#c.dmAllowlist.has(sender) && !this.#c.allowlist.has(chat)) return this.#log("warn", "channel.discord.rejected", {});
      if (!this.#dmChannels.has(chat)) {
        this.#dmChannels.set(chat, sender);
        if (this.#dmChannels.size > DM_CHANNEL_LIMIT) this.#dmChannels.delete(this.#dmChannels.keys().next().value!);
      }
    } else {
      // A thread is a chat of its own; a listed parent channel admits its threads.
      const parent = this.#threadParents.get(chat);
      if (!this.#c.allowlist.has(chat) && !(parent !== undefined && this.#c.allowlist.has(parent)))
        return this.#log("warn", "channel.discord.rejected", {});
    }
    const threadParent = dm ? undefined : this.#threadParents.get(chat);
    const botId = this.#botId!;
    const mentioned = Array.isArray(d.mentions) && d.mentions.some((u) => (u as DiscordUser | null)?.id === botId);
    const repliedToBot = d.referenced_message?.author?.id === botId;
    const addressed = dm || mentioned || repliedToBot;
    if (!dm) {
      if (this.#c.userAllowlist && !this.#c.userAllowlist.has(sender)) return;
      const listed = this.#c.userAllowlist?.has(sender) ?? false;
      const heard = this.#c.replyPolicy === "always" || (this.#c.replyPolicy === "allowlist" && listed);
      if (!addressed && !heard) return;
    }
    let text = typeof d.content === "string" ? d.content : "";
    text = text.split(`<@${botId}>`).join("").split(`<@!${botId}>`).join("").trim();
    let attachments: Attachment[];
    try {
      attachments = await this.#media(d.attachments);
    } catch {
      this.#log("warn", "channel.discord.media-rejected", {});
      return;
    }
    if (!text && attachments.length === 0) return;
    const sentAt = typeof d.timestamp === "string" ? Date.parse(d.timestamp) : NaN;
    const refId = d.message_reference?.message_id;
    const message: RichInbound = {
      channel: this.name,
      chatId: chat,
      chatKind: dm ? "direct" : "group",
      senderId: sender,
      accountId: botId,
      text,
      messageId: d.id,
      addressed,
      ...(Number.isFinite(sentAt) ? { sentAt } : {}),
      ...(!dm ? { guildId: String(d.guild_id) } : {}),
      ...(threadParent !== undefined ? { threadId: chat } : {}),
      ...(typeof refId === "string" && SNOWFLAKE.test(refId) ? { replyToMessageId: refId } : {}),
      ...(attachments.length ? { attachments } : {}),
    };
    await this.#emit(message);
  }

  async #media(list: unknown): Promise<Attachment[]> {
    if (list === undefined) return [];
    if (!Array.isArray(list) || list.length > 10) throw new Error("bad attachments");
    const out: Attachment[] = [];
    const max = this.#c.maxMediaBytes;
    const signal = this.#ac!.signal;
    for (const raw of list) {
      const a = raw as { url?: unknown; size?: unknown; filename?: unknown; content_type?: unknown };
      if (typeof a.url !== "string" || typeof a.size !== "number" || typeof a.filename !== "string") throw new Error("bad attachment");
      if (a.size > max) throw new Error("media size limit");
      const mime = (typeof a.content_type === "string" ? a.content_type : "application/octet-stream").split(";")[0]!.trim().toLowerCase();
      checkInbound(mime);
      const got = await this.#api!.download(a.url, max, signal);
      if (got.mimeType !== "application/octet-stream") checkInbound(got.mimeType);
      if (got.mimeType !== "application/octet-stream" && got.mimeType !== mime) throw new Error("media MIME mismatch");
      out.push({
        kind: kindOf(mime),
        data: got.data,
        mimeType: mime,
        filename: safeFilename(a.filename),
      });
    }
    return out;
  }

  async #emit(message: RichInbound): Promise<void> {
    for (const h of [...this.#handlers]) {
      try {
        await h(message);
      } catch {
        this.#log("error", "channel.discord.handler-failed", {});
      }
    }
    if (!this.#host) return;
    if (!message.text || message.attachments?.length) {
      this.#log("warn", "channel.discord.framework-rich-turn-gap", {});
      return;
    }
    try {
      await this.#host.receive(message);
    } catch {
      this.#log("error", "channel.discord.host-failed", {});
    }
  }

  // ---- interactions -------------------------------------------------------------------------------------------

  async #interaction(d: DiscordInteraction): Promise<void> {
    if (typeof d.id !== "string" || !SNOWFLAKE.test(d.id)) return;
    if (typeof d.token !== "string" || !INTERACTION_TOKEN.test(d.token)) return;
    const user = d.member?.user ?? d.user;
    const sender = typeof user?.id === "string" && SNOWFLAKE.test(user.id) ? user.id : undefined;
    if (!sender || user?.bot === true) return;
    if (d.type === 2 && d.data?.name === "status") {
      return this.#answer(d, async () => this.#statusText());
    }
    if (d.type === 2 && d.data?.name === "link") {
      return this.#answer(d, () => this.#link(d, sender));
    }
    if (d.type === 3) return this.#press(d, sender);
  }

  #statusText(): string {
    return this.#connected ? this.#msgs.statusOnline : this.#msgs.statusDegraded;
  }

  /** `/link` is DM-only (guild commands get a refusal). The code is never logged or echoed. Claim errors are uniform. */
  async #link(d: DiscordInteraction, sender: string): Promise<string> {
    if (d.guild_id !== undefined && d.guild_id !== null) return this.#msgs.notHere;
    const opt = d.data?.options?.find((o) => o.name === "code");
    const code = typeof opt?.value === "string" ? opt.value : "";
    if (!this.#pairing || !this.#botId || !code || code.length > 128) return this.#msgs.pairFail;
    try {
      // The identity port is synchronous today; a promise-returning port is awaited so the 3 s deferral still applies.
      const out = await this.#o.pairing!.claim({ code, identity: { channel: "discord", accountId: this.#botId, userId: sender } });
      return this.#msgs.pairOk(out.pairingId);
    } catch {
      return this.#msgs.pairFail;
    }
  }

  /** Answers within Discord's 3 s deadline: an immediate ephemeral message, or a deferred ephemeral that is then edited. */
  async #answer(d: DiscordInteraction, produce: () => Promise<string>): Promise<void> {
    const signal = this.#ac?.signal;
    if (!signal || !this.#api) return;
    const result = produce().then(
      (content) => content,
      () => this.#msgs.failed,
    );
    const LATE = Symbol("late");
    const timer = new AbortController();
    const late = this.#sleep(ACK_DEADLINE_MS, timer.signal).then(() => LATE);
    const first = await Promise.race([result, late]);
    timer.abort();
    const id = d.id as string;
    const token = d.token as string;
    if (first === LATE) {
      await this.#respond(id, token, { type: 5, data: { flags: EPHEMERAL } });
      const content = await result;
      await this.#api.request({
        method: "PATCH",
        path: `/webhooks/${this.#c.applicationId ?? this.#botId}/${token}/messages/@original`,
        json: { content, allowed_mentions: { parse: [] } },
        signal,
        tokenRoute: true,
      });
      return;
    }
    await this.#respond(id, token, { type: 4, data: { content: first, flags: EPHEMERAL, allowed_mentions: { parse: [] } } });
  }

  async #respond(id: string, token: string, body: unknown): Promise<void> {
    const signal = this.#ac?.signal;
    if (!signal || !this.#api) return;
    await this.#api.request({
      method: "POST",
      path: `/interactions/${id}/${token}/callback`,
      json: body,
      signal,
      tokenRoute: true,
    });
  }

  /** D109 button press. Refusals are ephemeral and never emit a decision. The message is edited to disable its buttons. */
  async #press(d: DiscordInteraction, sender: string): Promise<void> {
    const id = d.id as string;
    const token = d.token as string;
    const chat = typeof d.channel_id === "string" && SNOWFLAKE.test(d.channel_id) ? d.channel_id : undefined;
    const wire = d.data?.custom_id;
    if (!chat || typeof wire !== "string" || !this.#outboundAllowed(chat)) {
      return this.#respond(id, token, { type: 4, data: { content: this.#msgs.notHere, flags: EPHEMERAL } });
    }
    const res = this.#signer.consume(wire, chat, sender);
    if (!res.ok) {
      const content = res.reason === "forbidden" ? this.#msgs.buttonForbidden : this.#msgs.buttonInvalid;
      this.#log("warn", "channel.discord.button-refused", { reason: res.reason });
      return this.#respond(id, token, { type: 4, data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } } });
    }
    const sep = res.data.indexOf("|");
    const promptId = res.data.slice(0, sep);
    const choiceId = res.data.slice(sep + 1);
    const p = this.#prompts.get(promptId);
    const choice = p?.choices.find((c) => c.id === choiceId);
    if (!p || !choice || p.decided || p.chatId !== chat || p.expires <= this.#now()) {
      return this.#respond(id, token, { type: 4, data: { content: this.#msgs.buttonInvalid, flags: EPHEMERAL } });
    }
    p.decided = true;
    this.#signer.revokeWhere((data) => data.startsWith(`${promptId}|`));
    const content = `${toPlatformMarkdown(p.text)}\n\n${this.#msgs.decided(choice.label)}`.slice(0, DISCORD_MAX_TEXT);
    const disabled = p.choices.map((c, i) => ({
      type: 2,
      style: 2,
      label: c.label,
      custom_id: `done${i}`,
      disabled: true,
    }));
    const rows: unknown[] = [];
    for (let i = 0; i < disabled.length; i += 5) rows.push({ type: 1, components: disabled.slice(i, i + 5) });
    try {
      await this.#respond(id, token, {
        type: 7,
        data: { content, components: rows, allowed_mentions: { parse: [] } },
      });
    } catch {
      this.#log("warn", "channel.discord.button-ui-failed", {});
    }
    const decision: ApprovalDecision = { promptId, chatId: chat, senderId: sender, choiceId, at: this.#now() };
    // Emitted even when the UI edit above failed: the press was valid, and losing the decision would strand the approval.
    for (const h of [...this.#decisionHandlers]) {
      try {
        await h(decision);
      } catch {
        this.#log("error", "channel.discord.decision-handler-failed", {});
      }
    }
  }

  async #registerCommands(api: DiscordApi, appId: string, signal: AbortSignal): Promise<void> {
    const de = MESSAGES.de;
    const en = MESSAGES.en;
    const commands: unknown[] = [];
    if (this.#pairing) {
      commands.push({
        name: "link",
        type: 1,
        description: en.cmdLink,
        description_localizations: { de: de.cmdLink },
        contexts: [1],
        options: [
          {
            type: 3,
            name: "code",
            description: en.cmdLinkCode,
            description_localizations: { de: de.cmdLinkCode },
            required: true,
            max_length: 128,
          },
        ],
      });
    }
    commands.push({
      name: "status",
      type: 1,
      description: en.cmdStatus,
      description_localizations: { de: de.cmdStatus },
      contexts: [0, 1, 2],
    });
    if (!SNOWFLAKE.test(appId)) throw new DiscordApiError("protocol", "discord application id is invalid");
    // Bulk overwrite: idempotent, and removes stale commands from earlier versions.
    await api.request({ method: "PUT", path: `/applications/${appId}/commands`, json: commands, signal });
  }

  #log(level: "debug" | "info" | "warn" | "error", event: string, attrs: Readonly<Record<string, string | number | boolean>>): void {
    const safe = redactAttrs(attrs, this.#token);
    this.#o.logger?.log(level, event, safe);
    if (level !== "debug") this.#host?.log[level](event, safe);
  }
}

function checkInbound(mime: string): void {
  if (!INBOUND_MIME.test(mime)) throw new Error("unsupported media MIME type");
}
function kindOf(mime: string): Attachment["kind"] {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "file";
}
/** Plain file name only: no path parts, no leading dots, bounded length. */
export function safeFilename(name: string, fallback = "attachment"): string {
  return name.replace(/[^A-Za-z0-9_.-]/g, "_").replace(/^\.+/, "").slice(0, 96) || fallback;
}
function safeName(a: Attachment): string {
  return safeFilename(a.filename ?? `attachment.${a.kind}`, "attachment");
}
function defaultWebSocket(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike;
}

/** Factory used by the host registry: `cfg` is the JSON config, `deps` the non-JSON seams. */
export function createDiscordChannel(cfg: DiscordConfig, deps: DiscordDeps): DiscordChannel {
  return new DiscordChannel({ ...cfg, ...deps });
}
