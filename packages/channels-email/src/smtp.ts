import type { Socket } from "node:net";
import { EmailError, LineReader, type ConnectFn, type UpgradeTlsFn } from "./wire.ts";

export interface SmtpOptions {
  host: string;
  port: number;
  security: "tls" | "starttls";
  user: string;
  password: string;
  /** EHLO name. Must be a plain hostname; defaults to the address domain. */
  ehloName: string;
  connect: ConnectFn;
  upgradeTls: UpgradeTlsFn;
}

interface Reply {
  code: number;
  lines: string[];
}

const ADDR = /^[^\s<>@"\\\0]+@[^\s<>@"\\\0]+$/;

/** Plain addr-spec only. Anything else could smuggle SMTP or header syntax. */
export function checkAddrSpec(a: string): string {
  if (!ADDR.test(a) || /[\r\n]/.test(a)) throw new EmailError("protocol", "invalid mail address");
  return a;
}

/** Dot-stuffs and CRLF-normalises a message for DATA, including the terminating ".". */
export function dotStuff(data: Buffer): Buffer {
  const text = data.toString("latin1").replace(/\r?\n/g, "\r\n");
  const body = text.endsWith("\r\n") ? text : `${text}\r\n`;
  const stuffed = body
    .split("\r\n")
    .map((l, i, arr) => (i === arr.length - 1 ? l : l.startsWith(".") ? `.${l}` : l))
    .join("\r\n");
  return Buffer.from(`${stuffed}.\r\n`, "latin1");
}

class SmtpSession {
  #socket: Socket;
  #reader: LineReader;
  constructor(socket: Socket) {
    this.#socket = socket;
    this.#reader = new LineReader(socket);
  }
  #write(s: string): void {
    this.#socket.write(Buffer.from(s, "utf8"));
  }
  async reply(): Promise<Reply> {
    const lines: string[] = [];
    for (;;) {
      const l = await this.#reader.line(4096);
      const m = /^(\d{3})([ -])(.*)$/.exec(l);
      if (!m) throw new EmailError("protocol", "malformed SMTP reply");
      lines.push(m[3]!);
      if (m[2] === " ") return { code: Number(m[1]), lines };
    }
  }
  async cmd(line: string): Promise<Reply> {
    if (/[\r\n]/.test(line)) throw new EmailError("protocol", "invalid SMTP command");
    this.#write(`${line}\r\n`);
    return this.reply();
  }
  raw(data: Buffer): void {
    this.#socket.write(data);
  }
  upgrade(next: Socket): void {
    this.#socket = next;
    this.#reader = new LineReader(next);
  }
  get readerBuffered(): number {
    return this.#reader.buffered;
  }
  detach(): Socket {
    return this.#reader.detach();
  }
  end(): void {
    this.#socket.destroy();
  }
}

function fail(r: Reply, what: string): never {
  if (r.code >= 500) throw new EmailError("permanent", `SMTP ${what} rejected`);
  throw new EmailError("temporary", `SMTP ${what} deferred`);
}

function mechanisms(ehlo: Reply): { caps: Set<string>; auth: Set<string> } {
  const caps = new Set<string>();
  const auth = new Set<string>();
  for (const l of ehlo.lines.slice(1)) {
    const [k, ...rest] = l.trim().split(/\s+/);
    if (!k) continue;
    caps.add(k.toUpperCase());
    if (k.toUpperCase() === "AUTH") for (const m of rest) auth.add(m.toUpperCase());
  }
  return { caps, auth };
}

/**
 * Opens a session: greeting, EHLO, STARTTLS (fail closed: no STARTTLS in EHLO means no credentials), EHLO again, AUTH.
 * Calls `fn` with the authenticated session and always QUITs. Connection failures are fixed-text EmailErrors.
 */
async function withSmtp<T>(o: SmtpOptions, fn: (s: SmtpSession) => Promise<T>): Promise<T> {
  let raw: Socket;
  try {
    raw = await o.connect(o.host, o.port);
  } catch {
    throw new EmailError("network", "SMTP connection failed");
  }
  let session: SmtpSession | undefined;
  try {
    let transport = raw;
    if (o.security === "tls") transport = await o.upgradeTls(raw, o.host);
    session = new SmtpSession(transport);
    const greet = await session.reply();
    if (greet.code !== 220) fail(greet, "greeting");
    let ehlo = await session.cmd(`EHLO ${o.ehloName}`);
    if (ehlo.code !== 250) fail(ehlo, "EHLO");
    if (o.security === "starttls") {
      if (!mechanisms(ehlo).caps.has("STARTTLS")) throw new EmailError("tls", "server does not offer STARTTLS; credentials not sent");
      const st = await session.cmd("STARTTLS");
      if (st.code !== 220) fail(st, "STARTTLS");
      if (session.readerBuffered > 0) throw new EmailError("protocol", "unexpected data before TLS");
      const secure = await o.upgradeTls(session.detach(), o.host);
      session.upgrade(secure);
      ehlo = await session.cmd(`EHLO ${o.ehloName}`);
      if (ehlo.code !== 250) fail(ehlo, "EHLO");
    }
    await authenticate(session, o, mechanisms(ehlo).auth);
    return await fn(session);
  } catch (e) {
    if (e instanceof EmailError) throw e;
    throw new EmailError("network", "SMTP session failed");
  } finally {
    if (session) {
      try {
        await session.cmd("QUIT");
      } catch {
        /* closing anyway */
      }
      session.end();
    } else raw.destroy();
  }
}

async function authenticate(s: SmtpSession, o: SmtpOptions, auth: Set<string>): Promise<void> {
  if (auth.has("PLAIN")) {
    const r = await s.cmd(`AUTH PLAIN ${Buffer.from(`\0${o.user}\0${o.password}`, "utf8").toString("base64")}`);
    if (r.code !== 235) throw new EmailError("auth", "SMTP authentication failed");
    return;
  }
  if (auth.has("LOGIN")) {
    const u = await s.cmd("AUTH LOGIN");
    if (u.code !== 334) throw new EmailError("auth", "SMTP authentication failed");
    const p = await s.cmd(Buffer.from(o.user, "utf8").toString("base64"));
    if (p.code !== 334) throw new EmailError("auth", "SMTP authentication failed");
    const done = await s.cmd(Buffer.from(o.password, "utf8").toString("base64"));
    if (done.code !== 235) throw new EmailError("auth", "SMTP authentication failed");
    return;
  }
  throw new EmailError("auth", "no usable SMTP authentication mechanism");
}

export interface SendOptions extends SmtpOptions {
  from: string;
  to: string;
  data: Buffer;
}

/** One message, one connection. Temporary (4xx) and network failures are retried by the caller, not here. */
export async function sendMail(o: SendOptions): Promise<void> {
  const from = checkAddrSpec(o.from);
  const to = checkAddrSpec(o.to);
  const payload = dotStuff(o.data);
  await withSmtp(o, async (s) => {
    const mf = await s.cmd(`MAIL FROM:<${from}>`);
    if (mf.code !== 250) fail(mf, "MAIL FROM");
    const rt = await s.cmd(`RCPT TO:<${to}>`);
    if (rt.code !== 250 && rt.code !== 251) fail(rt, "RCPT TO");
    const d = await s.cmd("DATA");
    if (d.code !== 354) fail(d, "DATA");
    s.raw(payload);
    const end = await s.reply();
    if (end.code !== 250) fail(end, "message");
  });
}

/** NOOP on a fresh, authenticated session. Used lazily by health checks. */
export async function smtpNoop(o: SmtpOptions): Promise<void> {
  await withSmtp(o, async (s) => {
    const r = await s.cmd("NOOP");
    if (r.code !== 250) fail(r, "NOOP");
  });
}
