import { createServer, type Server, type Socket } from "node:net";

/** In-process SMTP on 127.0.0.1:0 with failure injection. Test-only. Passwords are invented. */
export interface FakeSmtpOptions {
  user: string;
  password: string;
  starttls?: boolean;
  requireTlsBeforeAuth?: boolean;
}
export interface SmtpReceived {
  from: string;
  rcpt: string[];
  data: Buffer;
}
export interface FailRule {
  /** Verb (MAIL, RCPT, DATA, EHLO, AUTH, NOOP, end) */
  verb: string;
  code: number;
  times: number;
}

export class FakeSmtp {
  readonly opts: FakeSmtpOptions;
  readonly received: SmtpReceived[] = [];
  readonly commands: string[] = [];
  readonly fails: FailRule[] = [];
  credentialsBeforeTls = false;
  authenticated = 0;
  port = 0;
  #server: Server | undefined;
  #sockets = new Set<Socket>();

  constructor(opts: FakeSmtpOptions) {
    this.opts = opts;
  }

  async listen(): Promise<void> {
    this.#server = createServer((s) => {
      this.#sockets.add(s);
      s.on("close", () => this.#sockets.delete(s));
      s.on("error", () => {});
      new SmtpConn(this, s).start();
    });
    await new Promise<void>((resolve) => this.#server!.listen(0, "127.0.0.1", () => resolve()));
    this.port = (this.#server.address() as { port: number }).port;
  }

  async close(): Promise<void> {
    for (const s of this.#sockets) s.destroy();
    await new Promise<void>((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
  }

  failNext(verb: string, code: number, times = 1): void {
    this.fails.push({ verb, code, times });
  }

  /** Returns the injected failure code for this verb, consuming one use. */
  takeFail(verb: string): number | undefined {
    const r = this.fails.find((f) => f.verb === verb && f.times > 0);
    if (!r) return undefined;
    r.times--;
    return r.code;
  }
}

class SmtpConn {
  readonly #f: FakeSmtp;
  #s: Socket;
  #buf = "";
  #tls = false;
  #from = "";
  #rcpt: string[] = [];
  #inData = false;
  #data = Buffer.alloc(0);
  #authStep: "plain" | "login-user" | "login-pass" | undefined;
  #loginUser = "";

  constructor(f: FakeSmtp, s: Socket) {
    this.#f = f;
    this.#s = s;
  }

  start(): void {
    this.#s.on("data", (d: Buffer) => this.#data_(d));
    this.#write("220 fake.smtp ready");
  }

  #write(line: string): void {
    this.#s.write(Buffer.from(`${line}\r\n`, "utf8"));
  }

  #data_(d: Buffer): void {
    if (this.#inData) {
      this.#data = Buffer.concat([this.#data, d]);
      const idx = this.#data.indexOf(Buffer.from("\r\n.\r\n"));
      if (idx < 0) return;
      const body = this.#data.subarray(0, idx + 2);
      this.#data = Buffer.alloc(0);
      this.#inData = false;
      const unstuffed = body.toString("latin1").split("\r\n").map((l) => (l.startsWith("..") ? l.slice(1) : l));
      const data = Buffer.from(unstuffed.join("\r\n"), "latin1");
      const code = this.#f.takeFail("end");
      if (code) {
        this.#write(`${code} Message refused`);
        return;
      }
      this.#f.received.push({ from: this.#from, rcpt: [...this.#rcpt], data });
      this.#from = "";
      this.#rcpt = [];
      this.#write("250 2.0.0 queued");
      return;
    }
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
    const f = this.#f;
    if (this.#authStep) {
      const step = this.#authStep;
      this.#authStep = undefined;
      if (line === "*") return this.#write("501 cancelled");
      if (step === "plain") {
        const [, u, p] = Buffer.from(line, "base64").toString("utf8").split("\0");
        return this.#finishAuth(u === f.opts.user && p === f.opts.password);
      }
      if (step === "login-user") {
        this.#loginUser = Buffer.from(line, "base64").toString("utf8");
        this.#authStep = "login-pass";
        return this.#write("334 UGFzc3dvcmQ6");
      }
      const pass = Buffer.from(line, "base64").toString("utf8");
      return this.#finishAuth(this.#loginUser === f.opts.user && pass === f.opts.password);
    }
    const [rawVerb = "", ...restParts] = line.split(" ");
    const verb = rawVerb.toUpperCase();
    const rest = restParts.join(" ");
    f.commands.push(verb);
    const injected = verb === "MAIL" || verb === "RCPT" || verb === "DATA" || verb === "EHLO" || verb === "NOOP" || verb === "AUTH" ? f.takeFail(verb) : undefined;
    if (injected) return this.#write(`${injected} injected failure`);
    switch (verb) {
      case "EHLO":
        this.#write("250-fake.smtp");
        if (f.opts.starttls && !this.#tls) this.#write("250-STARTTLS");
        this.#write("250-AUTH PLAIN LOGIN");
        return this.#write("250 SIZE 26214400");
      case "STARTTLS":
        if (!f.opts.starttls || this.#tls) return this.#write("454 TLS not available");
        this.#write("220 2.0.0 ready for TLS");
        this.#tls = true;
        return;
      case "AUTH": {
        if (f.opts.requireTlsBeforeAuth && !this.#tls) {
          f.credentialsBeforeTls = false;
          return this.#write("530 5.7.0 must issue STARTTLS first");
        }
        if (f.opts.starttls && !this.#tls) f.credentialsBeforeTls = true;
        const [mech, ir] = rest.split(" ");
        if (mech?.toUpperCase() === "PLAIN") {
          if (ir) return this.#finishAuth(checkPlain(ir, f));
          this.#authStep = "plain";
          return this.#write("334 ");
        }
        if (mech?.toUpperCase() === "LOGIN") {
          this.#authStep = "login-user";
          return this.#write("334 VXNlcm5hbWU6");
        }
        return this.#write("504 unsupported");
      }
      case "MAIL": {
        const m = /^FROM:<([^>]*)>/i.exec(rest);
        if (!m) return this.#write("501 bad sender");
        this.#from = m[1]!;
        return this.#write("250 ok");
      }
      case "RCPT": {
        const m = /^TO:<([^>]*)>/i.exec(rest);
        if (!m) return this.#write("501 bad recipient");
        this.#rcpt.push(m[1]!);
        return this.#write("250 ok");
      }
      case "DATA":
        if (!this.#from || this.#rcpt.length === 0) return this.#write("503 need MAIL and RCPT");
        this.#inData = true;
        this.#data = Buffer.alloc(0);
        return this.#write("354 end with <CRLF>.<CRLF>");
      case "NOOP":
        return this.#write("250 ok");
      case "RSET":
        this.#from = "";
        this.#rcpt = [];
        return this.#write("250 ok");
      case "QUIT":
        this.#write("221 bye");
        this.#s.end();
        return;
      default:
        return this.#write("500 unrecognised");
    }
  }

  #finishAuth(ok: boolean): void {
    if (ok) {
      this.#f.authenticated++;
      this.#write("235 2.7.0 authenticated");
    } else this.#write("535 5.7.8 authentication failed");
  }
}

function checkPlain(ir: string, f: FakeSmtp): boolean {
  const [, u, p] = Buffer.from(ir, "base64").toString("utf8").split("\0");
  return u === f.opts.user && p === f.opts.password;
}
