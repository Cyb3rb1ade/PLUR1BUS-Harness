import type { Socket } from "node:net";
import { EmailError, LineReader, type ConnectFn, type UpgradeTlsFn } from "./wire.ts";

/** Largest literal the client will accept. Bodies are further bounded by RFC822.SIZE before fetching. */
export const IMAP_MAX_LITERAL = 50 * 1024 * 1024;
const IDLE_MAX_MS = 25 * 60 * 1000;

export interface ImapResponse {
  /** Logical response line; each literal is replaced by `{#i}` where i indexes `literals`. */
  text: string;
  literals: Buffer[];
}
export interface ImapTagged {
  status: "OK" | "NO" | "BAD";
  text: string;
  untagged: ImapResponse[];
}
export interface SelectResult {
  uidValidity: number;
  uidNext: number | undefined;
  exists: number;
}

/** Quotes an IMAP string. CR, LF and NUL are refused: they would let a value inject commands. */
export function quote(s: string): string {
  if (/[\r\n\0]/.test(s)) throw new EmailError("protocol", "invalid character in IMAP argument");
  return `"${s.replace(/[\\"]/g, "\\$&")}"`;
}

const TIMER = Symbol("timer");

/** One IMAP connection. Commands are strictly sequential; the channel never overlaps them. */
export class ImapConnection {
  #reader: LineReader;
  #tag = 0;
  #busy = false;
  constructor(socket: Socket) {
    this.#reader = new LineReader(socket);
  }

  #write(s: string): void {
    this.#reader.socket.write(Buffer.from(s, "utf8"));
  }

  async #response(): Promise<ImapResponse> {
    let text = "";
    const literals: Buffer[] = [];
    for (;;) {
      const l = await this.#reader.line();
      const m = /\{(\d{1,9})\}$/.exec(l);
      if (!m) return { text: text + l, literals };
      const n = Number(m[1]);
      if (n > IMAP_MAX_LITERAL) throw new EmailError("protocol", "IMAP literal too large");
      literals.push(await this.#reader.bytes(n));
      text += `${l.slice(0, m.index)}{#${literals.length - 1}}`;
    }
  }

  #nextTag(): string {
    return `A${String(++this.#tag).padStart(4, "0")}`;
  }

  #lock(): void {
    if (this.#busy) throw new EmailError("protocol", "IMAP command overlap");
    this.#busy = true;
  }

  async greeting(): Promise<void> {
    const r = await this.#response();
    if (/^\* BYE/i.test(r.text)) throw new EmailError("network", "server refused connection");
    if (!/^\* (OK|PREAUTH)\b/i.test(r.text)) throw new EmailError("protocol", "unexpected IMAP greeting");
  }

  /** Sends a command. `onCont` answers a `+` continuation (AUTHENTICATE only). Returns the tagged status. */
  async command(cmd: string, onCont?: (challenge: string) => string | undefined): Promise<ImapTagged> {
    this.#lock();
    try {
      const tag = this.#nextTag();
      this.#write(`${tag} ${cmd}\r\n`);
      const untagged: ImapResponse[] = [];
      for (;;) {
        const r = await this.#response();
        if (r.text.startsWith("+")) {
          const out = onCont?.(r.text.slice(1).trim());
          if (out === undefined) throw new EmailError("protocol", "unexpected IMAP continuation");
          this.#write(`${out}\r\n`);
          continue;
        }
        if (r.text.startsWith("* ")) {
          if (/^\* BYE/i.test(r.text)) throw new EmailError("network", "server closed the connection");
          untagged.push(r);
          continue;
        }
        if (r.text.startsWith(`${tag} `)) {
          const m = /^\S+ (OK|NO|BAD)\b ?(.*)$/i.exec(r.text);
          if (!m) throw new EmailError("protocol", "malformed IMAP status");
          return { status: m[1]!.toUpperCase() as "OK" | "NO" | "BAD", text: m[2] ?? "", untagged };
        }
        throw new EmailError("protocol", "unexpected IMAP response");
      }
    } finally {
      this.#busy = false;
    }
  }

  /** Replaces the transport after a successful STARTTLS. Refuses if any plaintext bytes are still buffered (injection guard). */
  async upgrade(upgradeTls: (raw: Socket) => Promise<Socket>): Promise<void> {
    if (this.#reader.buffered > 0) throw new EmailError("protocol", "unexpected data before TLS");
    const raw = this.#reader.detach();
    const secure = await upgradeTls(raw);
    this.#reader = new LineReader(secure);
  }

  async capability(): Promise<Set<string>> {
    const r = await this.command("CAPABILITY");
    if (r.status !== "OK") throw new EmailError("protocol", "CAPABILITY failed");
    const caps = new Set<string>();
    for (const u of r.untagged) {
      const m = /^\* CAPABILITY (.*)$/i.exec(u.text);
      if (m) for (const t of m[1]!.trim().split(/\s+/)) caps.add(t.toUpperCase());
    }
    return caps;
  }

  /** Authenticates over an already-protected transport. Prefers AUTHENTICATE PLAIN, falls back to LOGIN. */
  async authenticate(user: string, password: string, caps: ReadonlySet<string>): Promise<Set<string>> {
    let r: ImapTagged;
    if (caps.has("AUTH=PLAIN")) {
      let sent = false;
      r = await this.command("AUTHENTICATE PLAIN", () => {
        if (sent) return undefined;
        sent = true;
        return Buffer.from(`\0${user}\0${password}`, "utf8").toString("base64");
      });
    } else if (!caps.has("LOGINDISABLED")) {
      r = await this.command(`LOGIN ${quote(user)} ${quote(password)}`);
    } else {
      throw new EmailError("auth", "no usable IMAP authentication mechanism");
    }
    if (r.status !== "OK") throw new EmailError("auth", "IMAP authentication failed");
    return this.capability();
  }

  async select(folder: string): Promise<SelectResult> {
    const r = await this.command(`SELECT ${quote(folder)}`);
    if (r.status !== "OK") throw new EmailError("unavailable", "mailbox unavailable");
    let uidValidity: number | undefined;
    let uidNext: number | undefined;
    let exists = 0;
    for (const u of r.untagged) {
      const ex = /^\* (\d+) EXISTS/i.exec(u.text);
      if (ex) exists = Number(ex[1]);
      const uv = /\[UIDVALIDITY (\d+)\]/i.exec(u.text);
      if (uv) uidValidity = Number(uv[1]);
      const un = /\[UIDNEXT (\d+)\]/i.exec(u.text);
      if (un) uidNext = Number(un[1]);
    }
    if (uidValidity === undefined || !Number.isSafeInteger(uidValidity))
      throw new EmailError("protocol", "mailbox has no UIDVALIDITY");
    return { uidValidity, uidNext, exists };
  }

  /** UIDs strictly greater than `uid`, ascending. `N:*` also returns the largest UID below N, which is filtered out. */
  async uidsAbove(uid: number): Promise<number[]> {
    const r = await this.command(`UID SEARCH UID ${uid + 1}:*`);
    if (r.status !== "OK") throw new EmailError("protocol", "UID SEARCH failed");
    const out: number[] = [];
    for (const u of r.untagged) {
      const m = /^\* SEARCH ?(.*)$/i.exec(u.text);
      if (!m) continue;
      for (const t of m[1]!.trim().split(/\s+/)) {
        const n = Number(t);
        if (Number.isSafeInteger(n) && n > uid) out.push(n);
      }
    }
    return out.sort((a, b) => a - b);
  }

  async fetchSize(uid: number): Promise<number> {
    const r = await this.command(`UID FETCH ${uid} (RFC822.SIZE)`);
    if (r.status !== "OK") throw new EmailError("protocol", "UID FETCH failed");
    for (const u of r.untagged) {
      const m = /RFC822\.SIZE (\d+)/i.exec(u.text);
      if (m) return Number(m[1]);
    }
    throw new EmailError("protocol", "message size unavailable");
  }

  /** Body bytes without setting \Seen. Exactly one literal is expected. */
  async fetchRaw(uid: number): Promise<Buffer> {
    const r = await this.command(`UID FETCH ${uid} (BODY.PEEK[])`);
    if (r.status !== "OK") throw new EmailError("protocol", "UID FETCH failed");
    for (const u of r.untagged) {
      if (/BODY\[\]/i.test(u.text) && u.literals.length === 1) return u.literals[0]!;
    }
    throw new EmailError("protocol", "message body unavailable");
  }

  async markSeen(uid: number): Promise<void> {
    const r = await this.command(`UID STORE ${uid} +FLAGS.SILENT (\\Seen)`);
    if (r.status !== "OK") throw new EmailError("protocol", "UID STORE failed");
  }

  /**
   * IDLE until the server reports new mail or `maxMs` passes, then DONE and wait for the tagged status.
   * `sleep` is the injected timer seam; the timer is aborted when IDLE ends. Throws if IDLE is refused.
   */
  async idle(maxMs: number, sleep: (ms: number, signal: AbortSignal) => Promise<void>): Promise<"event" | "timeout"> {
    this.#lock();
    const ac = new AbortController();
    try {
      const tag = this.#nextTag();
      this.#write(`${tag} IDLE\r\n`);
      for (;;) {
        const r = await this.#response();
        if (r.text.startsWith("+")) break;
        if (r.text.startsWith(`${tag} `)) throw new EmailError("protocol", "IDLE refused");
        if (/^\* BYE/i.test(r.text)) throw new EmailError("network", "server closed the connection");
      }
      const timer: Promise<typeof TIMER> = sleep(Math.min(maxMs, IDLE_MAX_MS), ac.signal).then(() => TIMER);
      let reason: "event" | "timeout" = "timeout";
      let doneSent = false;
      let pending = this.#response();
      for (;;) {
        const got: ImapResponse | typeof TIMER = doneSent ? await pending : await Promise.race([pending, timer]);
        if (got === TIMER) {
          doneSent = true;
          this.#write("DONE\r\n");
          continue;
        }
        if (got.text.startsWith(`${tag} `)) {
          const m = /^\S+ (OK|NO|BAD)\b/i.exec(got.text);
          if (!m || m[1]!.toUpperCase() !== "OK") throw new EmailError("protocol", "IDLE failed");
          return reason;
        }
        if (/^\* BYE/i.test(got.text)) throw new EmailError("network", "server closed the connection");
        if (!doneSent && /^\* \d+ (EXISTS|EXPUNGE|RECENT)\b/i.test(got.text)) {
          reason = "event";
          doneSent = true;
          this.#write("DONE\r\n");
        }
        pending = this.#response();
      }
    } finally {
      ac.abort();
      this.#busy = false;
    }
  }

  close(): void {
    this.#reader.socket.destroy();
  }
}

export interface ImapOpenOptions {
  host: string;
  port: number;
  security: "tls" | "starttls";
  user: string;
  password: string;
  folder: string;
  connect: ConnectFn;
  upgradeTls: UpgradeTlsFn;
}
export interface ImapOpened {
  conn: ImapConnection;
  caps: Set<string>;
  select: SelectResult;
}

/**
 * Opens, protects and authenticates a connection, then SELECTs the folder.
 * security "starttls": the server MUST advertise STARTTLS before login; otherwise fail closed without sending credentials.
 * security "tls": implicit TLS from the first byte.
 */
export async function openImap(o: ImapOpenOptions): Promise<ImapOpened> {
  let raw: Socket | undefined;
  let conn: ImapConnection | undefined;
  try {
    raw = await o.connect(o.host, o.port);
    let transport: Socket = raw;
    if (o.security === "tls") transport = await o.upgradeTls(raw, o.host);
    conn = new ImapConnection(transport);
    await conn.greeting();
    if (o.security === "starttls") {
      const pre = await conn.capability();
      if (!pre.has("STARTTLS")) throw new EmailError("tls", "server does not offer STARTTLS; credentials not sent");
      const r = await conn.command("STARTTLS");
      if (r.status !== "OK") throw new EmailError("tls", "STARTTLS refused");
      await conn.upgrade((s) => o.upgradeTls(s, o.host));
    }
    const caps = await conn.authenticate(o.user, o.password, await conn.capability());
    const select = await conn.select(o.folder);
    return { conn, caps, select };
  } catch (e) {
    if (conn) conn.close();
    else raw?.destroy();
    if (e instanceof EmailError) throw e;
    throw new EmailError("network", "IMAP connection failed");
  }
}
