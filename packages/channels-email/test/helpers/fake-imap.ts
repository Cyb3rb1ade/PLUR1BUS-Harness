import { createServer, type Server, type Socket } from "node:net";
import { EventEmitter } from "node:events";

/** In-process IMAP4rev1 subset on 127.0.0.1:0. Test-only. Passwords are invented. */
export interface FakeImapOptions {
  user: string;
  password: string;
  /** Advertise STARTTLS. */
  starttls?: boolean;
  /** When true, LOGIN/AUTHENTICATE before the client's STARTTLS is recorded as a violation and refused. */
  requireTlsBeforeAuth?: boolean;
  idle?: boolean;
  authPlain?: boolean;
  /** Allow LOGIN (default true). */
  login?: boolean;
}
export interface FakeMessage {
  uid: number;
  raw: Buffer;
  seen: boolean;
}

export class FakeImap {
  readonly opts: FakeImapOptions;
  readonly messages: FakeMessage[] = [];
  readonly commands: string[] = [];
  readonly events = new EventEmitter();
  uidValidity = 1;
  uidNext = 1;
  /** Credentials were seen by the server before TLS was in place. Must stay false. */
  credentialsBeforeTls = false;
  authenticated = 0;
  /** Next N SELECTs drop the connection without answering (reconnect tests). */
  dropOnSelect = 0;
  #server: Server | undefined;
  #sockets = new Set<Socket>();
  #conns = new Set<Conn>();
  port = 0;

  constructor(opts: FakeImapOptions) {
    this.opts = opts;
  }

  async listen(): Promise<void> {
    this.#server = createServer((s) => this.#accept(s));
    await new Promise<void>((resolve) => this.#server!.listen(0, "127.0.0.1", () => resolve()));
    this.port = (this.#server.address() as { port: number }).port;
  }

  async close(): Promise<void> {
    for (const s of this.#sockets) s.destroy();
    await new Promise<void>((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
  }

  /** Delivers a message into the mailbox and tells IDLE clients. */
  append(raw: Buffer): number {
    const uid = this.uidNext++;
    this.messages.push({ uid, raw, seen: false });
    for (const c of this.#conns) if (c.idling) c.write(`* ${this.messages.length} EXISTS\r\n`);
    return uid;
  }

  /** Simulates UIDVALIDITY change: new validity, UIDs renumbered from 1. */
  resetUidValidity(v: number): void {
    this.uidValidity = v;
    this.messages.forEach((m, i) => (m.uid = i + 1));
    this.uidNext = this.messages.length + 1;
  }

  #accept(s: Socket): void {
    s.setNoDelay(true);
    this.#sockets.add(s);
    s.on("close", () => this.#sockets.delete(s));
    s.on("error", () => {});
    const c = new Conn(this, s);
    this.#conns.add(c);
    s.on("close", () => this.#conns.delete(c));
    c.greet();
  }

  /** Called by a connection. */
  onCommand(name: string): void {
    this.commands.push(name);
  }
}

class Conn {
  readonly #fake: FakeImap;
  readonly #s: Socket;
  #buf = "";
  #tls = false;
  #pendingAuth: ((line: string) => void) | undefined;
  idling = false;
  #idleTag: string | undefined;
  #selected = false;

  constructor(fake: FakeImap, s: Socket) {
    this.#fake = fake;
    this.#s = s;
    s.on("data", (d: Buffer) => this.#data(d));
  }

  write(s: string): void {
    this.#s.write(Buffer.from(s, "utf8"));
  }

  greet(): void {
    this.write("* OK [CAPABILITY IMAP4rev1] fake ready\r\n");
  }

  #caps(): string {
    const o = this.#fake.opts;
    const caps = ["IMAP4rev1"];
    if (o.starttls && !this.#tls) caps.push("STARTTLS");
    if (o.authPlain !== false) caps.push("AUTH=PLAIN");
    if (o.login === false) caps.push("LOGINDISABLED");
    if (o.idle !== false) caps.push("IDLE");
    return caps.join(" ");
  }

  #data(d: Buffer): void {
    this.#buf += d.toString("utf8");
    for (;;) {
      const i = this.#buf.indexOf("\r\n");
      if (i < 0) return;
      const line = this.#buf.slice(0, i);
      this.#buf = this.#buf.slice(i + 2);
      this.#line(line);
    }
  }

  #line(line: string): void {
    if (this.#pendingAuth) {
      const f = this.#pendingAuth;
      this.#pendingAuth = undefined;
      f(line);
      return;
    }
    if (this.idling) {
      if (line.toUpperCase() === "DONE") {
        this.idling = false;
        this.write(`${this.#idleTag} OK IDLE terminated\r\n`);
      }
      return;
    }
    const m = /^(\S+) (\S+)(?: (.*))?$/.exec(line);
    if (!m) return this.write("* BAD\r\n");
    const [, tag, verb0, rest = ""] = m as unknown as [string, string, string, string?];
    const verb = verb0.toUpperCase();
    const f = this.#fake;
    f.onCommand(verb === "UID" ? `UID ${rest.split(" ")[0]}` : verb);
    const ok = (t: string) => this.write(`${tag} OK ${t}\r\n`);
    const no = (t: string) => this.write(`${tag} NO ${t}\r\n`);
    switch (verb) {
      case "CAPABILITY":
        this.write(`* CAPABILITY ${this.#caps()}\r\n`);
        return ok("done");
      case "NOOP":
        return ok("noop");
      case "LOGOUT":
        this.write("* BYE bye\r\n");
        return ok("logout");
      case "STARTTLS":
        if (!f.opts.starttls || this.#tls) return this.write(`${tag} BAD no starttls\r\n`);
        this.write(`${tag} OK begin TLS\r\n`);
        this.#tls = true;
        return;
      case "LOGIN": {
        if (this.#blockAuth(tag)) return;
        if (f.opts.login === false) return this.write(`${tag} NO login disabled\r\n`);
        const mm = /^"((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)"$/.exec(rest);
        if (mm && unq(mm[1]!) === f.opts.user && unq(mm[2]!) === f.opts.password) {
          f.authenticated++;
          return ok("LOGIN completed");
        }
        return no("LOGIN failed");
      }
      case "AUTHENTICATE": {
        if (this.#blockAuth(tag)) return;
        if (rest.toUpperCase() !== "PLAIN" || f.opts.authPlain === false) return this.write(`${tag} NO unsupported\r\n`);
        this.write("+ \r\n");
        this.#pendingAuth = (resp) => {
          const [, u, p] = Buffer.from(resp, "base64").toString("utf8").split("\0");
          if (u === f.opts.user && p === f.opts.password) {
            f.authenticated++;
            ok("AUTHENTICATE completed");
          } else no("AUTHENTICATE failed");
        };
        return;
      }
      case "SELECT":
        if (f.dropOnSelect > 0) {
          f.dropOnSelect--;
          this.#s.destroy();
          return;
        }
        this.#selected = true;
        this.write(`* ${f.messages.length} EXISTS\r\n`);
        this.write(`* OK [UIDVALIDITY ${f.uidValidity}] uids\r\n`);
        this.write(`* OK [UIDNEXT ${f.uidNext}] next\r\n`);
        return ok("[READ-WRITE] SELECT completed");
      case "IDLE":
        if (f.opts.idle === false) return this.write(`${tag} BAD idle unsupported\r\n`);
        this.idling = true;
        this.#idleTag = tag;
        return this.write("+ idling\r\n");
      case "UID": {
        const sub = rest.split(" ")[0]!.toUpperCase();
        const args = rest.slice(sub.length + 1);
        if (sub === "SEARCH") {
          const r = /UID (\d+):\*/i.exec(args);
          const from = r ? Number(r[1]) : 1;
          const uids = f.messages.filter((x) => x.uid >= from).map((x) => x.uid);
          this.write(`* SEARCH ${uids.join(" ")}\r\n`);
          return ok("SEARCH completed");
        }
        if (sub === "FETCH") {
          const r = /^(\d+) \((.*)\)$/.exec(args);
          const msg = r ? f.messages.find((x) => x.uid === Number(r[1])) : undefined;
          if (!msg || !r) return no("no such message");
          if (/RFC822\.SIZE/.test(r[2]!)) this.write(`* 1 FETCH (UID ${msg.uid} RFC822.SIZE ${msg.raw.length})\r\n`);
          else {
            this.write(`* 1 FETCH (UID ${msg.uid} BODY[] {${msg.raw.length}}\r\n`);
            this.#s.write(msg.raw);
            this.write(")\r\n");
          }
          return ok("FETCH completed");
        }
        if (sub === "STORE") {
          const r = /^(\d+) \+FLAGS(?:\.SILENT)? \(\\Seen\)$/i.exec(args);
          const msg = r ? f.messages.find((x) => x.uid === Number(r[1])) : undefined;
          if (!msg) return no("bad store");
          msg.seen = true;
          f.events.emit("seen", msg.uid);
          return ok("STORE completed");
        }
        return this.write(`${tag} BAD unknown UID command\r\n`);
      }
      default:
        return this.write(`${tag} BAD unknown command\r\n`);
    }
  }

  /** Refuses auth before TLS when required; records a violation otherwise. */
  #blockAuth(tag: string): boolean {
    const f = this.#fake;
    if (f.opts.requireTlsBeforeAuth && !this.#tls && f.opts.starttls) {
      f.credentialsBeforeTls = true;
      this.write(`${tag} NO TLS required\r\n`);
      return true;
    }
    if (f.opts.starttls && !this.#tls) f.credentialsBeforeTls = true;
    return false;
  }
}

function unq(s: string): string {
  return s.replace(/\\(.)/g, "$1");
}
