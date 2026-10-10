import { createHash, randomBytes } from "node:crypto";
import type { IdentityService } from "../../core/src/identity/service.ts";
import type { Channel, ChannelHealth, ChannelHost, OutboundMessage } from "../../core/src/channels/types.ts";
import { ImapConnection, openImap } from "./imap.ts";
import { MESSAGES, type Messages } from "./messages.ts";
import { buildMessage, type OutAttachment } from "./mime-build.ts";
import { parseMessage, type ParsedMessage } from "./mime-parse.ts";
import { markdownToHtml } from "./markdown.ts";
import { normalizeConfig, type EmailConfig, type NormalizedConfig } from "./config.ts";
import {
  attachmentKind,
  authPasses,
  firstLine,
  loopReason,
  newApprovalCode,
  parseApprovalReply,
  parseAuthResults,
  parseLinkCommand,
  safeMime,
  senderMatches,
  SlidingWindow,
  stripQuotedText,
  type AuthResults,
} from "./policy.ts";
import { outputAttachment, type OutputPort } from "./outputs.ts";
import { redactAttrs } from "./redact.ts";
import { smtpNoop, sendMail, checkAddrSpec, type SmtpOptions } from "./smtp.ts";
import { EMAIL_MAX_BODY_CHARS, truncateBody } from "./split.ts";
import {
  MemoryThreadStore,
  capReferences,
  chainFor,
  replySubject,
  threadKey,
  type ThreadRecord,
  type ThreadStore,
} from "./threading.ts";
import { sanitizeFilename } from "./mime-build.ts";
import { EmailError, defaultConnect, defaultUpgradeTls, type ConnectFn, type UpgradeTlsFn } from "./wire.ts";
import type {
  ApprovalDecision,
  ApprovalPrompt,
  Attachment,
  ChannelCapabilities,
  ChannelLogger,
  InboundHandler,
  LogLevel,
  OutboundTurn,
  RichInbound,
  SecretReader,
  SentRef,
  SleepFn,
  UidStore,
} from "./port.ts";
import { UnsupportedError } from "./port.ts";

export interface EmailDeps {
  secrets: SecretReader;
  uidStore: UidStore;
  threadStore?: ThreadStore;
  /** Host-supplied pairing port; the sender address from the authenticated mail is the only identity used. */
  pairing?: Pick<IdentityService, "claim">;
  outputs?: OutputPort;
  logger?: ChannelLogger;
  connect?: ConnectFn;
  upgradeTls?: UpgradeTlsFn;
  now?: () => number;
  sleep?: SleepFn;
  random?: () => number;
  /** Largest message accepted (checked against RFC822.SIZE before any body fetch). Default 25 MiB. */
  maxMessageBytes?: number;
}

export type EmailChannelOptions = EmailConfig & EmailDeps;

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

const IDLE_MS = 25 * 60 * 1000;
const SMTP_CHECK_MS = 10 * 60 * 1000;
const SEND_ATTEMPTS = 3;
const MAX_ATTACHMENTS = 10;
const APPROVAL_DEFAULT_TTL = 5 * 60 * 1000;
const APPROVAL_MAX_TTL = 24 * 60 * 60 * 1000;
const MAX_PENDING_APPROVALS = 1000;

interface PendingApproval {
  promptId: string;
  chatId: string;
  choices: readonly { id: string; label: string }[];
  approverIds: readonly string[];
  expires: number;
  used: boolean;
}

export class EmailChannel implements Channel {
  readonly name = "email" as const;
  readonly capabilities: ChannelCapabilities = {
    threads: true,
    edit: false,
    typing: false,
    attachmentsIn: true,
    attachmentsOut: true,
    reactions: false,
    buttons: false,
    approvalMode: "reply-code",
    markdown: "converted",
    maxMessageChars: EMAIL_MAX_BODY_CHARS,
  };
  readonly #o: EmailChannelOptions;
  readonly #cfg: NormalizedConfig;
  readonly #msgs: Messages;
  readonly #threads: ThreadStore;
  readonly #connect: ConnectFn;
  readonly #upgrade: UpgradeTlsFn;
  readonly #now: () => number;
  readonly #sleep: SleepFn;
  readonly #random: () => number;
  readonly #maxMessage: number;
  readonly #handlers = new Set<InboundHandler>();
  readonly #decisionHandlers = new Set<(d: ApprovalDecision) => void | Promise<void>>();
  readonly #approvals = new Map<string, PendingApproval>();
  readonly #seenIds = new Set<string>();
  readonly #outWindow: SlidingWindow;
  readonly #refusals: SlidingWindow;
  #host: ChannelHost | undefined;
  #ac: AbortController | undefined;
  #loop: Promise<void> | undefined;
  #starting: Promise<void> | undefined;
  #conn: ImapConnection | undefined;
  #password: string | undefined;
  #secretValues: string[] = [];
  #healthy = false;
  #smtpOk: boolean | undefined;
  #smtpCheckedAt = -Infinity;

  constructor(opts: EmailChannelOptions) {
    this.#o = opts;
    this.#cfg = normalizeConfig(opts);
    this.#msgs = MESSAGES[this.#cfg.locale];
    this.#threads = opts.threadStore ?? new MemoryThreadStore();
    this.#connect = opts.connect ?? defaultConnect;
    this.#upgrade = opts.upgradeTls ?? defaultUpgradeTls;
    this.#now = opts.now ?? Date.now;
    this.#sleep = opts.sleep ?? defaultSleep;
    this.#random = opts.random ?? Math.random;
    const max = opts.maxMessageBytes ?? 25 * 1024 * 1024;
    if (!Number.isSafeInteger(max) || max < 1 || max > 50 * 1024 * 1024) throw new RangeError("maxMessageBytes is invalid");
    this.#maxMessage = max;
    this.#outWindow = new SlidingWindow(30, 60 * 60 * 1000, this.#now);
    this.#refusals = new SlidingWindow(3, 60 * 60 * 1000, this.#now);
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
    try {
      const password = await this.#reveal(this.#cfg.imap.passwordSecret);
      const smtpPassword =
        this.#cfg.smtp.passwordSecret === this.#cfg.imap.passwordSecret
          ? password
          : await this.#reveal(this.#cfg.smtp.passwordSecret);
      this.#password = password;
      this.#smtpSecret = smtpPassword;
      this.#secretValues = [...new Set([password, smtpPassword])];
      this.#host = host;
      const conn = await this.#open();
      this.#conn = conn;
      this.#healthy = true;
      await this.#sync(conn, ac.signal);
      this.#loop = this.#run(ac.signal);
      this.#log("info", "channel.email.started", { idle: this.#cfg.imap.idle });
    } catch (e) {
      ac.abort();
      this.#conn?.close();
      this.#conn = undefined;
      this.#healthy = false;
      this.#ac = undefined;
      this.#host = undefined;
      this.#password = undefined;
      this.#smtpSecret = undefined;
      this.#secretValues = [];
      if (e instanceof EmailError) throw new Error(e.message);
      throw new Error("email start failed");
    }
  }

  async #reveal(name: string): Promise<string> {
    let v: string | null;
    try {
      v = await this.#o.secrets.reveal(name);
    } catch {
      throw new Error("email secret read failed");
    }
    if (v === null || v === "") throw new Error("email password secret is not set");
    return v;
  }

  async stop(): Promise<void> {
    this.#healthy = false;
    this.#ac?.abort();
    this.#conn?.close();
    await this.#starting?.catch(() => {});
    await this.#loop;
    this.#conn = undefined;
    this.#ac = undefined;
    this.#loop = undefined;
    this.#host = undefined;
    this.#password = undefined;
    this.#smtpSecret = undefined;
    this.#secretValues = [];
    this.#approvals.clear();
    this.#log("info", "channel.email.stopped", {});
  }

  async health(): Promise<ChannelHealth> {
    if (!this.#ac) return { ok: false, detail: "stopped" };
    if (this.#now() - this.#smtpCheckedAt >= SMTP_CHECK_MS) await this.checkSmtp();
    const smtp = this.#smtpOk === undefined ? "smtp:unchecked" : this.#smtpOk ? "smtp:ok" : "smtp:failed";
    return { ok: this.#healthy, detail: `${this.#healthy ? "imap:up" : "imap:down"} ${smtp}` };
  }

  /** NOOP on a fresh session. Lazy: called by health() at most once per ten minutes, or on demand. */
  async checkSmtp(): Promise<boolean> {
    this.#smtpCheckedAt = this.#now();
    try {
      await smtpNoop(this.#smtpOptions());
      this.#smtpOk = true;
    } catch {
      this.#smtpOk = false;
      this.#log("warn", "channel.email.smtp-check-failed", {});
    }
    return this.#smtpOk;
  }

  async send(msg: OutboundMessage): Promise<void> {
    await this.sendTurn({ chatId: msg.chatId, text: msg.text, ...(msg.replyTo !== undefined ? { replyTo: msg.replyTo } : {}) });
  }

  async sendTurn(turn: OutboundTurn): Promise<SentRef[]> {
    if (!this.#ac || !this.#password) throw new Error("email channel is not started");
    const rec = await this.#threads.get(turn.chatId);
    if (!rec) throw new Error("unknown email thread");
    return [await this.#compose(turn.chatId, rec, turn.text, {
      ...(turn.attachments ? { attachments: turn.attachments } : {}),
      ...(turn.replyTo !== undefined ? { replyTo: turn.replyTo } : {}),
      ...(turn.subject !== undefined ? { subject: turn.subject } : {}),
    })];
  }

  /** Sends an image from the trusted output store into an existing thread. Authorize-before-read, SHA-256 checked. */
  async sendOutput(chatId: string, outputId: string, index = 0): Promise<SentRef[]> {
    if (!this.#o.outputs) throw new Error("media output store unavailable");
    const att = await outputAttachment(this.#o.outputs, outputId, chatId, this.#cfg.maxAttachmentBytes, index);
    return this.sendTurn({ chatId, text: "", attachments: [att] });
  }

  async edit(_ref: SentRef, _text: string): Promise<void> {
    throw new UnsupportedError("email cannot edit a sent message");
  }

  async typing(_chatId: string): Promise<void> {}

  async prompt(req: ApprovalPrompt): Promise<{ promptId: string; refs: SentRef[] }> {
    if (!this.#ac || !this.#password) throw new Error("email channel is not started");
    const rec = await this.#threads.get(req.chatId);
    if (!rec) throw new Error("unknown email thread");
    const ttl = req.ttlMs ?? APPROVAL_DEFAULT_TTL;
    if (!Number.isSafeInteger(ttl) || ttl < 1000 || ttl > APPROVAL_MAX_TTL) throw new RangeError("approval TTL must be 1 s..24 h");
    if (req.choices.length < 1 || req.choices.length > 9) throw new RangeError("approval needs 1..9 choices");
    if (new Set(req.choices.map((c) => c.id)).size !== req.choices.length) throw new RangeError("approval choice ids must be unique");
    if (req.approverIds.length < 1) throw new RangeError("approval needs at least one approver");
    for (const a of req.approverIds) {
      checkAddrSpec(a);
      if (!senderMatches(this.#cfg.dmAllowlist, a)) throw new Error("approver is not on the allowlist");
    }
    this.#prune();
    if (this.#approvals.size >= MAX_PENDING_APPROVALS) throw new Error("too many pending approvals");
    const code = newApprovalCode();
    const promptId = randomBytes(12).toString("base64url");
    const numbered = req.choices.map((c, i) => ({ n: i + 1, id: c.id, label: c.label }));
    const text = `${req.text}\n\n${this.#msgs.approvalHowTo(code, numbered, Math.round(ttl / 60000))}`;
    const refs = [
      await this.#compose(req.chatId, rec, text, { subject: `[approval ${code}] ${this.#msgs.approvalSubject}` }),
    ];
    this.#approvals.set(code, {
      promptId,
      chatId: req.chatId,
      choices: req.choices.map((c) => ({ id: c.id, label: c.label })),
      approverIds: req.approverIds.map((a) => a.toLowerCase()),
      expires: this.#now() + ttl,
      used: false,
    });
    return { promptId, refs };
  }

  #prune(): void {
    const t = this.#now();
    for (const [k, p] of this.#approvals) if (p.expires <= t) this.#approvals.delete(k);
  }

  #smtpOptions(): SmtpOptions {
    const c = this.#cfg.smtp;
    return {
      host: c.host,
      port: c.port,
      security: c.security,
      user: c.user,
      password: this.#smtpPassword(),
      ehloName: this.#cfg.address.split("@")[1]!,
      connect: this.#connect,
      upgradeTls: this.#upgrade,
    };
  }

  #smtpPassword(): string {
    if (this.#cfg.smtp.passwordSecret === this.#cfg.imap.passwordSecret) return this.#password!;
    return this.#smtpSecret!;
  }
  #smtpSecret: string | undefined;

  async #open(): Promise<ImapConnection> {
    const i = this.#cfg.imap;
    const opened = await openImap({
      host: i.host,
      port: i.port,
      security: i.security,
      user: i.user,
      password: this.#password!,
      folder: i.folder,
      connect: this.#connect,
      upgradeTls: this.#upgrade,
    });
    this.#caps = opened.caps;
    return opened.conn;
  }
  #caps: Set<string> = new Set();

  async #run(signal: AbortSignal): Promise<void> {
    let failures = 0;
    let conn: ImapConnection | undefined = this.#conn;
    while (!signal.aborted) {
      try {
        if (!conn) {
          conn = await this.#open();
          this.#conn = conn;
          this.#healthy = true;
          failures = 0;
        }
        await this.#pollLoop(conn, signal);
      } catch (e) {
        if (signal.aborted) break;
        const err = e instanceof EmailError ? e : new EmailError("network", "email session failed");
        conn?.close();
        conn = undefined;
        this.#conn = undefined;
        this.#healthy = false;
        if (err.kind === "auth" || err.kind === "state") {
          this.#log("error", "channel.email.fatal", { kind: err.kind });
          this.#host?.fail(new Error(err.kind === "auth" ? "email authentication failed" : "email state is invalid"));
          return;
        }
        failures++;
        const wait = Math.round(Math.min(300_000, 1000 * 2 ** Math.min(failures - 1, 12)) * (0.75 + this.#random() * 0.5));
        this.#log("warn", "channel.email.reconnect", { kind: err.kind, waitMs: wait });
        await this.#sleep(wait, signal);
      }
    }
  }

  async #pollLoop(conn: ImapConnection, signal: AbortSignal): Promise<void> {
    let idle = this.#cfg.imap.idle && this.#caps.has("IDLE");
    const pollMs = this.#cfg.imap.pollIntervalSec * 1000;
    while (!signal.aborted) {
      await this.#sync(conn, signal);
      if (signal.aborted) return;
      if (idle) {
        try {
          await conn.idle(IDLE_MS, this.#sleep);
        } catch (e) {
          if (e instanceof EmailError && e.kind === "protocol") {
            idle = false;
            this.#log("warn", "channel.email.idle-fallback", {});
            await this.#sleep(pollMs, signal);
          } else throw e;
        }
      } else {
        await this.#sleep(pollMs, signal);
      }
    }
  }

  /** Fetches mail above the persisted UID cursor. UIDVALIDITY change or first start: baseline to the current top, never process history. */
  async #sync(conn: ImapConnection, signal: AbortSignal): Promise<void> {
    const sel = await conn.select(this.#cfg.imap.folder);
    let st = await this.#loadState();
    if (!st || st.folder !== this.#cfg.imap.folder || st.uidValidity !== sel.uidValidity) {
      if (st) this.#log("warn", "channel.email.uidvalidity-reset", {});
      const top = sel.uidNext !== undefined ? sel.uidNext - 1 : ((await conn.uidsAbove(0)).at(-1) ?? 0);
      st = { folder: this.#cfg.imap.folder, uidValidity: sel.uidValidity, lastUid: top };
      await this.#o.uidStore.save(st);
      this.#log("info", "channel.email.baseline", {});
      return;
    }
    for (const uid of await conn.uidsAbove(st.lastUid)) {
      if (signal.aborted) return;
      const size = await conn.fetchSize(uid);
      if (size > this.#maxMessage) {
        this.#log("warn", "channel.email.oversized-skipped", { bytes: size });
      } else {
        const raw = await conn.fetchRaw(uid);
        if (raw.length <= this.#maxMessage) await this.#handleRaw(raw);
        else this.#log("warn", "channel.email.oversized-skipped", { bytes: raw.length });
      }
      st = { ...st, lastUid: uid };
      await this.#o.uidStore.save(st);
      await conn.markSeen(uid);
    }
  }

  async #loadState() {
    try {
      return await this.#o.uidStore.load();
    } catch (e) {
      if (e instanceof EmailError && e.kind === "state") throw e;
      throw new EmailError("state", "email state is unavailable");
    }
  }

  /** Inbound policy. Never throws: every outcome is a log line, a drop, a rich/framework hand-off or an approval decision. */
  async #handleRaw(raw: Buffer): Promise<void> {
    let msg: ParsedMessage;
    try {
      msg = parseMessage(raw, { maxAttachmentBytes: this.#cfg.maxAttachmentBytes });
    } catch {
      this.#log("warn", "channel.email.parse-failed", {});
      return;
    }
    const mid = msg.messageId;
    if (mid && this.#seenIds.has(mid)) {
      this.#log("debug", "channel.email.duplicate", {});
      return;
    }
    if (mid) {
      this.#seenIds.add(mid);
      if (this.#seenIds.size > 4096) this.#seenIds.delete(this.#seenIds.values().next().value!);
    }
    if (this.#cfg.requireAuthPass && this.#cfg.authServId === undefined) {
      // Without a trusted authserv-id no auth result can be trusted, so nothing may pass.
      this.#log("warn", "channel.email.auth-unverifiable", {});
      return;
    }
    if (msg.fromProblem || !msg.from) {
      this.#log("warn", "channel.email.from-rejected", { reason: msg.fromProblem ?? "missing" });
      return;
    }
    const from = msg.from.address;
    const loop = loopReason(msg, this.#cfg.address);
    if (loop) {
      this.#log("info", "channel.email.loop-ignored", { reason: loop });
      return;
    }
    if (!senderMatches(this.#cfg.dmAllowlist, from)) {
      this.#log("info", "channel.email.sender-not-allowed", {});
      return;
    }
    const auth: AuthResults = parseAuthResults(msg.headers.getAll("authentication-results"), this.#cfg.authServId);
    if (this.#cfg.requireAuthPass && !authPasses(auth)) {
      this.#log("warn", "channel.email.auth-required", { spf: auth.spf, dkim: auth.dkim, dmarc: auth.dmarc });
      return;
    }
    const root = msg.references[0] ?? mid ?? `noid-${createHash("sha256").update(raw).digest("hex")}`;
    const key = threadKey(root);
    const existing = await this.#threads.get(key);
    if (existing && existing.peer !== from) {
      this.#log("warn", "channel.email.thread-peer-mismatch", {});
      return;
    }
    const chain = capReferences(chainFor(msg.references, mid ?? (msg.references.length ? undefined : root)));
    await this.#threads.put(key, { peer: from, subject: msg.subject, chain: chain.length ? chain : [root] });

    const body = stripQuotedText(msg.text);
    const first = firstLine(body);
    const approval = parseApprovalReply(first);
    if (approval && this.#approvalReply(approval.code, approval.choice, key, from, auth)) return;

    const link = parseLinkCommand(first) ?? parseLinkCommand(msg.subject.replace(/^(\s*re:\s*)+/i, ""));
    if (link !== undefined && this.#o.pairing) {
      // Identity binding needs a trusted DMARC pass; the From address alone is forgeable.
      if (!authPasses(auth)) {
        this.#log("warn", "channel.email.link-refused", { reason: "auth" });
        await this.#replyQuietly(key, this.#msgs.linkFail);
        return;
      }
      let pairingId: string | undefined;
      try {
        pairingId = this.#o.pairing.claim({ code: link, identity: { channel: "email", accountId: this.#cfg.address, userId: from } }).pairingId;
      } catch {
        /* uniform reply below; the identity port owns rate limits; the code is never logged */
      }
      this.#log(pairingId ? "info" : "warn", "channel.email.link", { ok: pairingId !== undefined });
      await this.#replyQuietly(key, pairingId ? this.#msgs.linkOk(pairingId) : this.#msgs.linkFail);
      return;
    }

    const attachments: Attachment[] = [];
    for (const a of msg.attachments) {
      if (attachments.length >= MAX_ATTACHMENTS) break;
      if (!safeMime(a.mimeType)) continue;
      attachments.push({
        kind: attachmentKind(a.mimeType),
        data: a.data,
        mimeType: a.mimeType,
        filename: sanitizeFilename(a.filename),
      });
    }
    const text = truncateBody(body || msg.subject, this.#msgs.truncated).text;
    const rich: RichInbound = {
      channel: this.name,
      chatId: key,
      chatKind: "direct",
      senderId: from,
      accountId: this.#cfg.address,
      text,
      ...(mid !== undefined ? { messageId: mid } : {}),
      ...(msg.date !== undefined ? { sentAt: msg.date } : {}),
      subject: msg.subject,
      auth,
      rootMessageId: root,
      ...(attachments.length ? { attachments } : {}),
    };
    this.#log("info", "channel.email.inbound", {
      spf: auth.spf,
      dkim: auth.dkim,
      dmarc: auth.dmarc,
      attachments: attachments.length,
      skippedAttachments: msg.skippedAttachments,
    });
    for (const h of [...this.#handlers]) {
      try {
        await h(rich);
      } catch {
        this.#log("error", "channel.email.handler-failed", {});
      }
    }
    if (!this.#host) return;
    if (!text || attachments.length) {
      this.#log("warn", "channel.email.framework-rich-turn-gap", {});
      return;
    }
    try {
      await this.#host.receive({
        channel: this.name,
        chatId: key,
        chatKind: "direct",
        senderId: from,
        accountId: this.#cfg.address,
        text,
        ...(mid !== undefined ? { messageId: mid } : {}),
      });
    } catch {
      this.#log("error", "channel.email.host-failed", {});
    }
  }

  /** Returns true when the mail was an approval attempt (accepted or refused) and must not be forwarded as text. */
  #approvalReply(code: string, choice: number, key: string, from: string, auth: AuthResults): boolean {
    const p = this.#approvals.get(code);
    if (!p) return false;
    const t = this.#now();
    let reason: string | undefined;
    if (p.used) reason = "replayed";
    else if (p.expires <= t) reason = "expired";
    else if (p.chatId !== key) reason = "wrong-thread";
    else if (!p.approverIds.includes(from)) reason = "not-approver";
    else if (choice < 1 || choice > p.choices.length) reason = "bad-choice";
    else if (!authPasses(auth)) reason = "auth";
    if (reason) {
      this.#log("warn", "channel.email.approval-refused", { reason });
      if (this.#refusals.take(from)) void this.#replyQuietly(key, this.#msgs.approvalRefused);
      return true;
    }
    p.used = true;
    const decision: ApprovalDecision = {
      promptId: p.promptId,
      chatId: p.chatId,
      senderId: from,
      choiceId: p.choices[choice - 1]!.id,
      at: t,
    };
    this.#log("info", "channel.email.approval-accepted", { choice });
    void this.#emitDecision(decision);
    return true;
  }

  async #emitDecision(d: ApprovalDecision): Promise<void> {
    for (const h of [...this.#decisionHandlers]) {
      try {
        await h(d);
      } catch {
        this.#log("error", "channel.email.decision-handler-failed", {});
      }
    }
  }

  async #replyQuietly(key: string, text: string): Promise<void> {
    if (!this.#refusals.take(key)) return;
    try {
      const rec = await this.#threads.get(key);
      if (rec) await this.#compose(key, rec, text, {});
    } catch {
      this.#log("warn", "channel.email.reply-failed", {});
    }
  }

  async #compose(
    chatId: string,
    rec: ThreadRecord,
    text: string,
    opts: { attachments?: readonly Attachment[]; replyTo?: string; subject?: string },
  ): Promise<SentRef> {
    if (!senderMatches(this.#cfg.dmAllowlist, rec.peer)) throw new Error("email peer is not on the allowlist");
    if (!this.#outWindow.take(rec.peer)) throw new Error("email outbound rate limit reached");
    const atts = opts.attachments ?? [];
    if (atts.length > MAX_ATTACHMENTS) throw new Error("too many attachments");
    const out: OutAttachment[] = [];
    for (const a of atts) {
      if (a.data.byteLength > this.#cfg.maxAttachmentBytes) throw new Error("outbound media exceeds size limit");
      if (!safeMime(a.mimeType)) throw new Error("unsupported media MIME type");
      out.push({ filename: a.filename ?? "attachment", mimeType: a.mimeType, data: a.data });
    }
    const body = truncateBody(text, this.#msgs.truncated).text;
    const domain = this.#cfg.address.split("@")[1]!;
    const messageId = `${randomBytes(16).toString("hex")}@${domain}`;
    const parent = opts.replyTo?.replace(/^<|>$/g, "") ?? rec.chain.at(-1);
    const refs = capReferences(rec.chain);
    const raw = buildMessage({
      from: { ...(this.#cfg.displayName !== undefined ? { name: this.#cfg.displayName } : {}), address: this.#cfg.address },
      to: rec.peer,
      subject: opts.subject ?? replySubject(rec.subject),
      text: body,
      html: markdownToHtml(body),
      messageId,
      date: this.#now(),
      ...(parent !== undefined ? { inReplyTo: parent } : {}),
      ...(refs.length ? { references: refs } : {}),
      ...(out.length ? { attachments: out } : {}),
    });
    await this.#deliver(raw, rec.peer);
    await this.#threads.put(chatId, { ...rec, chain: capReferences([...rec.chain, messageId]) });
    return { chatId, id: messageId };
  }

  async #deliver(raw: Buffer, to: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await sendMail({ ...this.#smtpOptions(), from: this.#cfg.address, to, data: raw });
        this.#smtpOk = true;
        return;
      } catch (e) {
        const retry = e instanceof EmailError && (e.kind === "temporary" || e.kind === "network");
        if (!retry || attempt >= SEND_ATTEMPTS || this.#ac?.signal.aborted) {
          this.#smtpOk = false;
          this.#log("warn", "channel.email.send-failed", { kind: e instanceof EmailError ? e.kind : "unknown" });
          throw new Error(e instanceof EmailError ? e.message : "email send failed");
        }
        const wait = Math.round(Math.min(60_000, 2000 * 2 ** (attempt - 1)) * (0.75 + this.#random() * 0.5));
        this.#log("warn", "channel.email.send-retry", { attempt, waitMs: wait });
        await this.#sleep(wait, this.#ac!.signal);
      }
    }
  }

  #log(level: LogLevel, event: string, attrs: Readonly<Record<string, string | number | boolean>>): void {
    const safe = redactAttrs(attrs, this.#secretValues);
    this.#o.logger?.log(level, event, safe);
    if (level !== "debug") this.#host?.log[level](event, safe);
  }
}
