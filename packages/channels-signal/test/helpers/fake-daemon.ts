import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";

/** A loopback stand-in for `signal-cli daemon --tcp`: newline-delimited JSON-RPC 2.0 with scripted failures. */
export interface SentCall {
  method: string;
  params: Record<string, any>;
}

export class FakeDaemon {
  readonly calls: SentCall[] = [];
  /** Scripted errors per method, consumed in order: { code, message, data? }. */
  readonly failures: Record<string, Array<{ code: number; message: string; data?: unknown }>> = {};
  /** Accounts known to the daemon; a `send` from an unknown account fails. */
  registered = true;
  /** Attachment bytes by id (base64 returned by getAttachment). */
  readonly attachments = new Map<string, string>();
  readonly accounts = [{ number: "+4915100000001", uuid: "11111111-2222-4333-8444-555555555555" }];
  #server!: Server;
  #sockets = new Set<Socket>();
  #nextTs = 1_700_000_000_000;
  #connected: Socket | undefined;
  #buffers = new WeakMap<Socket, string>();
  port = 0;
  connections = 0;

  async listen(): Promise<void> {
    this.#server = createServer((s) => this.#onConnect(s));
    await new Promise<void>((r) => this.#server.listen(0, "127.0.0.1", r));
    this.port = (this.#server.address() as AddressInfo).port;
  }
  async close(): Promise<void> {
    this.dropConnections();
    await new Promise<void>((r) => this.#server.close(() => r()));
  }
  /** Simulates a crash: every open connection is torn down. */
  dropConnections(): void {
    for (const s of this.#sockets) s.destroy();
    this.#sockets.clear();
    this.#connected = undefined;
  }
  /** Pushes a `receive` notification to the connected client. */
  push(envelope: Record<string, unknown>, account = "+4915100000001"): void {
    this.#write({ jsonrpc: "2.0", method: "receive", params: { envelope, account } });
  }
  failNext(method: string, error: { code: number; message: string; data?: unknown }): void {
    (this.failures[method] ??= []).push(error);
  }
  callsOf(method: string): SentCall[] {
    return this.calls.filter((c) => c.method === method);
  }
  /** Sends decoded from `send`, in order. */
  sent(): Array<Record<string, any>> {
    return this.callsOf("send").map((c) => c.params);
  }
  /** Raw bytes written on the wire, for framing tests. */
  writeRaw(text: string): void {
    this.#connected?.write(text);
  }

  #onConnect(s: Socket): void {
    this.connections += 1;
    this.#sockets.add(s);
    this.#connected = s;
    this.#buffers.set(s, "");
    s.on("data", (d) => this.#onData(s, d.toString("utf8")));
    s.on("close", () => this.#sockets.delete(s));
    s.on("error", () => this.#sockets.delete(s));
  }
  #onData(s: Socket, text: string): void {
    let buf = (this.#buffers.get(s) ?? "") + text;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) this.#handle(line);
    }
    this.#buffers.set(s, buf);
  }
  #handle(line: string): void {
    let req: { id?: number; method: string; params?: Record<string, any> };
    try {
      req = JSON.parse(line);
    } catch {
      return;
    }
    const params = req.params ?? {};
    this.calls.push({ method: req.method, params });
    const fail = this.failures[req.method]?.shift();
    if (fail) return this.#reply(req.id, undefined, fail);
    if (!this.registered && req.method !== "version" && req.method !== "listAccounts")
      return this.#reply(req.id, undefined, {
        code: -32603,
        message: "NotRegisteredException: User +4915100000001 is not registered.",
      });
    switch (req.method) {
      case "version":
        return this.#reply(req.id, { version: "0.13.0-fake" });
      case "listAccounts":
        return this.#reply(req.id, this.accounts);
      case "subscribeReceive":
        return this.#reply(req.id, {});
      case "send": {
        const ts = this.#nextTs++;
        if (typeof params.message !== "string" && !Array.isArray(params.attachments))
          return this.#reply(req.id, undefined, { code: -32602, message: "invalid params" });
        return this.#reply(req.id, { timestamp: ts });
      }
      case "sendTyping":
        return this.#reply(req.id, {});
      case "getAttachment": {
        const b64 = this.attachments.get(String(params.id));
        if (b64 === undefined) return this.#reply(req.id, undefined, { code: -1, message: "attachment not found" });
        return this.#reply(req.id, { data: b64 });
      }
      default:
        return this.#reply(req.id, undefined, { code: -32601, message: "Method not found" });
    }
  }
  #reply(id: number | undefined, result?: unknown, error?: { code: number; message: string; data?: unknown }): void {
    if (id === undefined) return;
    this.#write(error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result });
  }
  #write(msg: unknown): void {
    this.#connected?.write(JSON.stringify(msg) + "\n");
  }
}

/** Builds a Signal `envelope` with a text data message from a human. */
export function textEnvelope(opts: {
  number?: string | undefined;
  uuid?: string | undefined;
  ts?: number | undefined;
  message?: string | undefined;
  groupId?: string | undefined;
  mentions?: Array<Record<string, unknown>> | undefined;
  quote?: Record<string, unknown> | undefined;
  attachments?: Array<Record<string, unknown>> | undefined;
  reaction?: Record<string, unknown> | undefined;
  viewOnce?: boolean | undefined;
  expiresInSeconds?: number | undefined;
}): Record<string, unknown> {
  const number = opts.number ?? "+4915100000002";
  return {
    source: number,
    sourceNumber: number,
    sourceUuid: opts.uuid ?? "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    sourceDevice: 1,
    timestamp: opts.ts ?? 1_700_000_000_500,
    dataMessage: {
      timestamp: opts.ts ?? 1_700_000_000_500,
      ...(opts.message !== undefined ? { message: opts.message } : {}),
      ...(opts.groupId ? { groupInfo: { groupId: opts.groupId, type: "DELIVER" } } : {}),
      ...(opts.mentions ? { mentions: opts.mentions } : {}),
      ...(opts.quote ? { quote: opts.quote } : {}),
      ...(opts.attachments ? { attachments: opts.attachments } : {}),
      ...(opts.reaction ? { reaction: opts.reaction } : {}),
      ...(opts.viewOnce ? { viewOnce: true } : {}),
      ...(opts.expiresInSeconds ? { expiresInSeconds: opts.expiresInSeconds } : {}),
    },
  };
}
