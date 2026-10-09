// DUPLICATE: candidate for shared package (the lifecycle, bucket and retry shape mirrors channels-telegram).
import { randomBytes } from "node:crypto";
import type { IdentityService } from "../../core/src/identity/service.ts";
import type { Channel, ChannelHealth, ChannelHost, OutboundMessage } from "../../core/src/channels/types.ts";
import { MatrixApi, MatrixApiError, parseMxc } from "./api.ts";
import { ReactionApprovals, choiceEmoji, MAX_PENDING_APPROVALS, validatePrompt } from "./approvals.ts";
import { resolveConfig, type MatrixConfig, type ResolvedConfig } from "./config.ts";
import { BoundedSet } from "./dedupe.ts";
import {
  MESSAGE_TYPES,
  SYNC_FILTER,
  formatChatId,
  isEventId,
  isObj,
  isRoomId,
  isUserId,
  mentionsBot,
  parseChatId,
  relates,
  replyTarget,
  stripReplyFallback,
  threadRoot,
  type MatrixEvent,
  type SyncResponse,
} from "./events.ts";
import { toMatrixText } from "./markdown.ts";
import { message as t } from "./messages.ts";
import { outputAttachment, type OutputPort } from "./outputs.ts";
import { TokenBucket } from "./rate-limit.ts";
import { redactAttrs } from "./redact.ts";
import {
  type ApprovalDecision,
  type ApprovalPrompt,
  type Attachment,
  type ChannelCapabilities,
  type ChannelLogger,
  type LogLevel,
  type OutboundTurn,
  type RichInbound,
  type SecretReader,
  type SentRef,
  type SyncTokenStore,
} from "./port.ts";
import { MATRIX_MAX_BODY_BYTES, splitMessage } from "./split.ts";

export interface MatrixDeps {
  /** Reads the access token by secret NAME (`accessTokenSecret`). */
  secrets: SecretReader;
  /** Required persistent `/sync` position. Corrupt state fails closed at start. */
  syncStore: SyncTokenStore;
  /** Host-supplied pairing port; the claimant is the Matrix sender of a DM `/link`, never command text. */
  pairing?: Pick<IdentityService, "claim">;
  outputs?: OutputPort;
  logger?: ChannelLogger;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  random?: () => number;
  /** Retries for send/upload-class requests (rate limit, network, timeout, 5xx). Default 3. */
  maxSendRetries?: number;
  /** Long-poll timeout for `/sync`. Default 30 s. */
  syncTimeoutMs?: number;
}

export type MatrixChannelOptions = MatrixConfig & MatrixDeps;

const TOKEN_FORMAT = /^[\x21-\x7e]{8,1024}$/;
const LONG_POLL_MS = 30_000;
const TYPING_MS = 30_000;
const SAFE_MIME = /^(image\/(jpeg|png|webp|gif)|audio\/(ogg|mpeg|mp4|wav|x-wav|flac|webm)|video\/(mp4|webm)|application\/(pdf|json|zip|octet-stream)|text\/plain)$/;
const MSGTYPE_OF: Record<string, Attachment["kind"]> = {
  "m.image": "photo",
  "m.file": "document",
  "m.audio": "audio",
  "m.video": "video",
};
const OUT_MSGTYPE: Record<Attachment["kind"], string> = {
  photo: "m.image",
  document: "m.file",
  voice: "m.audio",
  audio: "m.audio",
  video: "m.video",
};
const LINK_COMMAND = /^[/!]link(?:\s+(\S+))?\s*$/i;

export function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Message text an unescaped `@room` would ping the room with; a zero-width space keeps it inert. */
const neutral = (s: string): string => s.replace(/@room\b/g, "@​room");

function checkMime(kind: Attachment["kind"], mime: string): void {
  if (!SAFE_MIME.test(mime)) throw new Error("unsupported media MIME type");
  if (kind === "photo" && !mime.startsWith("image/")) throw new Error("unsupported media MIME type");
  if ((kind === "voice" || kind === "audio") && !mime.startsWith("audio/")) throw new Error("unsupported media MIME type");
  if (kind === "video" && !mime.startsWith("video/")) throw new Error("unsupported media MIME type");
  if (mime === "application/octet-stream" && kind !== "document") throw new Error("unsupported media MIME type");
}

const sanitizeName = (s: string): string => s.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 128);

export class MatrixChannel implements Channel {
  readonly name = "matrix" as const;
  readonly capabilities: ChannelCapabilities = {
    threads: true,
    edit: true,
    typing: true,
    attachmentsIn: true,
    attachmentsOut: true,
    reactions: true,
    buttons: false,
    approvalMode: "reactions",
    markdown: "converted",
    maxMessageChars: MATRIX_MAX_BODY_BYTES,
  };
  readonly #cfg: ResolvedConfig;
  readonly #deps: MatrixDeps;
  readonly #now: () => number;
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly #random: () => number;
  readonly #global: TokenBucket;
  readonly #rooms = new Map<string, TokenBucket>();
  readonly #inactive = new Set<string>();
  readonly #handlers = new Set<(m: RichInbound) => void | Promise<void>>();
  readonly #decisionHandlers = new Set<(d: ApprovalDecision) => void | Promise<void>>();
  readonly #approvals: ReactionApprovals;
  readonly #seen = new BoundedSet<string>(4096);
  readonly #sentIds = new BoundedSet<string>(4096);
  readonly #handledInvites = new BoundedSet<string>(1024);
  readonly #encrypted = new BoundedSet<string>(4096);
  readonly #noticed = new BoundedSet<string>(4096);
  /** DM rooms from m.direct whose peer is on dmAllowlist. */
  #mDirectRooms = new Set<string>();
  /** DM rooms joined from a direct invite by a dmAllowlist inviter. */
  readonly #inviteDirectRooms = new Set<string>();
  #host: ChannelHost | undefined;
  #botName: string | undefined;
  #api: MatrixApi | undefined;
  #token: string | undefined;
  #ac: AbortController | undefined;
  #loop: Promise<void> | undefined;
  #starting: Promise<void> | undefined;
  #since: string | undefined;
  #healthy = false;
  #updates: Promise<void> = Promise.resolve();

  constructor(opts: MatrixChannelOptions) {
    this.#cfg = resolveConfig(opts);
    this.#deps = opts;
    this.#now = opts.now ?? Date.now;
    this.#sleep = opts.sleep ?? defaultSleep;
    this.#random = opts.random ?? Math.random;
    this.#global = new TokenBucket(30, 1000 / 30, this.#now, this.#sleep);
    this.#approvals = new ReactionApprovals(this.#now);
  }

  onMessage(handler: (m: RichInbound) => void | Promise<void>): () => void {
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
      let token: string | null;
      try {
        token = await this.#deps.secrets.reveal(this.#cfg.accessTokenSecret);
      } catch {
        throw new Error("matrix secret read failed");
      }
      if (token === null) throw new Error("matrix access token secret is not set");
      if (!TOKEN_FORMAT.test(token)) throw new Error("matrix access token secret has an unexpected format");
      this.#token = token;
      this.#host = host;
      this.#api = new MatrixApi({
        homeserverUrl: this.#cfg.homeserverUrl,
        accessToken: token,
        ...(this.#deps.fetch !== undefined ? { fetch: this.#deps.fetch } : {}),
      });
      const me = await this.#api.whoami(signal);
      if (me.user_id !== this.#cfg.userId) throw new Error("matrix account does not match the configured userId");
      if (this.#cfg.deviceId !== undefined && me.device_id !== this.#cfg.deviceId)
        throw new Error("matrix device does not match the configured deviceId");
      this.#botName = await this.#displayName(me.user_id, signal);
      try {
        this.#since = await this.#deps.syncStore.load();
      } catch {
        // Fail closed: replaying or skipping history after a bad token file is worse than refusing to start.
        throw new Error("matrix sync state is unusable; refusing to start");
      }
      this.#inactive.clear();
      this.#rooms.clear();
      if (this.#since === undefined) await this.#initialSync(signal);
      this.#healthy = true;
      this.#log("info", "channel.matrix.started", { resumed: this.#since !== undefined });
      this.#loop = this.#syncLoop(signal);
    } catch (e) {
      ac.abort();
      this.#healthy = false;
      this.#ac = undefined;
      this.#api = undefined;
      this.#host = undefined;
      this.#token = undefined;
      if (e instanceof MatrixApiError && e.kind === "unauthorized") this.#log("error", "channel.matrix.auth-failed", {});
      throw e instanceof MatrixApiError || e instanceof Error ? e : new Error("matrix start failed");
    }
  }

  async #displayName(userId: string, signal: AbortSignal): Promise<string | undefined> {
    try {
      return await this.#api!.displayName(userId, signal);
    } catch (e) {
      if (e instanceof MatrixApiError && (e.kind === "unauthorized" || e.kind === "aborted")) throw e;
      return undefined;
    }
  }

  /** First sync: establishes the token and processes invites and account data, but discards timeline history. */
  async #initialSync(signal: AbortSignal): Promise<void> {
    const res = await this.#api!.sync({ timeoutMs: 0, filter: SYNC_FILTER }, signal);
    await this.#process(res, true, signal);
    await this.#saveToken(res.next_batch, signal);
    this.#since = res.next_batch;
  }

  async stop(): Promise<void> {
    this.#healthy = false;
    this.#ac?.abort();
    await this.#starting?.catch(() => {});
    await this.#loop;
    await this.#updates;
    this.#approvals.clear();
    this.#loop = undefined;
    this.#ac = undefined;
    this.#api = undefined;
    this.#host = undefined;
    this.#token = undefined;
    this.#log("info", "channel.matrix.stopped", {});
  }

  async health(): Promise<ChannelHealth> {
    return { ok: this.#healthy };
  }

  /** Framework path: text only, split and converted; rich turns go through `sendTurn`. */
  async send(msg: OutboundMessage): Promise<void> {
    await this.sendTurn({ chatId: msg.chatId, text: msg.text, ...(msg.replyTo !== undefined ? { replyTo: msg.replyTo } : {}) });
  }

  async sendOutput(chatId: string, outputId: string, index = 0): Promise<SentRef[]> {
    this.#target(chatId);
    if (!this.#deps.outputs) throw new Error("media output store unavailable");
    const attachment = await outputAttachment(this.#deps.outputs, outputId, chatId, index);
    return this.sendTurn({ chatId, text: "", attachments: [attachment] });
  }

  async sendTurn(turn: OutboundTurn): Promise<SentRef[]> {
    if (!this.#api || !this.#ac) throw new Error("matrix channel is not started");
    const target = this.#target(turn.chatId);
    if (turn.threadId !== undefined && target.thread !== undefined && turn.threadId !== target.thread)
      throw new Error("conflicting thread ids");
    const thread = turn.threadId ?? target.thread;
    const signal = this.#ac.signal;
    const refs: SentRef[] = [];
    if (turn.text.trim()) {
      for (const chunk of splitMessage(turn.text)) {
        const { body, formattedBody } = toMatrixText(chunk);
        const id = await this.#sendEvent(
          target.roomId,
          {
            msgtype: turn.notice ? "m.notice" : "m.text",
            body: neutral(body),
            ...(formattedBody ? { format: "org.matrix.custom.html", formatted_body: neutral(formattedBody) } : {}),
            "m.mentions": {},
            ...this.#relation(thread, turn.replyTo),
          },
          signal,
        );
        refs.push({ chatId: turn.chatId, messageId: id });
      }
    }
    for (const a of turn.attachments ?? []) {
      if (a.data.byteLength > this.#cfg.maxMediaBytes) throw new Error("outbound media exceeds size limit");
      checkMime(a.kind, a.mimeType);
      const filename = sanitizeName(a.filename ?? `attachment.${a.kind}`);
      const mxc = await this.#request(target.roomId, signal, () =>
        this.#api!.uploadMedia(a.data, a.mimeType, filename, signal),
      );
      const id = await this.#sendEvent(
        target.roomId,
        {
          msgtype: OUT_MSGTYPE[a.kind],
          body: filename,
          filename,
          url: mxc,
          info: { mimetype: a.mimeType, size: a.data.byteLength },
          "m.mentions": {},
          ...this.#relation(thread, turn.replyTo),
        },
        signal,
      );
      refs.push({ chatId: turn.chatId, messageId: id });
    }
    return refs;
  }

  /** Streaming edit (`m.replace`). The new text must fit one event. Only the bot's own events can be edited. */
  async edit(ref: SentRef, text: string): Promise<void> {
    if (!this.#api || !this.#ac) throw new Error("matrix channel is not started");
    const target = this.#target(ref.chatId);
    if (!isEventId(ref.messageId)) throw new RangeError("invalid message reference");
    if (new TextEncoder().encode(text).length > MATRIX_MAX_BODY_BYTES) throw new RangeError("edit text exceeds one event");
    const { body, formattedBody } = toMatrixText(text);
    const html = formattedBody ? { format: "org.matrix.custom.html", formatted_body: neutral(formattedBody) } : {};
    await this.#sendEvent(
      target.roomId,
      {
        msgtype: "m.text",
        body: neutral(`* ${body}`),
        ...(formattedBody ? { format: "org.matrix.custom.html", formatted_body: `* ${neutral(formattedBody)}` } : {}),
        "m.new_content": { msgtype: "m.text", body: neutral(body), ...html },
        "m.relates_to": { rel_type: "m.replace", event_id: ref.messageId },
        "m.mentions": {},
      },
      this.#ac.signal,
    );
  }

  async typing(chatId: string): Promise<void> {
    if (!this.#api || !this.#ac) throw new Error("matrix channel is not started");
    const target = this.#target(chatId);
    const api = this.#api;
    const signal = this.#ac.signal;
    await this.#request(target.roomId, signal, () =>
      api.setTyping(target.roomId, this.#cfg.userId, true, TYPING_MS, signal),
    );
  }

  /** Reaction-based approval (D109). The bot pre-seeds one reaction per choice; only `approverIds` can activate it. */
  async prompt(req: ApprovalPrompt): Promise<{ promptId: string; refs: SentRef[] }> {
    if (!this.#api || !this.#ac) throw new Error("matrix channel is not started");
    validatePrompt(req.choices, req.approverIds, req.ttlMs);
    if (this.#approvals.size >= MAX_PENDING_APPROVALS) throw new Error("too many pending approvals");
    const target = this.#target(req.chatId);
    const thread = req.threadId ?? target.thread;
    const chatId = formatChatId(target.roomId, thread);
    const signal = this.#ac.signal;
    const lines = req.choices.map((c, i) => `- ${choiceEmoji(i, c.id)} ${c.label}`).join("\n");
    const { body, formattedBody } = toMatrixText(`${req.text}\n\n${lines}\n\n${t(this.#cfg.locale, "approvalHint")}`);
    const eventId = await this.#sendEvent(
      target.roomId,
      {
        msgtype: "m.text",
        body: neutral(body),
        ...(formattedBody ? { format: "org.matrix.custom.html", formatted_body: neutral(formattedBody) } : {}),
        "m.mentions": {},
        ...this.#relation(thread, undefined),
      },
      signal,
    );
    const reg = this.#approvals.register({
      chatId,
      roomId: target.roomId,
      eventId,
      choices: req.choices,
      approverIds: req.approverIds,
      ...(req.ttlMs !== undefined ? { ttlMs: req.ttlMs } : {}),
    });
    try {
      for (const r of reg.reactions) {
        await this.#sendEvent(
          target.roomId,
          { "m.relates_to": { rel_type: "m.annotation", event_id: eventId, key: r.emoji } },
          signal,
          "m.reaction",
        );
      }
    } catch (e) {
      this.#approvals.cancel(eventId);
      throw e;
    }
    return { promptId: reg.promptId, refs: [{ chatId, messageId: eventId }] };
  }

  // ------------------------------------------------------------------ sync loop

  async #syncLoop(signal: AbortSignal): Promise<void> {
    let backoff = 0;
    while (!signal.aborted) {
      try {
        const res = await this.#api!.sync(
          { ...(this.#since !== undefined ? { since: this.#since } : {}), timeoutMs: this.#deps.syncTimeoutMs ?? LONG_POLL_MS, filter: SYNC_FILTER },
          signal,
        );
        backoff = 0;
        await this.#process(res, false, signal);
        await this.#saveToken(res.next_batch, signal);
        this.#since = res.next_batch;
      } catch (e) {
        if (signal.aborted) break;
        const err = e instanceof MatrixApiError ? e : new MatrixApiError("protocol", "unexpected sync failure");
        if (err.kind === "unauthorized") {
          this.#healthy = false;
          this.#log("error", "channel.matrix.auth-failed", {});
          this.#host?.fail(new Error("matrix authentication failed"));
          return;
        }
        backoff = Math.min(60_000, backoff === 0 ? 1000 : backoff * 2);
        const wait =
          err.kind === "rate-limited"
            ? (err.retryAfterMs ?? 1000)
            : Math.round(backoff * (0.75 + this.#random() * 0.5));
        this.#log("warn", "channel.matrix.sync-failed", { kind: err.kind, waitMs: wait, ...(err.status !== undefined ? { status: err.status } : {}) });
        await this.#sleep(wait, signal);
      }
    }
  }

  async #saveToken(token: string, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.#deps.syncStore.save(token);
        return;
      } catch {
        this.#log("error", "channel.matrix.sync-save-failed", {});
        await this.#sleep(1000, signal);
      }
    }
    throw new Error("matrix sync persistence interrupted");
  }

  async #process(res: SyncResponse, initial: boolean, signal: AbortSignal): Promise<void> {
    this.#updateDirect(res.account_data?.events ?? []);
    for (const [roomId, inv] of Object.entries(res.rooms?.invite ?? {}))
      await this.#guard(signal, () => this.#invite(roomId, inv.invite_state?.events ?? [], signal));
    for (const [roomId, room] of Object.entries(res.rooms?.join ?? {}))
      await this.#guard(signal, () => this.#room(roomId, room, initial, signal));
  }

  /** Runs one unit of work; errors are logged content-free, except an auth failure which must reach the loop. */
  async #guard(signal: AbortSignal, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      if (e instanceof MatrixApiError && e.kind === "unauthorized") throw e;
      if (signal.aborted) return;
      this.#log("error", "channel.matrix.event-failed", { kind: e instanceof MatrixApiError ? e.kind : "error" });
    }
  }

  #updateDirect(events: MatrixEvent[]): void {
    const direct = events.find((e) => e.type === "m.direct");
    if (!direct || !isObj(direct.content)) return;
    const rooms = new Set<string>();
    for (const [mxid, list] of Object.entries(direct.content)) {
      if (!this.#cfg.dmAllow.has(mxid) || !Array.isArray(list)) continue;
      for (const r of list) if (typeof r === "string") rooms.add(r);
    }
    this.#mDirectRooms = rooms;
  }

  async #invite(roomId: string, events: MatrixEvent[], signal: AbortSignal): Promise<void> {
    if (!isRoomId(roomId) || this.#handledInvites.has(roomId)) return;
    const member = events.find(
      (e) => e.type === "m.room.member" && e.state_key === this.#cfg.userId && isObj(e.content) && e.content.membership === "invite",
    );
    const inviter = isUserId(member?.sender) ? member.sender : undefined;
    const isDirect = member !== undefined && isObj(member.content) && member.content.is_direct === true;
    if (this.#cfg.autoJoin === "never") {
      this.#log("info", "channel.matrix.invite-pending", { roomId });
      return;
    }
    const accept = this.#cfg.allow.has(roomId) || (inviter !== undefined && this.#cfg.dmAllow.has(inviter));
    if (!accept) {
      await this.#api!.leaveRoom(roomId, signal);
      this.#handledInvites.add(roomId);
      this.#log("info", "channel.matrix.invite-declined", { roomId });
      return;
    }
    await this.#api!.joinRoom(roomId, signal);
    this.#handledInvites.add(roomId);
    if (isDirect && inviter !== undefined && this.#cfg.dmAllow.has(inviter)) this.#inviteDirectRooms.add(roomId);
    this.#log("info", "channel.matrix.invite-accepted", { roomId });
  }

  async #room(roomId: string, room: { timeline?: { events?: MatrixEvent[] }; state?: { events?: MatrixEvent[] }; summary?: { "m.joined_member_count"?: number } }, initial: boolean, signal: AbortSignal): Promise<void> {
    if (!isRoomId(roomId)) return;
    const state = room.state?.events ?? [];
    const timeline = room.timeline?.events ?? [];
    const encryptedNow = state.some((e) => e.type === "m.room.encryption") || timeline.some((e) => e.type === "m.room.encrypted");
    if (encryptedNow) this.#encrypted.add(roomId);
    if (this.#encrypted.has(roomId)) {
      if (!initial && timeline.length > 0) await this.#refuseEncrypted(roomId, signal);
      return;
    }
    if (initial) {
      for (const e of timeline) if (isEventId(e.event_id)) this.#seen.add(e.event_id);
      return;
    }
    for (const ev of timeline) await this.#guard(signal, () => this.#event(roomId, ev, signal));
  }

  /** One plain notice per encrypted room, only where the bot may speak; then the room is ignored. */
  async #refuseEncrypted(roomId: string, signal: AbortSignal): Promise<void> {
    if (this.#noticed.has(roomId)) return;
    this.#noticed.add(roomId);
    this.#log("warn", "channel.matrix.room-encrypted", { roomId });
    if (!this.#mayTalk(roomId)) return;
    try {
      await this.#sendEvent(roomId, { msgtype: "m.notice", body: t(this.#cfg.locale, "encryptedRoom"), "m.mentions": {} }, signal);
    } catch (e) {
      if (e instanceof MatrixApiError && e.kind === "unauthorized") throw e;
      this.#log("warn", "channel.matrix.notice-failed", {});
    }
  }

  async #event(roomId: string, ev: MatrixEvent, signal: AbortSignal): Promise<void> {
    if (!isEventId(ev.event_id) || !isUserId(ev.sender)) return;
    if (this.#seen.has(ev.event_id)) return;
    this.#seen.add(ev.event_id);
    if (ev.sender === this.#cfg.userId) return; // own events: loop prevention
    if (ev.type === "m.reaction") return this.#reaction(roomId, ev, signal);
    if (ev.type === "m.room.message") return this.#message(roomId, ev, signal);
  }

  async #reaction(roomId: string, ev: MatrixEvent, signal: AbortSignal): Promise<void> {
    const rel = relates(ev.content);
    if (!rel || rel.rel_type !== "m.annotation" || !isEventId(rel.event_id) || typeof rel.key !== "string") return;
    const sender = ev.sender!;
    const r = this.#approvals.claim({ roomId, eventId: rel.event_id, key: rel.key, sender });
    if (r.status === "ignored") return;
    if (r.status === "unauthorized") {
      this.#log("warn", "channel.matrix.approval-refused", { reason: "unauthorized", roomId });
      await this.#redact(roomId, ev.event_id!, signal).catch(() => {});
      return;
    }
    if (r.status === "expired" || r.status === "replayed") {
      this.#log("warn", "channel.matrix.approval-refused", { reason: r.status, roomId });
      if (this.#mayTalk(roomId))
        await this.#sendEvent(roomId, { msgtype: "m.notice", body: t(this.#cfg.locale, "approvalGone"), "m.mentions": {} }, signal).catch(() => {});
      return;
    }
    const decision: ApprovalDecision = { promptId: r.promptId, chatId: r.chatId, senderId: sender, choiceId: r.choiceId, at: this.#now() };
    this.#log("info", "channel.matrix.approval-decided", { roomId });
    for (const h of [...this.#decisionHandlers]) {
      try {
        await h(decision);
      } catch {
        this.#log("error", "channel.matrix.decision-handler-failed", {});
      }
    }
  }

  async #message(roomId: string, ev: MatrixEvent, signal: AbortSignal): Promise<void> {
    const content = ev.content;
    if (relates(content)?.rel_type === "m.replace") return; // edits are not re-dispatched
    const msgtype = content.msgtype;
    if (typeof msgtype !== "string" || !(MESSAGE_TYPES as readonly string[]).includes(msgtype)) return;
    const senderId = ev.sender!;
    const direct = this.#isDirect(roomId);
    if (direct) {
      // The room allowlist does not grant DM access: only the sender's own allowlist entry does.
      if (!this.#cfg.dmAllow.has(senderId)) return this.#drop(roomId, "dm-not-allowed");
    } else {
      if (!this.#cfg.allow.has(roomId)) return this.#drop(roomId, "room-not-allowed");
      if (this.#cfg.users && !this.#cfg.users.has(senderId)) return this.#drop(roomId, "sender-not-allowed");
    }
    const thread = threadRoot(content);
    const replyTo = replyTarget(content);
    const rawBody = typeof content.body === "string" ? content.body : "";
    const isMedia = msgtype in MSGTYPE_OF;
    const isCaptioned = isMedia && typeof content.filename === "string" && content.filename !== rawBody;
    const body = isMedia ? (isCaptioned ? rawBody : "") : stripReplyFallback(rawBody, content);
    const mentioned = mentionsBot(content, body, { userId: this.#cfg.userId, displayName: this.#botName });
    const addressed = direct || mentioned || (replyTo !== undefined && this.#sentIds.has(replyTo));
    if (!direct) {
      const pass =
        this.#cfg.replyPolicy === "always" ||
        (this.#cfg.replyPolicy === "allowlist" && this.#cfg.users?.has(senderId) === true) ||
        addressed;
      if (!pass) return this.#drop(roomId, "not-addressed");
    }
    const chatId = formatChatId(roomId, thread);
    const link = !isMedia ? LINK_COMMAND.exec(body.trim()) : null;
    if (link) {
      // The code is never forwarded to the host or logged. Groups get no reply, so the command cannot be probed there.
      if (direct) await this.#link(roomId, senderId, link[1] ?? "", signal);
      return;
    }
    let attachments: Attachment[] = [];
    if (isMedia) {
      try {
        attachments = [await this.#inboundMedia(content, msgtype, signal)];
      } catch (e) {
        if (e instanceof MatrixApiError && e.kind === "unauthorized") throw e;
        this.#log("warn", "channel.matrix.media-rejected", { roomId });
        return;
      }
    }
    const text = isMedia ? (isCaptioned ? rawBody : "") : body;
    if (!text && attachments.length === 0) return;
    const message: RichInbound = {
      channel: this.name,
      chatId,
      chatKind: direct ? "direct" : "group",
      senderId,
      text,
      messageId: ev.event_id!,
      roomId,
      addressed,
      msgtype,
      ...(thread !== undefined ? { threadId: thread } : {}),
      ...(replyTo !== undefined ? { replyToMessageId: replyTo } : {}),
      ...(typeof ev.origin_server_ts === "number" ? { sentAt: ev.origin_server_ts } : {}),
      ...(attachments.length ? { attachments } : {}),
    };
    await this.#emit(message);
  }

  async #emit(message: RichInbound): Promise<void> {
    for (const h of [...this.#handlers]) {
      try {
        await h(message);
      } catch {
        this.#log("error", "channel.matrix.handler-failed", {});
      }
    }
    if (this.#host) {
      // Framework v1 is text-only: attachments are available through onMessage, never silently claimed as core support.
      if (!message.text || message.attachments?.length) {
        this.#log("warn", "channel.matrix.framework-rich-turn-gap", {});
        return;
      }
      try {
        await this.#host.receive({
          channel: message.channel,
          chatId: message.chatId,
          chatKind: message.chatKind,
          senderId: message.senderId,
          text: message.text,
          ...(message.messageId !== undefined ? { messageId: message.messageId } : {}),
        });
      } catch {
        this.#log("error", "channel.matrix.host-failed", {});
      }
    }
  }

  async #link(roomId: string, senderId: string, code: string, signal: AbortSignal): Promise<void> {
    let reply = t(this.#cfg.locale, "linkFailed");
    if (this.#deps.pairing) {
      try {
        await this.#deps.pairing.claim({ code, identity: { channel: this.name, accountId: this.#cfg.userId, userId: senderId } });
        reply = t(this.#cfg.locale, "linkClaimed");
      } catch {
        /* Uniform reply. The identity port owns durable rate limits. The submitted code is never logged. */
      }
    }
    try {
      await this.#sendEvent(roomId, { msgtype: "m.notice", body: reply, "m.mentions": {} }, signal);
    } catch (e) {
      if (e instanceof MatrixApiError && e.kind === "unauthorized") throw e;
      this.#log("warn", "channel.matrix.command-send-failed", {});
    }
  }

  async #inboundMedia(content: Record<string, unknown>, msgtype: string, signal: AbortSignal): Promise<Attachment> {
    const kind = MSGTYPE_OF[msgtype]!;
    if (content.file !== undefined) throw new Error("encrypted media is not supported");
    const info = isObj(content.info) ? content.info : {};
    const max = this.#cfg.maxMediaBytes;
    if (info.size !== undefined && (typeof info.size !== "number" || info.size < 0 || info.size > max))
      throw new Error("media size limit");
    const declared = typeof info.mimetype === "string" ? info.mimetype.split(";")[0]!.trim().toLowerCase() : "application/octet-stream";
    checkMime(kind, declared);
    if (!parseMxc(content.url)) throw new Error("unsafe media reference");
    const dl = await this.#api!.downloadMedia(content.url as string, max, signal);
    if (dl.mimeType !== "application/octet-stream") {
      checkMime(kind, dl.mimeType);
      if (dl.mimeType !== declared) throw new Error("media MIME mismatch");
    }
    if (dl.data.length > max) throw new Error("media size limit");
    const name = typeof content.filename === "string" ? content.filename : typeof content.body === "string" ? content.body : undefined;
    return { kind, data: dl.data, mimeType: declared, ...(name ? { filename: sanitizeName(name) } : {}) };
  }

  async #redact(roomId: string, eventId: string, signal: AbortSignal): Promise<void> {
    const txn = randomBytes(12).toString("base64url");
    await this.#request(roomId, signal, () => this.#api!.redactEvent(roomId, eventId, txn, signal));
  }

  // ------------------------------------------------------------------ helpers

  /** A DM is a room that m.direct ties to an allowlisted peer, or one joined from such a peer's direct invite. Member counts never decide it. */
  #isDirect(roomId: string): boolean {
    return this.#mDirectRooms.has(roomId) || this.#inviteDirectRooms.has(roomId);
  }

  /** Whether the bot may speak in a room: allowlisted, or a DM room with an allowlisted peer. */
  #mayTalk(roomId: string): boolean {
    return this.#cfg.allow.has(roomId) || this.#isDirect(roomId);
  }

  #target(chatId: string): { roomId: string; thread?: string } {
    const p = parseChatId(chatId);
    if (!this.#mayTalk(p.roomId)) throw new Error("chat is not on the matrix allowlist");
    if (this.#inactive.has(p.roomId)) throw new Error("matrix room is inactive");
    return p;
  }

  #relation(thread: string | undefined, replyTo: string | undefined): Record<string, unknown> {
    if (replyTo !== undefined && !isEventId(replyTo)) throw new RangeError("invalid replyTo");
    if (thread !== undefined) {
      return {
        "m.relates_to": {
          rel_type: "m.thread",
          event_id: thread,
          is_falling_back: replyTo === undefined,
          "m.in_reply_to": { event_id: replyTo ?? thread },
        },
      };
    }
    return replyTo !== undefined ? { "m.relates_to": { "m.in_reply_to": { event_id: replyTo } } } : {};
  }

  #drop(roomId: string, reason: string): void {
    this.#log("info", "channel.matrix.dropped", { reason, roomId });
  }

  async #sendEvent(
    roomId: string,
    content: Record<string, unknown>,
    signal: AbortSignal,
    type = "m.room.message",
  ): Promise<string> {
    // One transaction id per logical send: a retried PUT is de-duplicated by the homeserver.
    const txn = randomBytes(12).toString("base64url");
    const id = await this.#request(roomId, signal, () => this.#api!.sendEvent(roomId, type, content, txn, signal));
    if (type === "m.room.message") this.#sentIds.add(id);
    return id;
  }

  async #request<T>(roomId: string, signal: AbortSignal, call: () => Promise<T>): Promise<T> {
    let bucket = this.#rooms.get(roomId);
    if (!bucket) {
      bucket = new TokenBucket(1, 1000, this.#now, this.#sleep);
      this.#rooms.set(roomId, bucket);
    }
    const limit = bucket;
    return this.#retry(signal, async () => {
      await limit.take(signal);
      await this.#global.take(signal);
      if (this.#inactive.has(roomId)) throw new Error("matrix room is inactive");
      try {
        return await call();
      } catch (e) {
        if (e instanceof MatrixApiError && e.kind === "forbidden") this.#inactive.add(roomId);
        throw e;
      }
    });
  }

  async #retry<T>(signal: AbortSignal, call: () => Promise<T>): Promise<T> {
    const max = this.#deps.maxSendRetries ?? 3;
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      try {
        return await call();
      } catch (e) {
        const retryable =
          e instanceof MatrixApiError &&
          (e.kind === "rate-limited" || e.kind === "network" || e.kind === "timeout" || (e.kind === "http" && (e.status ?? 0) >= 500));
        if (!retryable || attempt >= max || signal.aborted) throw e;
        const err = e as MatrixApiError;
        const wait =
          err.kind === "rate-limited"
            ? (err.retryAfterMs ?? 1000)
            : Math.round(Math.min(60_000, 1000 * 2 ** attempt) * (0.75 + this.#random() * 0.5));
        this.#log("warn", "channel.matrix.request-retry", { kind: err.kind, waitMs: wait, attempt });
        await this.#sleep(wait, signal);
      }
    }
  }

  #log(level: LogLevel, event: string, attrs: Record<string, string | number | boolean>): void {
    const safe = redactAttrs(attrs, this.#token);
    this.#deps.logger?.log(level, event, safe);
    if (level !== "debug") this.#host?.log[level](event, safe);
  }
}
