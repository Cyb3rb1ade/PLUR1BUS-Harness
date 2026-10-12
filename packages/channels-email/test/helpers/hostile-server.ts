import { createServer, type Server, type Socket } from "node:net";

/**
 * In-process servers that say hostile things: refusals that echo the credentials back, resets, garbage. Test-only, 127.0.0.1:0.
 * They speak just enough IMAP and SMTP to get a client from the greeting to the point a scenario wants to break. STARTTLS is
 * "accepted" without any TLS, because the tests inject an identity upgrade (see test/helpers/contract.ts).
 */

/** One accepted client. */
export interface HostileConn {
  /** Writes exactly these bytes; the caller supplies the line endings. */
  send(data: string | Uint8Array): void;
  /** Closes the connection with a FIN. */
  end(): void;
  /** Aborts the connection with an RST where the platform allows it. */
  reset(): void;
}

/** Per-connection behaviour: `start` runs on accept, `line` once per CRLF-terminated client line. */
export interface ConnBehaviour {
  start?(conn: HostileConn): void;
  line(line: string, conn: HostileConn): void;
}

export class HostileServer {
  port = 0;
  /** Everything this server wrote, as latin1 text, in order. Proves that a hostile text really was on the wire. */
  readonly sent: string[] = [];
  readonly #make: () => ConnBehaviour;
  readonly #sockets = new Set<Socket>();
  #server: Server | undefined;

  constructor(make: () => ConnBehaviour) {
    this.#make = make;
  }

  async listen(): Promise<void> {
    const server = createServer((s) => this.#accept(s));
    this.#server = server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    this.port = (server.address() as { port: number }).port;
  }

  async close(): Promise<void> {
    for (const s of this.#sockets) s.destroy();
    const server = this.#server;
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  }

  /** Everything written so far, joined. */
  text(): string {
    return this.sent.join("");
  }

  #accept(s: Socket): void {
    s.setNoDelay(true);
    this.#sockets.add(s);
    s.on("close", () => this.#sockets.delete(s));
    s.on("error", () => {});
    const conn: HostileConn = {
      send: (data) => {
        const b = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
        this.sent.push(b.toString("latin1"));
        s.write(b);
      },
      end: () => void s.end(),
      reset: () => void (typeof s.resetAndDestroy === "function" ? s.resetAndDestroy() : s.destroy()),
    };
    const behaviour = this.#make();
    let buf = "";
    s.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      for (;;) {
        const i = buf.indexOf("\r\n");
        if (i < 0) return;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        behaviour.line(line, conn);
      }
    });
    behaviour.start?.(conn);
  }
}

/** Credentials as the server decoded them from the wire. */
export interface Creds {
  user: string;
  password: string;
}

export interface ImapCmd {
  tag: string;
  verb: string;
  rest: string;
}
export interface ImapScript {
  /** Bytes sent on connect, including the CRLF. Default: an OK greeting. */
  greeting?: string | Uint8Array;
  /** Replaces the greeting entirely (to reset or stay silent). */
  onConnect?(conn: HostileConn): void;
  /** Capability list. Default `IMAP4rev1 STARTTLS AUTH=PLAIN`; leave AUTH=PLAIN out to make the client use LOGIN. */
  caps?: string;
  /** Reply to presented credentials (AUTHENTICATE PLAIN response or LOGIN). Default: tagged NO. */
  onCredentials?(creds: Creds, tag: string, conn: HostileConn): void;
  /** First look at every command; return true when handled. `creds` are the last credentials presented. */
  intercept?(cmd: ImapCmd, conn: HostileConn, creds: Creds | undefined): boolean;
}

const unq = (s: string): string => s.replace(/\\(.)/g, "$1");
const decode = (b64: string): string => Buffer.from(b64, "base64").toString("utf8");

export function imapServer(s: ImapScript = {}): HostileServer {
  const caps = s.caps ?? "IMAP4rev1 STARTTLS AUTH=PLAIN";
  return new HostileServer(() => {
    let waiting: string | undefined;
    let creds: Creds | undefined;
    const presented = (c: Creds, tag: string, conn: HostileConn): void => {
      creds = c;
      if (s.onCredentials) s.onCredentials(c, tag, conn);
      else conn.send(`${tag} NO login failed\r\n`);
    };
    return {
      start: (conn) => {
        if (s.onConnect) s.onConnect(conn);
        else conn.send(s.greeting ?? "* OK hostile imap ready\r\n");
      },
      line: (line, conn) => {
        if (waiting !== undefined) {
          const tag = waiting;
          waiting = undefined;
          const [, user = "", password = ""] = decode(line).split("\0");
          presented({ user, password }, tag, conn);
          return;
        }
        const m = /^(\S+) (\S+)(?: (.*))?$/.exec(line);
        if (!m) {
          conn.send("* BAD unparseable\r\n");
          return;
        }
        const tag = m[1]!;
        const verb = m[2]!.toUpperCase();
        const rest = m[3] ?? "";
        if (s.intercept?.({ tag, verb, rest }, conn, creds)) return;
        switch (verb) {
          case "CAPABILITY":
            conn.send(`* CAPABILITY ${caps}\r\n${tag} OK done\r\n`);
            return;
          case "STARTTLS":
            conn.send(`${tag} OK begin TLS\r\n`);
            return;
          case "AUTHENTICATE":
            waiting = tag;
            conn.send("+ \r\n");
            return;
          case "LOGIN": {
            const q = /^"((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)"$/.exec(rest);
            presented({ user: unq(q?.[1] ?? ""), password: unq(q?.[2] ?? "") }, tag, conn);
            return;
          }
          case "SELECT":
            conn.send(`* 0 EXISTS\r\n* OK [UIDVALIDITY 1] uids\r\n* OK [UIDNEXT 1] next\r\n${tag} OK [READ-WRITE] SELECT completed\r\n`);
            return;
          case "LOGOUT":
            conn.send(`* BYE bye\r\n${tag} OK logout\r\n`);
            conn.end();
            return;
          default:
            conn.send(`${tag} OK\r\n`);
        }
      },
    };
  });
}

export interface SmtpCmd {
  /** Upper-case command verb, or `END` for the end of the message data. */
  verb: string;
  rest: string;
}
export interface SmtpScript {
  /** Bytes sent on connect, including the CRLF. Default: `220` greeting. */
  greeting?: string | Uint8Array;
  /** Replaces the greeting entirely (to reset or stay silent). */
  onConnect?(conn: HostileConn): void;
  /** The one AUTH mechanism advertised. Default PLAIN. */
  auth?: "PLAIN" | "LOGIN";
  /** Reply to presented credentials. Default: 535. */
  onCredentials?(creds: Creds, conn: HostileConn): void;
  /** First look at every command (and the end of the data as verb END); return true when handled. */
  intercept?(cmd: SmtpCmd, conn: HostileConn, creds: Creds | undefined): boolean;
}

export function smtpServer(s: SmtpScript = {}): HostileServer {
  const mech = s.auth ?? "PLAIN";
  return new HostileServer(() => {
    let step: "user" | "pass" | undefined;
    let user = "";
    let creds: Creds | undefined;
    let inData = false;
    const presented = (c: Creds, conn: HostileConn): void => {
      creds = c;
      if (s.onCredentials) s.onCredentials(c, conn);
      else conn.send("535 5.7.8 authentication failed\r\n");
    };
    return {
      start: (conn) => {
        if (s.onConnect) s.onConnect(conn);
        else conn.send(s.greeting ?? "220 hostile.test ready\r\n");
      },
      line: (line, conn) => {
        if (inData) {
          if (line === ".") {
            inData = false;
            if (!s.intercept?.({ verb: "END", rest: "" }, conn, creds)) conn.send("250 2.0.0 queued\r\n");
          }
          return;
        }
        if (step === "user") {
          user = decode(line);
          step = "pass";
          conn.send("334 UGFzc3dvcmQ6\r\n");
          return;
        }
        if (step === "pass") {
          step = undefined;
          presented({ user, password: decode(line) }, conn);
          return;
        }
        const sp = line.indexOf(" ");
        const verb = (sp < 0 ? line : line.slice(0, sp)).toUpperCase();
        const rest = sp < 0 ? "" : line.slice(sp + 1);
        if (s.intercept?.({ verb, rest }, conn, creds)) return;
        switch (verb) {
          case "EHLO":
            conn.send(`250-hostile.test\r\n250-STARTTLS\r\n250 AUTH ${mech}\r\n`);
            return;
          case "STARTTLS":
            conn.send("220 2.0.0 ready for TLS\r\n");
            return;
          case "AUTH": {
            const [m, ir] = rest.split(" ");
            if (mech === "PLAIN" && m?.toUpperCase() === "PLAIN" && ir) {
              const [, u = "", p = ""] = decode(ir).split("\0");
              presented({ user: u, password: p }, conn);
            } else if (mech === "LOGIN" && m?.toUpperCase() === "LOGIN") {
              step = "user";
              conn.send("334 VXNlcm5hbWU6\r\n");
            } else conn.send("504 unsupported\r\n");
            return;
          }
          case "MAIL":
          case "RCPT":
          case "RSET":
          case "NOOP":
            conn.send("250 ok\r\n");
            return;
          case "DATA":
            inData = true;
            conn.send("354 go ahead\r\n");
            return;
          case "QUIT":
            conn.send("221 bye\r\n");
            conn.end();
            return;
          default:
            conn.send("500 unrecognised\r\n");
        }
      },
    };
  });
}
