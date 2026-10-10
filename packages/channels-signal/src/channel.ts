import { createConnection } from "node:net";
import type { Duplex } from "node:stream";
import type { IdentityService } from "../../core/src/identity/service.ts";
import type { Channel, ChannelHealth, ChannelHost, ChannelLogger as HostLogger, OutboundMessage } from "../../core/src/channels/types.ts";
import {
  UnsupportedError,
  type ApprovalChoice,
  type ApprovalDecision,
  type ApprovalPrompt,
  type Attachment,
  type ChannelCapabilities,
  type ChannelLogger,
  type InboundHandler,
  type LogLevel,
  type OutboundTurn,
  type RichInbound,
  type SentRef,
  type SignalConfig,
  type SignalEndpoint,
} from "./port.ts";
import { ApprovalBook } from "./approvals.ts";
import { formatTextStyles, toSignalText, type StyledText } from "./markdown.ts";
import { JsonRpcClient, SignalRpcError, defaultTimeout, type TimeoutFn } from "./rpc.ts";
import { redactAttrs } from "./redact.ts";
import { TokenBucket } from "./rate-limit.ts";
import { messages, type Locale } from "./messages.ts";
import { outputAttachment, type OutputPort } from "./outputs.ts";
import { splitStyled, SIGNAL_MAX_TEXT } from "./split.ts";

export interface SignalDeps {
  /** Host-supplied private pairing port; the sender identity comes from the daemon envelope, never from command text. */
  pairing?: Pick<IdentityService, "claim">;
  outputs?: OutputPort;
  logger?: ChannelLogger;
  /** Test seam / host seam. Default: node:net socket or loopback TCP. The channel never spawns signal-cli. */
  connect?: (endpoint: SignalEndpoint, signal: AbortSignal) => Promise<Duplex>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  random?: () => number;
  timeout?: TimeoutFn;
  rpcTimeoutMs?: number;
  maxSendRetries?: number;
}

export type SignalChannelOptions = SignalConfig & SignalDeps;

const E164 = /^\+\d{7,15}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const DEFAULT_MAX_MEDIA = 10 * 1024 * 1024;
const HARD_MAX_MEDIA = 25 * 1024 * 1024;
/** Base64 payload of a 25 MiB attachment plus JSON framing. */
const MAX_LINE_BYTES = 40 * 1024 * 1024;
const DEDUPE_MAX = 2048;
const QUOTE_MAX = 512;
const SAFE_MIME =
  /^(image\/(jpeg|png|webp|gif)|audio\/(ogg|mpeg|mp4|aac|wav|x-wav|flac)|video\/(mp4|webm)|application\/(pdf|octet-stream)|text\/plain)$/;
const CAPABILITIES: ChannelCapabilities = {
  threads: false,
  edit: true,
  typing: true,
  attachmentsIn: true,
  attachmentsOut: true,
  reactions: false,
  buttons: false,
  approvalMode: "reply-code",
  markdown: "converted",
  maxMessageChars: SIGNAL_MAX_TEXT,
};

interface WireMention {
  name?: string;
  number?: string;
  uuid?: string;
  start?: number;
  length?: number;
}
interface WireAttachment {
  id?: string;
  contentType?: string;
  filename?: string;
  size?: number;
}
interface WireDataMessage {
  timestamp?: number;
  message?: string;
  expiresInSeconds?: number;
  viewOnce?: boolean;
  groupInfo?: { groupId?: string };
  mentions?: WireMention[];
  quote?: { id?: number; author?: string; authorNumber?: string; authorUuid?: string };
  attachments?: WireAttachment[];
  reaction?: {
    emoji?: string;
    targetAuthor?: string;
    targetAuthorNumber?: string;
    targetAuthorUuid?: string;
    targetSentTimestamp?: number;
    isRemove?: boolean;
  };
}
interface WireEnvelope {
  source?: string;
  sourceNumber?: string;
  sourceUuid?: string;
  timestamp?: number;
  dataMessage?: WireDataMessage;
  syncMessage?: unknown;
  receiptMessage?: unknown;
  typingMessage?: unknown;
}

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

/** Default transport: a unix socket path, or TCP to a host:port. Only connects; signal-cli must already run as a daemon. */
export function defaultConnect(endpoint: SignalEndpoint, signal: AbortSignal): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const s =
      "socketPath" in endpoint
        ? createConnection({ path: endpoint.socketPath })
        : createConnection({ host: endpoint.host, port: endpoint.port });
    const onAbort = () => {
      s.destroy();
      reject(new SignalRpcError("not-connected", "signal connect aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    s.once("connect", () => {
      signal.removeEventListener("abort", onAbort);
      s.removeAllListeners("error");
      resolve(s);
    });
    s.once("error", () => {
      signal.removeEventListener("abort", onAbort);
      reject(new SignalRpcError("not-connected", "signal daemon is not reachable"));
    });
  });
}

function validate(o: SignalChannelOptions): void {
  if (typeof o.account !== "string" || !E164.test(o.account)) throw new RangeError("account must be an E.164 number");
  const e = o.endpoint as Partial<{ socketPath: unknown; host: unknown; port: unknown }> | undefined;
  if (!e || typeof e !== "object") throw new RangeError("endpoint is required");
  if ("socketPath" in e && e.socketPath !== undefined) {
    if (typeof e.socketPath !== "string" || !e.socketPath.startsWith("/") || e.socketPath.includes("\u0000"))
      throw new RangeError("socketPath must be an absolute path");
  } else {
    if (typeof e.host !== "string" || !e.host) throw new RangeError("endpoint host is required");
    if (!Number.isInteger(e.port) || (e.port as number) < 1 || (e.port as number) > 65535)
      throw new RangeError("endpoint port must be 1..65535");
    if (!LOOPBACK.has(e.host) && o.allowRemoteEndpoint !== true)
      throw new RangeError("non-loopback signal endpoint requires allowRemoteEndpoint: true (JSON-RPC is plaintext)");
  }
  for (const list of [o.allowlist, o.dmAllowlist, o.userAllowlist ?? []])
    if (!Array.isArray(list) || list.some((s) => typeof s !== "string" || !s || s.length > 256 || /[\u0000-\u001f]/.test(s)))
      throw new RangeError("allowlists must contain non-empty id strings");
  const max = o.maxMediaBytes ?? DEFAULT_MAX_MEDIA;
  if (!Number.isSafeInteger(max) || max < 1 || max > HARD_MAX_MEDIA) throw new RangeError("maxMediaBytes must be 1..25 MiB");
  if (o.replyPolicy !== undefined && !["mention", "always", "allowlist"].includes(o.replyPolicy))
    throw new RangeError("invalid replyPolicy");
  if (o.locale !== undefined && o.locale !== "en" && o.locale !== "de") throw new RangeError("invalid locale");
}

function isDmId(id: string): boolean {
  return E164.test(id) || UUID.test(id);
}
function pick(...v: Array<string | undefined>): string | undefined {
  return v.find((x) => typeof x === "string" && x.length > 0);
}
function kindOf(mime: string): Attachment["kind"] {
  if (mime.startsWith("image/")) return "photo";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "document";
}
function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
}

/**
 * Signal channel over signal-cli's JSON-RPC daemon. Chat ids: group id for groups, sender id (E.164, or the ACI uuid when
 * no number is known) for direct messages. `accountId` for pairing is the configured `account`.
 */
export class SignalChannel implements Channel {
  readonly name = "signal";
  readonly capabilities: ChannelCapabilities = CAPABILITIES;
  readonly #o: SignalChannelOptions;
  readonly #locale: Locale;
  readonly #max: number;
  readonly #allow: ReadonlySet<string>;
  readonly #dm: ReadonlySet<string>;
  readonly #users: ReadonlySet<string> | undefined;
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly #timeout: TimeoutFn;
  readonly #random: () => number;
  readonly #connect: (endpoint: SignalEndpoint, signal: AbortSignal) => Promise<Duplex>;
  readonly #handlers = new Set<InboundHandler>();
  readonly #decisionHandlers = new Set<(d: ApprovalDecision) => void | Promise<void>>();
  readonly #approvals: ApprovalBook;
  readonly #chats = new Map<string, TokenBucket>();
  readonly #seen = new Set<string>();
  readonly #quotes = new Map<string, string>(); // message timestamp -> author id, for quote-replies
  readonly #now: () => number;
  #host: ChannelHost | undefined;
  #client: JsonRpcClient | undefined;
  #ac: AbortController | undefined;
  #starting: Promise<void> | undefined;
  #loop: Promise<void> | undefined;
  #queue: Promise<void> = Promise.resolve();
  #healthy = false;
  #accountUuid: string | undefined;

  constructor(opts: SignalChannelOptions) {
    validate(opts);
    this.#o = opts;
    this.#locale = opts.locale ?? "en";
    this.#max = opts.maxMediaBytes ?? DEFAULT_MAX_MEDIA;
    this.#allow = new Set(opts.allowlist);
    this.#dm = new Set(opts.dmAllowlist);
    this.#users = opts.userAllowlist ? new Set(opts.userAllowlist) : undefined;
    this.#sleep = opts.sleep ?? defaultSleep;
    this.#timeout = opts.timeout ?? defaultTimeout;
    this.#random = opts.random ?? Math.random;
    this.#connect = opts.connect ?? defaultConnect;
    this.#now = opts.now ?? Date.now;
    this.#approvals = new ApprovalBook(this.#now);
  }

  // ---- lifecycle -------------------------------------------------------------------------------------------------

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
    this.#host = host;
    try {
      await this.#connectOnce(ac.signal);
    } catch (e) {
      ac.abort();
      this.#client?.close();
      this.#client = undefined;
      this.#ac = undefined;
      this.#host = undefined;
      this.#healthy = false;
      const kind = e instanceof SignalRpcError ? e.kind : "unknown";
      this.#log("error", "channel.signal.start-failed", { reason: kind });
      if (kind === "not-registered") throw new Error("signal account is not registered with the daemon");
      throw new Error("signal daemon start failed");
    }
    this.#loop = this.#supervise(ac.signal);
    this.#log("info", "channel.signal.started", { allowed: this.#allow.size + this.#dm.size });
  }

  /** Connect, check the daemon with `version`, learn the account's uuid, and subscribe. Sets #client on success. */
  async #connectOnce(signal: AbortSignal): Promise<void> {
    const stream = await this.#connect(this.#o.endpoint, signal);
    const client = new JsonRpcClient({
      stream,
      timeoutMs: this.#o.rpcTimeoutMs ?? 10_000,
      timeout: this.#timeout,
      maxLineBytes: MAX_LINE_BYTES,
      onNotification: (method, params) => {
        if (method === "receive") this.#enqueue(params);
      },
    });
    this.#client?.close();
    this.#client = client;
    try {
      await client.call("version", {}, signal);
      const accounts = await client.call<unknown>("listAccounts", {}, signal).catch(() => undefined);
      this.#accountUuid = findAccountUuid(accounts, this.#o.account);
      // Newer daemons may require an explicit subscription; older ones push receive notifications unconditionally.
      await client.call("subscribeReceive", { account: this.#o.account }, signal).catch((e: unknown) => {
        if (!(e instanceof SignalRpcError) || e.kind !== "rpc") throw e;
      });
      this.#healthy = true;
    } catch (e) {
      client.close();
      this.#client = undefined;
      this.#healthy = false;
      throw e;
    }
  }

  async #supervise(signal: AbortSignal): Promise<void> {
    for (;;) {
      const client = this.#client;
      if (!client) return;
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        client.closed.then(resolve);
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      if (signal.aborted) return;
      this.#healthy = false;
      this.#log("warn", "channel.signal.disconnected", {});
      for (let attempt = 0; ; attempt++) {
        const base = Math.min(60_000, 1000 * 2 ** attempt);
        await this.#sleep(Math.round(base * (0.75 + this.#random() * 0.5)), signal);
        if (signal.aborted) return;
        try {
          await this.#connectOnce(signal);
          this.#log("info", "channel.signal.reconnected", { attempt });
          break;
        } catch (e) {
          if (signal.aborted) return;
          const kind = e instanceof SignalRpcError ? e.kind : "unknown";
          this.#log("warn", "channel.signal.reconnect-failed", { reason: kind, attempt });
          if (kind === "not-registered") {
            this.#healthy = false;
            this.#host?.fail(new Error("signal account is not registered with the daemon"));
            return;
          }
        }
      }
    }
  }

  async stop(): Promise<void> {
    this.#healthy = false;
    this.#ac?.abort();
    await this.#starting?.catch(() => {});
    this.#client?.close();
    await this.#loop;
    await this.#queue;
    this.#loop = undefined;
    this.#client = undefined;
    this.#ac = undefined;
    this.#host = undefined;
    this.#approvals.clear();
    this.#chats.clear();
    this.#log("info", "channel.signal.stopped", {});
  }

  async health(): Promise<ChannelHealth> {
    const client = this.#client;
    if (!this.#healthy || !client || !client.isOpen) return { ok: false };
    try {
      await client.call("version", {}, this.#ac?.signal);
      return { ok: true };
    } catch {
      return { ok: false, detail: "daemon version check failed" };
    }
  }

  // ---- ports -----------------------------------------------------------------------------------------------------

  onMessage(handler: InboundHandler): () => void {
    this.#handlers.add(handler);
    return () => void this.#handlers.delete(handler);
  }

  onDecision(handler: (d: ApprovalDecision) => void | Promise<void>): () => void {
    this.#decisionHandlers.add(handler);
    return () => void this.#decisionHandlers.delete(handler);
  }

  /** Framework path: text only, converted and split. */
  async send(msg: OutboundMessage): Promise<void> {
    await this.sendTurn({ chatId: msg.chatId, text: msg.text, ...(msg.replyTo !== undefined ? { replyTo: msg.replyTo } : {}) });
  }

  async sendTurn(turn: OutboundTurn): Promise<SentRef[]> {
    const { client, signal } = this.#requireStarted();
    if (turn.buttons?.length) throw new UnsupportedError("buttons");
    const target = this.#target(turn.chatId);
    const quote = turn.replyTo !== undefined ? this.#quoteFor(turn.replyTo) : undefined;
    const styled: StyledText = turn.markdown === false ? { text: turn.text, styles: [] } : toSignalText(turn.text);
    const refs: SentRef[] = [];
    const chunks = splitStyled(styled, this.capabilities.maxMessageChars);
    for (const [i, chunk] of chunks.entries()) {
      const params: Record<string, unknown> = {
        account: this.#o.account,
        ...target.params,
        message: chunk.text,
        ...(chunk.styles.length ? { textStyle: formatTextStyles(chunk.styles) } : {}),
        ...(i === 0 && quote ? { quoteTimestamp: Number(quote.ts), quoteAuthor: quote.author } : {}),
      };
      refs.push(await this.#sendParams(client, target.chatId, target.kind, params, signal));
    }
    for (const a of turn.attachments ?? []) {
      this.#checkOutbound(a);
      const name = a.filename ? safeName(a.filename) : `attachment.${a.kind}`;
      const uri = `data:${a.mimeType};filename=${name};base64,${Buffer.from(a.data).toString("base64")}`;
      const params = { account: this.#o.account, ...target.params, message: "", attachments: [uri] };
      refs.push(await this.#sendParams(client, target.chatId, target.kind, params, signal));
    }
    return refs;
  }

  /** Streaming edit of an own message (signal-cli `send` with `editTimestamp`). Must fit one message. */
  async edit(ref: SentRef, text: string): Promise<void> {
    const { client, signal } = this.#requireStarted();
    const target = this.#target(ref.chatId);
    const styled = toSignalText(text);
    if (styled.text.length > this.capabilities.maxMessageChars) throw new RangeError("edited text exceeds one message");
    const ts = Number(ref.messageId);
    if (!Number.isSafeInteger(ts) || ts <= 0) throw new RangeError("invalid message reference");
    await this.#sendParams(
      client,
      ref.chatId,
      target.kind,
      {
        account: this.#o.account,
        ...target.params,
        message: styled.text,
        ...(styled.styles.length ? { textStyle: formatTextStyles(styled.styles) } : {}),
        editTimestamp: ts,
      },
      signal,
    );
  }

  async typing(chatId: string): Promise<void> {
    const { client, signal } = this.#requireStarted();
    const target = this.#target(chatId);
    try {
      await client.call("sendTyping", { account: this.#o.account, ...target.params }, signal);
    } catch {
      this.#log("debug", "channel.signal.typing-failed", {});
    }
  }

  async prompt(req: ApprovalPrompt): Promise<{ promptId: string; refs: SentRef[] }> {
    this.#requireStarted();
    this.#target(req.chatId);
    const created = this.#approvals.create({
      chatId: req.chatId,
      choices: req.choices as readonly ApprovalChoice[],
      approverIds: req.approverIds,
      ...(req.ttlMs !== undefined ? { ttlMs: req.ttlMs } : {}),
    });
    const m = messages(this.#locale);
    const lines = created.codes.map((c) => `${c.code} = ${c.label}`).join("\n");
    const text = `${req.text}\n\n${lines}\n\n${m.promptHint(created.token)}`;
    const refs = await this.sendTurn({ chatId: req.chatId, text, markdown: false });
    return { promptId: created.promptId, refs };
  }

  /** The DM chat id of a person is their number or uuid; refused unless it is a DM id the allowlists let us message. */
  async resolveOwnerTarget(who: { userId: string; accountId?: string }): Promise<string> {
    if (who.accountId !== undefined && who.accountId !== this.#o.account) throw new Error("identity belongs to another signal account");
    if (typeof who.userId !== "string" || !isDmId(who.userId)) throw new Error("not a signal number or uuid");
    return this.#target(who.userId).chatId;
  }

  // ---- outbound helpers ------------------------------------------------------------------------------------------

  async sendOutput(chatId: string, outputId: string, index = 0): Promise<SentRef[]> {
    this.#target(chatId);
    if (!this.#o.outputs) throw new Error("media output store unavailable");
    const attachment = await outputAttachment(this.#o.outputs, outputId, chatId, this.#max, index);
    return this.sendTurn({ chatId, text: "", attachments: [attachment] });
  }

  #requireStarted(): { client: JsonRpcClient; signal: AbortSignal } {
    if (!this.#client || !this.#ac || !this.#healthy) throw new Error("signal channel is not started");
    return { client: this.#client, signal: this.#ac.signal };
  }

  #target(id: string): { chatId: string; kind: "dm" | "group"; params: Record<string, unknown> } {
    if (typeof id !== "string" || !id || id.length > 256 || /[\u0000-\u001f]/.test(id))
      throw new Error("invalid signal conversation id");
    if (isDmId(id)) {
      if (!this.#dm.has(id) && !this.#allow.has(id)) throw new Error("recipient is not on the signal allowlist");
      return { chatId: id, kind: "dm", params: { recipient: [id] } };
    }
    if (!this.#allow.has(id)) throw new Error("group is not on the signal allowlist");
    return { chatId: id, kind: "group", params: { groupId: [id] } };
  }

  #quoteFor(messageId: string): { ts: string; author: string } | undefined {
    const author = this.#quotes.get(messageId);
    return author === undefined ? undefined : { ts: messageId, author };
  }

  #checkOutbound(a: Attachment): void {
    if (!(a.data instanceof Uint8Array) || a.data.byteLength === 0 || a.data.byteLength > this.#max)
      throw new Error("outbound media exceeds size limit");
    if (!SAFE_MIME.test(a.mimeType)) throw new Error("unsupported media MIME type");
  }

  async #sendParams(
    client: JsonRpcClient,
    chatId: string,
    kind: "dm" | "group",
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<SentRef> {
    let bucket = this.#chats.get(chatId);
    if (!bucket) {
      bucket = new TokenBucket(3, 1000, this.#now, this.#sleep);
      this.#chats.set(chatId, bucket);
    }
    for (let attempt = 0; ; attempt++) {
      await bucket.take(signal);
      try {
        const r = await client.call<{ timestamp?: number } | number | undefined>("send", params, signal);
        const ts = typeof r === "number" ? r : r?.timestamp;
        if (!Number.isSafeInteger(ts)) throw new SignalRpcError("protocol", "signal send returned no timestamp");
        return { chatId, messageId: String(ts) };
      } catch (e) {
        // Rate limits are rejected by the daemon before delivery, so retrying is safe. Everything else is not retried.
        if (e instanceof SignalRpcError && e.kind === "rate-limited" && attempt < (this.#o.maxSendRetries ?? 3)) {
          this.#log("warn", "channel.signal.rate-limited", { waitMs: e.retryAfterMs ?? 1000 });
          await this.#sleep(e.retryAfterMs ?? 1000, signal);
          continue;
        }
        throw e;
      }
    }
  }

  // ---- inbound ---------------------------------------------------------------------------------------------------

  #enqueue(params: unknown): void {
    this.#queue = this.#queue
      .then(() => this.#receive(params))
      .catch(() => {
        this.#log("error", "channel.signal.receive-failed", {});
      });
  }

  /** Resolves when every notification received so far has been processed. Used by the contract harness. */
  whenIdle(): Promise<void> {
    return this.#queue;
  }

  #isBot(number: string | undefined, uuid: string | undefined): boolean {
    return (number !== undefined && number === this.#o.account) || (uuid !== undefined && uuid === this.#accountUuid);
  }

  #remember(map: Map<string, string>, key: string, value: string): void {
    map.set(key, value);
    if (map.size > QUOTE_MAX) map.delete(map.keys().next().value!);
  }

  async #receive(params: unknown): Promise<void> {
    const p = params && typeof params === "object" ? (params as { envelope?: WireEnvelope; account?: string }) : undefined;
    const env = (p?.envelope ?? p) as WireEnvelope | undefined;
    if (!env || typeof env !== "object") return;
    if (env.syncMessage !== undefined || env.receiptMessage !== undefined || env.typingMessage !== undefined) return;
    const dm = env.dataMessage;
    if (!dm || typeof dm !== "object") return;

    const number = pick(env.sourceNumber, env.source && E164.test(env.source) ? env.source : undefined);
    const uuid = pick(env.sourceUuid, env.source && UUID.test(env.source) ? env.source : undefined);
    const senderIds = [number, uuid].filter((x): x is string => x !== undefined);
    if (senderIds.length === 0 || this.#isBot(number, uuid)) return;
    const senderId = senderIds[0]!;
    const ts = dm.timestamp ?? env.timestamp;
    if (!Number.isSafeInteger(ts)) return;
    const dedupe = `${env.source ?? senderId}|${ts}`;
    if (this.#seen.has(dedupe)) return;
    this.#seen.add(dedupe);
    if (this.#seen.size > DEDUPE_MAX) this.#seen.delete(this.#seen.values().next().value!);

    const groupId = dm.groupInfo?.groupId;
    let chatId: string;
    let chatKind: "direct" | "group";
    if (groupId !== undefined) {
      if (typeof groupId !== "string" || !this.#allow.has(groupId)) return this.#drop("group-not-allowed");
      chatKind = "group";
      chatId = groupId;
    } else {
      chatKind = "direct";
      chatId = senderId;
      if (!senderIds.some((id) => this.#dm.has(id)) && !this.#allow.has(chatId)) return this.#drop("dm-not-allowed");
    }

    // Mentions: strip the placeholder for the bot (addressed); other mentions become readable @names.
    const raw = typeof dm.message === "string" ? dm.message : "";
    let text = raw;
    let mentioned = false;
    const mentions = (Array.isArray(dm.mentions) ? dm.mentions : [])
      .filter(
        (m) =>
          m && Number.isSafeInteger(m.start) && Number.isSafeInteger(m.length) && m.start! >= 0 && m.length! >= 1 &&
          m.start! + m.length! <= raw.length,
      )
      .sort((a, b) => b.start! - a.start!);
    for (const m of mentions) {
      const bot = this.#isBot(m.number, m.uuid);
      mentioned ||= bot;
      const replacement = bot ? "" : `@${(m.name ?? "user").replace(/[\u0000-\u001f￼]/g, "").slice(0, 64)}`;
      text = text.slice(0, m.start!) + replacement + text.slice(m.start! + m.length!);
    }
    text = text.replace(/￼/g, "").trim();

    const q = dm.quote;
    const quoteAuthor = q ? pick(q.authorUuid, q.author) : undefined;
    const quoteBot = q ? this.#isBot(pick(q.authorNumber, q.author && E164.test(q.author) ? q.author : undefined), pick(q.authorUuid, q.author && UUID.test(q.author) ? q.author : undefined)) : false;
    const addressed = chatKind === "direct" || mentioned || quoteBot;

    const reaction = dm.reaction && typeof dm.reaction === "object" ? dm.reaction : undefined;
    if (reaction) {
      if (chatKind === "group") {
        const member = this.#users ? senderIds.some((id) => this.#users!.has(id)) : true;
        const policy = this.#o.replyPolicy ?? "mention";
        if (this.#users && !member && !(policy === "allowlist" && addressed)) return this.#drop("user-not-allowed");
        if (!this.#groupHears(member, addressed)) return this.#drop("group-policy");
      }
      const rich: RichInbound = {
        channel: this.name,
        chatId,
        chatKind,
        senderId,
        text: "",
        senderIds,
        addressed,
        mentioned,
        ...(ts !== undefined ? { sentAt: ts } : {}),
        reaction: {
          emoji: String(reaction.emoji ?? "").slice(0, 16),
          targetMessageId: String(reaction.targetSentTimestamp ?? ""),
          targetAuthorId: pick(reaction.targetAuthorUuid, reaction.targetAuthorNumber, reaction.targetAuthor) ?? "",
          remove: reaction.isRemove === true,
        },
      };
      return this.#emitRich(rich);
    }

    // Reply-code approvals are checked before the group policy: the reply needs no mention.
    if (text) {
      const check = this.#approvals.check(chatId, senderIds, text);
      if (check.kind !== "none") return this.#approvalReply(check, chatId);
    }

    if (chatKind === "group") {
      const member = this.#users ? senderIds.some((id) => this.#users!.has(id)) : true;
      const policy = this.#o.replyPolicy ?? "mention";
      if (this.#users && !member && !(policy === "allowlist" && addressed)) return this.#drop("user-not-allowed");
      if (!this.#groupHears(member, addressed)) return this.#drop("group-policy");
    }

    if (dm.viewOnce === true) {
      await this.#reply(chatId, messages(this.#locale).viewOnce);
      return this.#drop("view-once");
    }

    const cmd = chatKind === "direct" ? /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(text) : null;
    const command = cmd && ["link", "help"].includes(cmd[1]!.toLowerCase()) ? cmd[1]!.toLowerCase() : undefined;
    if (command === "help") {
      await this.#reply(chatId, messages(this.#locale).help);
      return;
    }
    if (command === "link") {
      await this.#link(chatId, senderId, (cmd?.[2] ?? "").trim());
      return;
    }

    let attachments: Attachment[] = [];
    try {
      attachments = await this.#fetchAttachments(dm.attachments ?? [], chatKind, chatId, senderId);
    } catch {
      this.#log("warn", "channel.signal.media-rejected", { chatKind });
      await this.#reply(chatId, messages(this.#locale).mediaRefused);
      return;
    }
    if (!text && attachments.length === 0 && dm.expiresInSeconds === undefined) return;

    this.#remember(this.#quotes, String(ts), senderId);
    const rich: RichInbound = {
      channel: this.name,
      chatId,
      chatKind,
      senderId,
      text,
      messageId: String(ts),
      senderIds,
      addressed,
      mentioned,
      ...(ts !== undefined ? { sentAt: ts } : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(command ? { command: { name: command, argument: (cmd?.[2] ?? "").trim() } } : {}),
      ...(quoteAuthor !== undefined && q?.id !== undefined
        ? { quote: { messageId: String(q.id), authorId: quoteAuthor, isBot: quoteBot } }
        : {}),
      ...(typeof dm.expiresInSeconds === "number" && dm.expiresInSeconds > 0
        ? { expiresInSeconds: dm.expiresInSeconds }
        : {}),
    };
    await this.#emitRich(rich);
  }

  #groupHears(member: boolean, addressed: boolean): boolean {
    const policy = this.#o.replyPolicy ?? "mention";
    const heard = policy === "always" || (policy === "allowlist" && member && this.#users !== undefined);
    return heard || addressed;
  }

  async #emitRich(message: RichInbound): Promise<void> {
    for (const h of [...this.#handlers]) {
      try {
        await h(message);
      } catch {
        this.#log("error", "channel.signal.handler-failed", {});
      }
    }
    if (!this.#host) return;
    // Framework v1 is text-only: rich turns stay on onMessage and are never silently claimed as core support.
    if (!message.text || message.attachments?.length || message.reaction || message.command) {
      if (message.attachments?.length || message.reaction) this.#log("warn", "channel.signal.framework-rich-turn-gap", {});
      return;
    }
    try {
      await this.#host.receive(message);
    } catch {
      this.#log("error", "channel.signal.host-failed", {});
    }
  }

  async #approvalReply(check: ReturnType<ApprovalBook["check"]>, chatId: string): Promise<void> {
    const m = messages(this.#locale);
    if (check.kind === "decided") {
      const decision: ApprovalDecision = { ...check.decision, at: this.#now() };
      for (const h of [...this.#decisionHandlers]) {
        try {
          await h(decision);
        } catch {
          this.#log("error", "channel.signal.decision-handler-failed", {});
        }
      }
      await this.#reply(chatId, m.recorded);
      return;
    }
    this.#log("warn", "channel.signal.approval-refused", { reason: check.kind === "refused" ? check.reason : "none" });
    await this.#reply(chatId, m.refused);
  }

  async #link(chatId: string, senderId: string, code: string): Promise<void> {
    const m = messages(this.#locale);
    let reply: string = m.linkFail;
    if (this.#o.pairing) {
      try {
        this.#o.pairing.claim({
          code,
          identity: { channel: "signal", accountId: this.#o.account, userId: senderId },
        });
        reply = m.linkOk;
      } catch {
        /* Uniform reply; the identity port owns rate limits. The submitted code is never logged. */
      }
    }
    await this.#reply(chatId, reply);
  }

  async #reply(chatId: string, text: string): Promise<void> {
    try {
      await this.sendTurn({ chatId, text, markdown: false });
    } catch {
      this.#log("warn", "channel.signal.reply-failed", {});
    }
  }

  async #fetchAttachments(list: readonly WireAttachment[], chatKind: "direct" | "group", chatId: string, senderId: string): Promise<Attachment[]> {
    const out: Attachment[] = [];
    const ac = this.#ac;
    if (!ac || !this.#client) throw new Error("not started");
    for (const a of list) {
      if (!a || typeof a.id !== "string" || !/^[A-Za-z0-9_+/=.-]{1,256}$/.test(a.id)) throw new Error("bad attachment");
      if (a.size !== undefined && (!Number.isSafeInteger(a.size) || a.size < 0 || a.size > this.#max))
        throw new Error("media size limit");
      const mime = (a.contentType ?? "application/octet-stream").toLowerCase().split(";")[0]!.trim();
      if (!SAFE_MIME.test(mime)) throw new Error("unsupported media MIME type");
      const scope = chatKind === "group" ? { groupId: [chatId] } : { recipient: [senderId] };
      const r = await this.#client.call<unknown>("getAttachment", { account: this.#o.account, id: a.id, ...scope }, ac.signal);
      const b64 = typeof r === "string" ? r : r && typeof r === "object" && typeof (r as { data?: unknown }).data === "string" ? (r as { data: string }).data : undefined;
      if (b64 === undefined || b64.length > Math.ceil(this.#max / 3) * 4 + 4) throw new Error("media size limit");
      const data = Buffer.from(b64, "base64");
      if (data.length === 0 || data.length > this.#max || (a.size !== undefined && data.length > a.size))
        throw new Error("media size limit");
      out.push({
        kind: kindOf(mime),
        data: new Uint8Array(data),
        mimeType: mime,
        ...(a.filename ? { filename: safeName(a.filename) } : {}),
      });
    }
    return out;
  }

  #drop(reason: string): void {
    this.#log("debug", "channel.signal.dropped", { reason });
  }

  #log(level: LogLevel, event: string, attrs: Record<string, string | number | boolean>): void {
    const safe = redactAttrs(attrs, this.#o.account);
    this.#o.logger?.log(level, event, safe);
    if (level !== "debug") (this.#host?.log as HostLogger | undefined)?.[level](event, safe);
  }
}

function findAccountUuid(accounts: unknown, number: string): string | undefined {
  const list = Array.isArray(accounts) ? accounts : [];
  for (const a of list) {
    if (a && typeof a === "object" && (a as { number?: unknown }).number === number) {
      const u = (a as { uuid?: unknown }).uuid;
      if (typeof u === "string" && UUID.test(u)) return u;
    }
  }
  return undefined;
}

/** Factory used by the host: JSON config (secret-free) plus non-JSON deps. */
export function createSignalChannel(cfg: SignalConfig, deps: SignalDeps = {}): SignalChannel {
  return new SignalChannel({ ...cfg, ...deps });
}

