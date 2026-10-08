import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

export type EmailErrorKind =
  | "auth"
  | "tls"
  | "protocol"
  | "network"
  | "timeout"
  | "temporary"
  | "permanent"
  | "state"
  | "unavailable";

/** Fixed-text errors only. Never built from server replies, commands or credentials. */
export class EmailError extends Error {
  readonly kind: EmailErrorKind;
  constructor(kind: EmailErrorKind, message: string) {
    super(message);
    this.kind = kind;
    this.name = "EmailError";
  }
}

/** Test seam: opens a plaintext TCP connection. Production uses node:net. Never derived from inbound input. */
export type ConnectFn = (host: string, port: number) => Promise<Socket>;
/** Test seam: upgrades an existing socket to TLS with certificate verification. Production uses node:tls. */
export type UpgradeTlsFn = (socket: Socket, servername: string) => Promise<Socket>;

const CONNECT_TIMEOUT_MS = 30_000;
const IO_TIMEOUT_MS = 120_000;

export const defaultConnect: ConnectFn = (host, port) =>
  new Promise<Socket>((resolve, reject) => {
    const s = netConnect({ host, port });
    s.setTimeout(CONNECT_TIMEOUT_MS, () => s.destroy());
    s.once("error", () => reject(new EmailError("network", "connection failed")));
    s.once("connect", () => {
      s.setTimeout(IO_TIMEOUT_MS, () => s.destroy());
      s.removeAllListeners("error");
      s.on("error", () => {});
      resolve(s);
    });
  });

export const defaultUpgradeTls: UpgradeTlsFn = (socket, servername) =>
  new Promise<Socket>((resolve, reject) => {
    const t = tlsConnect({ socket, servername, minVersion: "TLSv1.2" });
    t.setTimeout(IO_TIMEOUT_MS, () => t.destroy());
    t.once("error", () => reject(new EmailError("tls", "TLS handshake failed")));
    t.once("secureConnect", () => {
      if (!t.authorized) {
        t.destroy();
        reject(new EmailError("tls", "TLS certificate not trusted"));
        return;
      }
      t.removeAllListeners("error");
      t.on("error", () => {});
      resolve(t);
    });
  });

/** Byte-accurate reader over a socket. Only one pending read at a time (the protocols are sequential). */
export class LineReader {
  #socket: Socket;
  #buf: Buffer = Buffer.alloc(0);
  #wake: (() => void) | undefined;
  #closed = false;
  readonly #onData = (c: Buffer): void => {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, c]) : c;
    this.#notify();
  };
  readonly #onEnd = (): void => {
    this.#closed = true;
    this.#notify();
  };
  constructor(socket: Socket) {
    this.#socket = socket;
    socket.on("data", this.#onData);
    socket.on("close", this.#onEnd);
    socket.on("end", this.#onEnd);
    socket.on("error", this.#onEnd);
  }
  get socket(): Socket {
    return this.#socket;
  }
  get buffered(): number {
    return this.#buf.length;
  }
  /** Removes listeners and returns the same socket (for TLS upgrade). Fails if unconsumed bytes exist. */
  detach(): Socket {
    this.#socket.off("data", this.#onData);
    this.#socket.off("close", this.#onEnd);
    this.#socket.off("end", this.#onEnd);
    this.#socket.off("error", this.#onEnd);
    return this.#socket;
  }
  #notify(): void {
    const w = this.#wake;
    this.#wake = undefined;
    w?.();
  }
  async #until(pred: () => boolean): Promise<void> {
    while (!pred()) {
      if (this.#closed) throw new EmailError("network", "connection closed");
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }
  /** One line without CRLF, decoded as UTF-8. Bounded by `max` bytes. */
  async line(max = 65_536): Promise<string> {
    await this.#until(() => this.#buf.indexOf("\r\n") >= 0 || this.#buf.length > max);
    const i = this.#buf.indexOf("\r\n");
    if (i < 0 || i > max) throw new EmailError("protocol", "line too long");
    const line = this.#buf.subarray(0, i).toString("utf8");
    this.#buf = this.#buf.subarray(i + 2);
    return line;
  }
  async bytes(n: number): Promise<Buffer> {
    await this.#until(() => this.#buf.length >= n);
    const out = Buffer.from(this.#buf.subarray(0, n));
    this.#buf = this.#buf.subarray(n);
    return out;
  }
}
