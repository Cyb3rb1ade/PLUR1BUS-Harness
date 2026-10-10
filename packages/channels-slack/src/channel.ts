import { randomBytes } from "node:crypto";
import type { Channel, ChannelHealth, ChannelHost, OutboundMessage } from "../../core/src/channels/types.ts";
import { ActionRegistry } from "./actions.ts";
import { SlackApi, SlackApiError } from "./api.ts";
import { resolveConfig, type ResolvedConfig, type SlackConfig, type SlackDeps } from "./config.ts";
import { MESSAGES } from "./messages.ts";
import { checkMime, kindForMime, safeFilename } from "./media.ts";
import { escapeSlackText, slackToPlain, toSlackMrkdwn } from "./mrkdwn.ts";
import { outputAttachment } from "./outputs.ts";
import { redactAttrs, redactString } from "./redact.ts";
import { TokenBucket } from "./rate-limit.ts";
import { SEEN_MAX_IDS } from "./seen.ts";
import { SocketFatalError, SocketMode, type SocketEnvelope, type SocketLike } from "./socket.ts";
import { SLACK_MAX_TEXT, SLACK_SECTION_MAX, splitMessage } from "./split.ts";
import { UnsupportedError } from "./port.ts";
import type {
  ApprovalDecision,
  ApprovalPrompt,
  Attachment,
  Button,
  ChannelCapabilities,
  InboundHandler,
  LogLevel,
  OutboundTurn,
  RichInbound,
  SentRef,
} from "./port.ts";

export type SlackChannelOptions = SlackConfig & SlackDeps;

/** Test-visible start failure; the message is fixed text and never contains a credential. */
class StartError extends Error {}

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

const ID = /^[A-Z0-9]{2,32}$/;
const EVENT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const TS = /^\d{1,10}\.\d{1,6}$/;
const BOT_TOKEN = /^xoxb-[A-Za-z0-9-]{10,200}$/;
const APP_TOKEN = /^xapp-[A-Za-z0-9-]{10,200}$/;
const USER_ID = /^[UW][A-Z0-9]{2,31}$/;
const TARGET = /^([CDGW][A-Z0-9]{2,31})(?::(\d{1,10}\.\d{1,6}))?$/;
const MAX_SEND_RETRIES = 3;
const MAX_ATTACHMENTS = 10;
const APPROVAL_TTL_MS = 300_000;
const MAX_TTL_MS = 86_400_000;
const CONVERSATION_GONE = new Set(["not_in_channel", "channel_not_found", "is_archived", "user_not_in_channel"]);

interface Target {
  channel: string;
  thread?: string;
}
interface ApprovalMeta {
  kind: "approval";
  promptId: string;
  text: string;
  labels: ReadonlyMap<string, string>;
}
interface ButtonMeta {
  kind: "button";
  text: string;
}
type ActionMeta = ApprovalMeta | ButtonMeta;

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const keyOf = (t: Target): string => (t.thread ? `${t.channel}:${t.thread}` : t.channel);
const clip = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, n - 1) + "…");

export class SlackChannel implements Channel {
  readonly name = "slack" as const;
  readonly capabilities: ChannelCapabilities = {
    threads: true,
    edit: true,
    typing: false,
    attachmentsIn: true,
    attachmentsOut: true,
    reactions: true,
    buttons: true,
    approvalMode: "buttons",
    markdown: "converted",
    maxMessageChars: SLACK_MAX_TEXT,
  };
  readonly #deps: SlackDeps;
  readonly #cfg: ResolvedConfig;
  readonly #handlers = new Set<InboundHandler>();
  readonly #decisionHandlers = new Set<(d: ApprovalDecision) => void | Promise<void>>();
  readonly #now: () => number;
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly #random: () => number;
  readonly #actions: ActionRegistry<ActionMeta>;
  readonly #global = new TokenBucket(20, 50, Date.now, defaultSleep);
  readonly #chats = new Map<string, TokenBucket>();
  readonly #inactive = new Set<string>();
  readonly #dmUsers = new Map<string, string>();
  readonly #ownerDms = new Map<string, string>();
  readonly #seen = new Set<string>();
  readonly #seenOrder: string[] = [];
  #host: ChannelHost | undefined;
  #api: SlackApi | undefined;
  #ac: AbortController | undefined;
  #socket: SocketMode | undefined;
  #starting: Promise<void> | undefined;
  #queue: Promise<void> = Promise.resolve();
  #botUserId: string | undefined;
  #teamId: string | undefined;
  #healthy = false;
  #secrets: string[] = [];

  constructor(opts: SlackChannelOptions) {
    this.#cfg = resolveConfig(opts);
    this.#deps = opts;
    this.#now = opts.now ?? Date.now;
    this.#sleep = opts.sleep ?? defaultSleep;
    this.#random = opts.random ?? Math.random;
    this.#actions = new ActionRegistry<ActionMeta>(randomBytes(32).toString("hex"), this.#now);
    this.#global = new TokenBucket(20, 50, this.#now, this.#sleep);
  }

  onMessage(handler: InboundHandler): () => void {
    this.#handlers.add(handler);
    return () => void this.#handlers.delete(handler);
  }

  onDecision(handler: (d: ApprovalDecision) => void | Promise<void>): () => void {
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
    try {
      const botToken = await this.#secret(this.#cfg.botTokenSecret, BOT_TOKEN, "bot token");
      const appToken = await this.#secret(this.#cfg.appTokenSecret, APP_TOKEN, "app token");
      this.#secrets = [botToken, appToken];
      this.#api = new SlackApi({
        botToken,
        appToken,
        ...(this.#deps.baseUrl !== undefined ? { baseUrl: this.#deps.baseUrl } : {}),
        ...(this.#deps.fetch !== undefined ? { fetch: this.#deps.fetch } : {}),
      });
      const me = await this.#api.call<{ user_id?: unknown; team_id?: unknown }>("auth.test", {}, signal);
      if (typeof me.user_id !== "string" || !ID.test(me.user_id) || typeof me.team_id !== "string" || !ID.test(me.team_id))
        throw new StartError("slack identity lookup returned no bot identity");
      if (this.#cfg.teamId !== undefined && me.team_id !== this.#cfg.teamId)
        throw new StartError("slack workspace does not match teamId");
      this.#botUserId = me.user_id;
      this.#teamId = me.team_id;
      this.#host = host;
      await this.#loadSeen();
      this.#socket = new SocketMode({
        openUrl: (s) => this.#openUrl(s),
        socketFactory: this.#deps.webSocket ?? ((url: string) => new WebSocket(url) as unknown as SocketLike),
        onEnvelope: (env) => this.#onEnvelope(env),
        onFatal: (err) => this.#fatal(err),
        onState: (c) => {
          this.#healthy = c;
        },
        log: (l, e, a) => this.#log(l, e, a),
        sleep: this.#sleep,
        random: this.#random,
        now: this.#now,
      });
      await this.#socket.start(signal);
      this.#healthy = this.#socket.connected;
      this.#log("info", "channel.slack.started", { allowed: this.#cfg.allow.size, resumed: this.#seen.size > 0 });
    } catch (e) {
      ac.abort();
      this.#ac = undefined;
      this.#api = undefined;
      this.#socket = undefined;
      this.#host = undefined;
      this.#healthy = false;
      if (e instanceof SocketFatalError || (e instanceof SlackApiError && e.kind === "unauthorized")) {
        this.#log("error", "channel.slack.auth-failed", {});
        throw new Error("slack authentication failed");
      }
      if (e instanceof StartError) throw new Error(e.message);
      throw new Error("slack start failed");
    } finally {
      this.#secrets = this.#ac ? this.#secrets : [];
    }
  }

  async #secret(name: string, shape: RegExp, label: string): Promise<string> {
    let v: string | null;
    try {
      v = await this.#deps.secrets.reveal(name);
    } catch {
      throw new StartError(`slack ${label} secret read failed`);
    }
    if (v === null) throw new StartError(`slack ${label} secret is not set`);
    const t = v.trim();
    if (!shape.test(t)) throw new StartError(`slack ${label} secret has an unexpected format`);
    return t;
  }

  async #loadSeen(): Promise<void> {
    let ids: string[] | undefined;
    try {
      ids = await this.#deps.seen?.load();
    } catch {
      throw new StartError("slack dedupe state is unusable");
    }
    this.#seen.clear();
    this.#seenOrder.length = 0;
    for (const id of ids ?? []) if (EVENT_ID.test(id) && !this.#seen.has(id)) this.#remember(id);
  }

  #remember(id: string): void {
    this.#seen.add(id);
    this.#seenOrder.push(id);
    if (this.#seenOrder.length > SEEN_MAX_IDS) this.#seen.delete(this.#seenOrder.shift()!);
  }

  /** Records an id as handled; false if it was already handled. Persists before dispatch (at-most-once per id). */
  async #claim(id: string): Promise<boolean> {
    if (this.#seen.has(id)) {
      this.#log("debug", "channel.slack.duplicate", {});
      return false;
    }
    this.#remember(id);
    try {
      await this.#deps.seen?.save([...this.#seenOrder]);
    } catch {
      this.#log("error", "channel.slack.dedupe-save-failed", {});
    }
    return true;
  }

  async stop(): Promise<void> {
    this.#healthy = false;
    this.#ac?.abort();
    await this.#starting?.catch(() => {});
    await this.#socket?.stop();
    await this.#queue;
    this.#actions.clear();
    this.#socket = undefined;
    this.#ac = undefined;
    this.#api = undefined;
    this.#host = undefined;
    this.#secrets = [];
    this.#log("info", "channel.slack.stopped", {});
  }

  async health(): Promise<ChannelHealth> {
    return { ok: this.#healthy && this.#ac !== undefined };
  }

  /** Resolves when every inbound envelope queued so far has been processed (test and shutdown seam). */
  idle(): Promise<void> {
    return this.#queue;
  }

  /** Framework path: markdown is converted and split; rejects if not started. */
  async send(msg: OutboundMessage): Promise<void> {
    await this.sendTurn({ chatId: msg.chatId, text: msg.text, ...(msg.replyTo !== undefined ? { replyTo: msg.replyTo } : {}) });
  }

  async sendOutput(chatId: string, outputId: string, index = 0): Promise<SentRef[]> {
    this.#target(chatId);
    if (!this.#deps.outputs) throw new Error("media output store unavailable");
    const attachment = await outputAttachment(this.#deps.outputs, outputId, chatId, this.#cfg.maxMediaBytes, index);
    return this.sendTurn({ chatId, text: "", attachments: [attachment] });
  }

  /**
   * The conversation in which a message reaches this Slack user directly (conversations.open -> D...), for an explicit owner
   * test. Only a user who may DM the bot (dmAllowlist) gets one; the opened DM is then sendable, nothing else is widened.
   */
  async resolveOwnerTarget(who: { userId: string; accountId?: string }): Promise<string> {
    if (!this.#api || !this.#ac) throw new Error("slack channel is not started");
    const user = who?.userId;
    if (typeof user !== "string" || !USER_ID.test(user)) throw new Error("invalid slack user id");
    if (!this.#cfg.dm.has(user)) throw new Error("slack user is not on the dm allowlist");
    let dm = this.#ownerDms.get(user);
    if (dm === undefined || this.#inactive.has(dm)) {
      try {
        const r = await this.#retry(this.#ac.signal, () =>
          this.#api!.call<{ channel?: unknown }>("conversations.open", { users: user }, this.#ac!.signal),
        );
        const id = str(obj(r.channel)?.id);
        if (!id || !/^D[A-Z0-9]{2,31}$/.test(id)) throw new Error("slack returned no direct message channel");
        dm = id;
      } catch (e) {
        throw new Error(redactString(e instanceof Error ? e.message : "conversations.open failed", ...this.#secrets));
      }
      this.#ownerDms.set(user, dm);
      this.#inactive.delete(dm);
    }
    this.#dmUsers.set(dm, user); // #target allows a DM whose user is on dmAllowlist
    return dm;
  }

  async sendTurn(turn: OutboundTurn): Promise<SentRef[]> {
    if (!this.#api || !this.#ac) throw new Error("slack channel is not started");
    const t = this.#target(turn.chatId);
    const signal = this.#ac.signal;
    const thread = turn.threadId ?? t.thread ?? turn.replyTo;
    if (thread !== undefined && !TS.test(thread)) throw new Error("invalid slack thread");
    const buttons = (turn.buttons ?? []).filter((row) => row.length > 0);
    const md = turn.format === "plain" ? escapeSlackText(turn.text) : toSlackMrkdwn(turn.text);
    const chunks = md.trim() ? splitMessage(md, buttons.length ? SLACK_SECTION_MAX : SLACK_MAX_TEXT) : [];
    if (buttons.length && !chunks.length) throw new Error("buttons need message text");
    if (chunks.length > 40) throw new Error("message too long");
    const refs: SentRef[] = [];
    const conv: Target = { channel: t.channel, ...(thread !== undefined ? { thread } : {}) };
    for (const [i, chunk] of chunks.entries()) {
      const body: Record<string, unknown> = {
        channel: t.channel,
        text: chunk,
        mrkdwn: true,
        unfurl_links: false,
        unfurl_media: false,
        link_names: false,
        ...(thread !== undefined ? { thread_ts: thread } : {}),
      };
      let groupId: string | undefined;
      if (i === chunks.length - 1 && buttons.length) {
        const ttl = Math.max(...buttons.flat().map((b) => b.ttlMs ?? APPROVAL_TTL_MS));
        const flat = buttons.flat();
        const issued = this.#actions.issue({
          chatId: keyOf(conv),
          ttlMs: ttl,
          entries: flat.map((b) => ({ data: b.data, ...(b.senderId !== undefined ? { senderId: b.senderId } : {}) })),
          meta: { kind: "button", text: clip(chunk, SLACK_SECTION_MAX) },
        });
        groupId = issued.id;
        let k = 0;
        const rows = buttons.map((row) => row.map((b) => ({ b, handle: issued.handles[k++]! })));
        body.blocks = [sectionBlock(chunk), ...rows.map((row) => actionsBlock(row.map((x) => ({ label: x.b.text, handle: x.handle, style: undefined as "primary" | "danger" | undefined }))))];
      }
      try {
        refs.push({ chatId: turn.chatId, messageId: await this.#post(t.channel, "chat.postMessage", body, signal), kind: "message" });
      } catch (e) {
        if (groupId) this.#actions.revoke(groupId);
        throw e;
      }
    }
    for (const a of turn.attachments ?? []) {
      if (a.data.byteLength > this.#cfg.maxMediaBytes) throw new Error("outbound media exceeds size limit");
      checkMime(a.kind, a.mimeType);
      refs.push(await this.#upload(t.channel, thread, turn.chatId, a, signal));
    }
    return refs;
  }

  async edit(ref: SentRef, text: string): Promise<void> {
    if (!this.#api || !this.#ac) throw new Error("slack channel is not started");
    if (ref.kind === "file") throw new UnsupportedError("uploaded files cannot be edited");
    const t = this.#target(ref.chatId);
    if (!TS.test(ref.messageId)) throw new Error("invalid slack message ref");
    const md = toSlackMrkdwn(text);
    if (!md.trim()) throw new Error("edit text is empty");
    if (splitMessage(md).length > 1) throw new RangeError("edit text exceeds one Slack message");
    await this.#post(t.channel, "chat.update", { channel: t.channel, ts: ref.messageId, text: md, mrkdwn: true }, this.#ac.signal);
  }

  /** Slack bots have no general typing indicator. Documented no-op (capabilities.typing = false). */
  async typing(_chatId: string): Promise<void> {
    return;
  }

  async prompt(req: ApprovalPrompt): Promise<{ promptId: string; refs: SentRef[] }> {
    if (!this.#api || !this.#ac) throw new Error("slack channel is not started");
    const signal = this.#ac.signal;
    const base = this.#target(req.chatId);
    const thread = req.threadId ?? base.thread;
    if (thread !== undefined && !TS.test(thread)) throw new Error("invalid slack thread");
    const target: Target = { channel: base.channel, ...(thread !== undefined ? { thread } : {}) };
    if (!req.approverIds.length) throw new Error("approval needs at least one approver");
    if (req.approverIds.some((id) => !ID.test(id))) throw new Error("invalid approver id");
    if (req.choices.length < 1 || req.choices.length > 5) throw new RangeError("approval needs 1..5 choices");
    const seenIds = new Set<string>();
    for (const c of req.choices) {
      if (!/^[a-z0-9_-]{1,32}$/.test(c.id) || seenIds.has(c.id) || !c.label) throw new RangeError("invalid approval choice");
      seenIds.add(c.id);
    }
    const ttl = req.ttlMs ?? APPROVAL_TTL_MS;
    if (!Number.isFinite(ttl) || ttl <= 0 || ttl > MAX_TTL_MS) throw new RangeError("approval TTL must be 1 ms..24 h");
    const md = toSlackMrkdwn(req.text);
    const sections = md.trim() ? splitMessage(md, SLACK_SECTION_MAX) : [];
    if (!sections.length || sections.length > 40) throw new Error("approval text is empty or too long");
    const promptId = randomBytes(12).toString("base64url");
    const labels = new Map(req.choices.map((c) => [c.id, clip(c.label, 75)] as const));
    const issued = this.#actions.issue({
      chatId: keyOf(target),
      approvers: req.approverIds,
      ttlMs: ttl,
      entries: req.choices.map((c) => ({ data: c.id })),
      meta: { kind: "approval", promptId, text: clip(sections.join("\n\n"), SLACK_SECTION_MAX), labels },
    });
    const buttons = req.choices.map((c, i) => ({
      label: clip(c.label, 75),
      handle: issued.handles[i]!,
      style: (i === 0 ? "primary" : c.id === "deny" ? "danger" : undefined) as "primary" | "danger" | undefined,
    }));
    const body: Record<string, unknown> = {
      channel: target.channel,
      text: sections[0],
      mrkdwn: true,
      unfurl_links: false,
      unfurl_media: false,
      link_names: false,
      blocks: [...sections.map(sectionBlock), actionsBlock(buttons)],
      ...(target.thread !== undefined ? { thread_ts: target.thread } : {}),
    };
    let ts: string;
    try {
      ts = await this.#post(target.channel, "chat.postMessage", body, signal);
    } catch (e) {
      this.#actions.revoke(issued.id);
      throw e;
    }
    return { promptId, refs: [{ chatId: req.chatId, messageId: ts, kind: "message" }] };
  }

  // ---------------------------------------------------------------- inbound

  #onEnvelope(env: SocketEnvelope): void {
    const p = obj(env.payload);
    if (!p) return;
    if (env.type === "events_api") {
      const eid = str(p.event_id);
      if (!eid || !EVENT_ID.test(eid)) return;
      this.#enqueue(() => this.#event(p, `ev:${eid}`));
    } else if (env.type === "interactive") {
      this.#enqueue(() => this.#interactive(p));
    } else if (env.type === "slash_commands") {
      this.#enqueue(() => this.#command(p));
    }
  }

  #enqueue(job: () => Promise<void>): void {
    this.#queue = this.#queue.then(async () => {
      if (this.#ac?.signal.aborted) return;
      try {
        await job();
      } catch {
        this.#log("error", "channel.slack.handler-failed", {});
      }
    });
  }

  async #event(p: Record<string, unknown>, key: string): Promise<void> {
    if (!(await this.#claim(key))) return;
    const team = str(p.team_id);
    if (team !== undefined && this.#teamId !== undefined && team !== this.#teamId) return this.#drop("team");
    const ev = obj(p.event);
    if (!ev) return;
    if (ev.type === "message") return this.#message(ev, false);
    if (ev.type === "app_mention") return this.#message(ev, true);
    if (ev.type === "reaction_added") return this.#reaction(ev);
  }

  #drop(reason: string): void {
    this.#log("debug", "channel.slack.dropped", { reason });
  }

  async #message(ev: Record<string, unknown>, viaMention: boolean): Promise<void> {
    const channel = str(ev.channel);
    const user = str(ev.user);
    const ts = str(ev.ts);
    if (!channel || !ID.test(channel) || !user || !ID.test(user) || !ts || !TS.test(ts)) return this.#drop("shape");
    if (ev.bot_id !== undefined || ev.bot_profile !== undefined || user === this.#botUserId) return this.#drop("bot");
    const subtype = str(ev.subtype);
    if (subtype !== undefined && subtype !== "file_share" && subtype !== "thread_broadcast") return this.#drop("subtype");
    const direct = ev.channel_type === "im" || (ev.channel_type === undefined && channel.startsWith("D"));
    const raw = str(ev.text) ?? "";
    const mention = viaMention || raw.includes(`<@${this.#botUserId}>`);
    const threadTs = str(ev.thread_ts) && TS.test(str(ev.thread_ts)!) ? str(ev.thread_ts) : undefined;
    if (direct) {
      if (!this.#cfg.dm.has(user) && !this.#cfg.allow.has(channel)) return this.#drop("dm-sender");
      this.#dmUsers.set(channel, user);
    } else {
      if (!this.#cfg.allow.has(channel)) return this.#drop("chat");
      const users = this.#cfg.users;
      const member = users !== undefined && users.has(user);
      const hear =
        this.#cfg.policy === "always"
          ? users === undefined || member
          : this.#cfg.policy === "allowlist"
            ? member || mention
            : mention && (users === undefined || member);
      if (!hear) return this.#drop("not-addressed");
    }
    if (!(await this.#claim(`msg:${channel}:${ts}`))) return;
    const chatId = threadTs ? `${channel}:${threadTs}` : channel;
    let attachments: Attachment[];
    try {
      attachments = await this.#media(ev.files);
    } catch {
      this.#log("warn", "channel.slack.media-rejected", { chatId });
      return;
    }
    const text = slackToPlain(raw.replace(new RegExp(`<@${this.#botUserId}(?:\\|[^>]*)?>`, "g"), "")).trim();
    if (!text && attachments.length === 0) return;
    const message: RichInbound = {
      channel: this.name,
      chatId,
      chatKind: direct ? "direct" : "group",
      senderId: user,
      text,
      messageId: ts,
      sentAt: Math.round(Number(ts) * 1000),
      mention: direct || mention,
      ...(threadTs !== undefined ? { threadId: threadTs } : {}),
      ...(attachments.length ? { attachments } : {}),
    };
    await this.#emit(message);
  }

  async #reaction(ev: Record<string, unknown>): Promise<void> {
    const user = str(ev.user);
    const item = obj(ev.item);
    const channel = str(item?.channel);
    const ts = str(item?.ts);
    const emoji = str(ev.reaction);
    if (!user || !ID.test(user) || !channel || !ID.test(channel) || !ts || !TS.test(ts) || !emoji) return this.#drop("shape");
    if (user === this.#botUserId) return this.#drop("bot");
    const direct = channel.startsWith("D");
    if (direct) {
      if (!this.#cfg.dm.has(user) && !this.#cfg.allow.has(channel)) return this.#drop("dm-sender");
      this.#dmUsers.set(channel, user);
    } else {
      if (!this.#cfg.allow.has(channel)) return this.#drop("chat");
      if (this.#cfg.users !== undefined && !this.#cfg.users.has(user)) return this.#drop("user");
    }
    await this.#emit({
      channel: this.name,
      chatId: channel,
      chatKind: direct ? "direct" : "group",
      senderId: user,
      text: "",
      messageId: ts,
      reaction: { emoji: emoji.slice(0, 64), itemTs: ts },
    });
  }

  async #media(files: unknown): Promise<Attachment[]> {
    if (!Array.isArray(files) || files.length === 0) return [];
    if (files.length > MAX_ATTACHMENTS) throw new Error("too many attachments");
    const signal = this.#ac!.signal;
    const max = this.#cfg.maxMediaBytes;
    const out: Attachment[] = [];
    for (const raw of files) {
      const f = obj(raw);
      if (!f) throw new Error("invalid file");
      const mime = (str(f.mimetype) ?? "application/octet-stream").split(";")[0]!.trim().toLowerCase();
      const kind = kindForMime(mime);
      checkMime(kind, mime);
      if (typeof f.size === "number" && f.size > max) throw new Error("media size limit");
      const url = str(f.url_private_download) ?? str(f.url_private);
      if (!url) throw new Error("media unavailable");
      const dl = await this.#retry(signal, () => this.#api!.download(url, max, signal));
      if (dl.mimeType !== "application/octet-stream" && dl.mimeType !== mime) throw new Error("media MIME mismatch");
      const name = str(f.name);
      out.push({ kind, data: dl.data, mimeType: mime, ...(name ? { filename: safeFilename(name) } : {}) });
    }
    return out;
  }

  async #emit(message: RichInbound): Promise<void> {
    for (const h of [...this.#handlers]) {
      try {
        await h(message);
      } catch {
        this.#log("error", "channel.slack.handler-failed", {});
      }
    }
    if (this.#host) {
      // Framework v1 is text-only: rich turns reach onMessage; they are never silently claimed as framework support.
      if (!message.text || message.callback || message.attachments?.length) {
        this.#log("warn", "channel.slack.framework-rich-turn-gap", {});
        return;
      }
      try {
        await this.#host.receive(message);
      } catch {
        this.#log("error", "channel.slack.host-failed", {});
      }
    }
  }

  async #interactive(p: Record<string, unknown>): Promise<void> {
    if (p.type !== "block_actions") return;
    const user = str(obj(p.user)?.id);
    const channel = str(obj(p.channel)?.id);
    const msg = obj(p.message);
    const action = Array.isArray(p.actions) ? obj(p.actions[0]) : undefined;
    const wire = str(action?.action_id);
    if (!user || !ID.test(user) || !channel || !ID.test(channel) || !wire) return this.#drop("shape");
    const threadTs = str(msg?.thread_ts);
    const key = keyOf({ channel, ...(threadTs && TS.test(threadTs) ? { thread: threadTs } : {}) });
    const msgs = MESSAGES[this.#cfg.locale];
    // Policy first: a refused press must neither consume the handle nor reach a decision path.
    if (channel.startsWith("D")) {
      if (!this.#cfg.dm.has(user) && !this.#cfg.allow.has(channel)) return this.#drop("dm-sender");
    } else {
      if (!this.#cfg.allow.has(channel)) return this.#drop("chat");
      if (this.#cfg.users !== undefined && !this.#cfg.users.has(user))
        return this.#ephemeral(channel, user, msgs.approvalForbidden);
    }
    const r = this.#actions.activate(wire, key, user);
    if (r.status === "invalid") return this.#ephemeral(channel, user, msgs.approvalExpired);
    if (r.status === "forbidden") return this.#ephemeral(channel, user, msgs.approvalForbidden);
    const ts = str(msg?.ts);
    const meta = r.group.meta;
    const entry = r.entry;
    if (meta.kind === "approval") {
      const label = meta.labels.get(entry.data) ?? entry.data;
      const decision: ApprovalDecision = { promptId: meta.promptId, chatId: key, senderId: user, choiceId: entry.data, at: this.#now() };
      for (const h of [...this.#decisionHandlers]) {
        try {
          await h(decision);
        } catch {
          this.#log("error", "channel.slack.decision-handler-failed", {});
        }
      }
      await this.#settle(channel, ts, meta.text, msgs.approvalDecided(label, user));
      return;
    }
    const chatKind = channel.startsWith("D") ? "direct" : "group";
    await this.#emit({
      channel: this.name,
      chatId: key,
      chatKind,
      senderId: user,
      text: entry.data,
      ...(ts ? { messageId: ts } : {}),
      callback: { id: r.group.id, data: entry.data },
      ...(threadTs ? { threadId: threadTs } : {}),
    });
    await this.#settle(channel, ts, meta.text, msgs.buttonReceived);
  }

  async #command(p: Record<string, unknown>): Promise<void> {
    if (str(p.command) !== "/plur1bus") return;
    const user = str(p.user_id);
    const channel = str(p.channel_id);
    if (!user || !ID.test(user) || !channel || !ID.test(channel)) return;
    const msgs = MESSAGES[this.#cfg.locale];
    const m = /^(status|link)(?:\s+(\S+))?$/i.exec((str(p.text) ?? "").trim());
    const verb = m?.[1]?.toLowerCase();
    let reply = msgs.usage(this.#deps.pairing !== undefined);
    if (verb === "status") reply = msgs.status;
    else if (verb === "link") {
      if (!this.#deps.pairing) reply = msgs.usage(false);
      else if (str(p.channel_name) !== "directmessage") reply = msgs.pairingDmOnly;
      else if (!m?.[2] || !this.#botUserId) reply = msgs.pairingFail;
      else {
        try {
          // The code is passed straight to the identity port and never logged or echoed.
          await this.#deps.pairing.claim({
            code: m[2],
            identity: { channel: this.name, accountId: this.#botUserId, userId: user },
          });
          reply = msgs.pairingOk;
        } catch {
          reply = msgs.pairingFail;
        }
      }
    }
    await this.#ephemeral(channel, user, reply);
  }

  async #ephemeral(channel: string, user: string, text: string): Promise<void> {
    if (!this.#api || !this.#ac) return;
    try {
      await this.#api.call("chat.postEphemeral", { channel, user, text: escapeSlackText(text) }, this.#ac.signal);
    } catch {
      this.#log("warn", "channel.slack.ephemeral-failed", {});
    }
  }

  async #settle(channel: string, ts: string | undefined, text: string, suffix: string): Promise<void> {
    if (!ts || !TS.test(ts) || !this.#ac) return;
    try {
      // chat.update without blocks replaces the whole message, so the buttons disappear.
      await this.#post(channel, "chat.update", { channel, ts, text: `${text}\n\n${suffix}`, mrkdwn: true }, this.#ac.signal);
    } catch {
      this.#log("warn", "channel.slack.settle-failed", {});
    }
  }

  // ---------------------------------------------------------------- outbound plumbing

  #target(id: string): Target {
    const m = TARGET.exec(id);
    if (!m) throw new Error("invalid slack conversation id");
    const channel = m[1]!;
    const dmOk = this.#dmUsers.has(channel) && this.#cfg.dm.has(this.#dmUsers.get(channel)!);
    if (!this.#cfg.allow.has(channel) && !dmOk) throw new Error("chat is not on the slack allowlist");
    if (this.#inactive.has(channel)) throw new Error("slack chat is inactive");
    return { channel, ...(m[2] !== undefined ? { thread: m[2] } : {}) };
  }

  #bucket(channel: string): TokenBucket {
    let b = this.#chats.get(channel);
    if (!b) {
      b = new TokenBucket(1, 1000, this.#now, this.#sleep);
      this.#chats.set(channel, b);
    }
    return b;
  }

  async #post(channel: string, method: "chat.postMessage" | "chat.update", body: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const bucket = this.#bucket(channel);
    const r = await this.#retry(signal, async () => {
      await bucket.take(signal);
      await this.#global.take(signal);
      if (this.#inactive.has(channel)) throw new Error("slack chat is inactive");
      try {
        return await this.#api!.call<{ ts?: unknown }>(method, body, signal);
      } catch (e) {
        if (e instanceof SlackApiError && e.kind === "forbidden" && e.code !== undefined && CONVERSATION_GONE.has(e.code))
          this.#inactive.add(channel);
        throw e;
      }
    });
    const ts = str(r.ts) ?? "";
    if (method === "chat.postMessage" && !TS.test(ts)) throw new Error("slack returned no message timestamp");
    return ts;
  }

  async #upload(channel: string, thread: string | undefined, chatId: string, a: Attachment, signal: AbortSignal): Promise<SentRef> {
    const api = this.#api!;
    const filename = safeFilename(a.filename ?? `attachment.${a.kind}`);
    const slot = await this.#retry(signal, () =>
      api.call<{ upload_url?: unknown; file_id?: unknown }>(
        "files.getUploadURLExternal",
        { filename, length: a.data.byteLength },
        signal,
        { form: true },
      ),
    );
    const uploadUrl = str(slot.upload_url);
    const fileId = str(slot.file_id);
    if (!uploadUrl || !fileId || !/^F[A-Z0-9]{2,40}$/.test(fileId)) throw new Error("slack upload slot unavailable");
    await this.#retry(signal, () => api.uploadBytes(uploadUrl, a.data, signal));
    await this.#retry(signal, () =>
      api.call(
        "files.completeUploadExternal",
        { files: [{ id: fileId, title: filename }], channel_id: channel, ...(thread !== undefined ? { thread_ts: thread } : {}) },
        signal,
      ),
    );
    return { chatId, messageId: fileId, kind: "file" };
  }

  async #retry<T>(signal: AbortSignal, call: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      try {
        return await call();
      } catch (e) {
        if (
          !(e instanceof SlackApiError) ||
          !(["rate-limited", "network", "timeout"].includes(e.kind) || (e.kind === "http" && (e.status ?? 0) >= 500)) ||
          attempt >= MAX_SEND_RETRIES ||
          signal.aborted
        )
          throw e;
        const wait =
          e.kind === "rate-limited"
            ? (e.retryAfterMs ?? 1000)
            : Math.round(Math.min(60_000, 1000 * 2 ** attempt) * (0.75 + this.#random() * 0.5));
        this.#log("warn", "channel.slack.request-retry", { kind: e.kind, waitMs: wait, attempt });
        await this.#sleep(wait, signal);
      }
    }
  }

  async #openUrl(signal: AbortSignal): Promise<string> {
    const url = await this.#api!.openSocketUrl(signal);
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new SlackApiError("protocol", "apps.connections.open returned an invalid URL");
    }
    if (u.protocol !== "wss:") throw new SlackApiError("protocol", "apps.connections.open returned a non-wss URL");
    return url;
  }

  #fatal(err: SocketFatalError): void {
    this.#healthy = false;
    this.#log("error", "channel.slack.auth-failed", { code: err.code.slice(0, 40) });
    this.#host?.fail(new Error("slack authentication failed"));
  }

  #log(level: LogLevel, event: string, attrs: Record<string, string | number | boolean>): void {
    const safe = redactAttrs(attrs, ...this.#secrets);
    this.#deps.logger?.log(level, event, safe);
    if (level !== "debug") this.#host?.log[level](event, safe);
  }
}

function sectionBlock(text: string): Record<string, unknown> {
  return { type: "section", text: { type: "mrkdwn", text } };
}

function actionsBlock(
  buttons: readonly { label: string; handle: string; style: "primary" | "danger" | undefined }[],
): Record<string, unknown> {
  return {
    type: "actions",
    elements: buttons.slice(0, 25).map((b) => ({
      type: "button",
      text: { type: "plain_text", text: clip(b.label, 75), emoji: false },
      action_id: b.handle,
      ...(b.style !== undefined ? { style: b.style } : {}),
    })),
  };
}

/** Factory: JSON-serialisable config plus non-JSON seams. */
export function createSlackChannel(cfg: SlackConfig, deps: SlackDeps): SlackChannel {
  return new SlackChannel({ ...cfg, ...deps });
}
