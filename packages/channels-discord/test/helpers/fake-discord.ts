import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { WebSocketLike } from "../../src/port.ts";

export const TOKEN = "FAKEBOTTOKEN_0000000000000000.FAKE01.testonly-invented-token-value-000";
export const BOT_ID = "900000000000000001";
export const APP_ID = "900000000000000001";
export const GUILD_CHANNEL = "555000000000000001";
export const DM_CHANNEL = "777000000000000001";
export const DM_USER = "111000000000000001";
export const GROUP_USER = "222000000000000001";
export const OTHER_USER = "333000000000000001";

export interface RestCall {
  method: string;
  path: string;
  auth: string | undefined;
  body: string;
  json: unknown;
  contentType: string | undefined;
}
export interface Failure {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** Loopback REST stand-in for the Discord API and its CDN. Failures are scripted per "METHOD /path-prefix", consumed in order. */
export class FakeDiscordRest {
  readonly calls: RestCall[] = [];
  readonly messages: { id: string; channelId: string; content: string; reference?: string; components?: unknown; allowedMentions?: unknown }[] = [];
  readonly edits: { channelId: string; messageId: string; content: string }[] = [];
  readonly commandSets: unknown[] = [];
  readonly interactionResponses: { id: string; token: string; body: unknown }[] = [];
  readonly webhookPatches: { token: string; body: unknown }[] = [];
  readonly cdn = new Map<string, { mime: string; data: Buffer; headers?: Record<string, string> }>();
  readonly failures: Array<{ key: string; failure: Failure }> = [];
  #server!: Server;
  #next = 1000;
  baseUrl = "";

  async listen(): Promise<void> {
    this.#server = createServer((req, res) => void this.#handle(req, res));
    await new Promise<void>((r) => this.#server.listen(0, "127.0.0.1", r));
    this.baseUrl = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }
  async close(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise<void>((r) => this.#server.close(() => r()));
  }
  fail(key: string, failure: Failure): void {
    this.failures.push({ key, failure });
  }
  callsOf(method: string, prefix = ""): RestCall[] {
    return this.calls.filter((c) => c.method === method && c.path.startsWith(prefix));
  }
  reset(): void {
    this.calls.length = 0;
    this.messages.length = 0;
    this.edits.length = 0;
    this.commandSets.length = 0;
    this.interactionResponses.length = 0;
    this.webhookPatches.length = 0;
    this.failures.length = 0;
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const path = (req.url ?? "").replace(/\?.*$/, "");
    const method = req.method ?? "GET";
    const ct = req.headers["content-type"];
    let json: unknown;
    if (typeof ct === "string" && ct.startsWith("application/json") && raw) json = JSON.parse(raw);
    if (path.startsWith("/cdn/")) return this.#cdn(path.slice(4), res);
    const call: RestCall = {
      method,
      path,
      auth: req.headers.authorization,
      body: raw,
      json,
      contentType: ct,
    };
    this.calls.push(call);
    const key = `${method} ${path}`;
    const idx = this.failures.findIndex((f) => key.startsWith(f.key));
    if (idx !== -1) {
      const [f] = this.failures.splice(idx, 1);
      return send(res, f!.failure.status, f!.failure.body ?? { message: "scripted failure", code: 0 }, f!.failure.headers);
    }
    const api = path.replace(/^\/api\/v10/, "");
    if (method === "GET" && api === "/users/@me") return send(res, 200, { id: BOT_ID, username: "testbot", bot: true });
    if (method === "PUT" && /^\/applications\/\d+\/commands$/.test(api)) {
      this.commandSets.push(json);
      return send(res, 200, json);
    }
    let m = /^\/channels\/(\d+)\/messages$/.exec(api);
    if (method === "POST" && m) {
      const payload = ct?.startsWith("multipart/")
        ? (JSON.parse(/name="payload_json"\r\n\r\n([\s\S]*?)\r\n--/.exec(raw)?.[1] ?? "{}") as Record<string, unknown>)
        : ((json ?? {}) as Record<string, unknown>);
      const id = snowflake(this.#next++);
      const ref = (payload.message_reference as { message_id?: string } | undefined)?.message_id;
      this.messages.push({
        id,
        channelId: m[1]!,
        content: typeof payload.content === "string" ? payload.content : "",
        ...(ref !== undefined ? { reference: ref } : {}),
        ...(payload.components !== undefined ? { components: payload.components } : {}),
        allowedMentions: payload.allowed_mentions,
      });
      return send(res, 200, { id, channel_id: m[1], content: payload.content ?? "" });
    }
    m = /^\/channels\/(\d+)\/messages\/(\d+)$/.exec(api);
    if (method === "PATCH" && m) {
      this.edits.push({ channelId: m[1]!, messageId: m[2]!, content: String((json as { content?: string }).content ?? "") });
      return send(res, 200, { id: m[2], channel_id: m[1] });
    }
    m = /^\/channels\/(\d+)\/typing$/.exec(api);
    if (method === "POST" && m) return send(res, 204);
    m = /^\/interactions\/(\d+)\/([^/]+)\/callback$/.exec(api);
    if (method === "POST" && m) {
      this.interactionResponses.push({ id: m[1]!, token: m[2]!, body: json });
      return send(res, 204);
    }
    m = /^\/webhooks\/(\d+)\/([^/]+)\/messages\/@original$/.exec(api);
    if (method === "PATCH" && m) {
      this.webhookPatches.push({ token: m[2]!, body: json });
      return send(res, 200, { id: "1" });
    }
    return send(res, 404, { message: "Unknown route", code: 0 });
  }

  #cdn(path: string, res: ServerResponse): void {
    const file = this.cdn.get(path);
    if (!file) return send(res, 404, { message: "no file" });
    res.writeHead(200, { "content-type": file.mime, "content-length": String(file.data.length), ...(file.headers ?? {}) });
    res.end(file.data);
  }
}

function send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
  if (status === 204 || body === undefined) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/** A scripted WebSocket. Server frames go out asynchronously (like a real socket), client frames are recorded. */
export class FakeSocket implements WebSocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly sent: Record<string, unknown>[] = [];
  closed: { code: number; reason?: string } | undefined;
  readonly gateway: FakeGateway;
  readonly url: string;
  readonly index: number;
  constructor(gateway: FakeGateway, url: string, index: number) {
    this.gateway = gateway;
    this.url = url;
    this.index = index;
  }
  send(data: string): void {
    if (this.closed) throw new Error("socket is closed");
    const frame = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(frame);
    this.gateway.frames.push({ socket: this.index, frame });
    setImmediate(() => this.gateway.onClientFrame(this, frame));
  }
  close(code = 1000, reason?: string): void {
    if (this.closed) return;
    this.closed = { code, ...(reason !== undefined ? { reason } : {}) };
    setImmediate(() => this.onclose?.({ code, ...(reason !== undefined ? { reason } : {}) }));
  }
  /** Server -> client frame (delivered synchronously so tests control ordering precisely). */
  server(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  /** The server drops the connection with a close code. */
  remoteClose(code: number): void {
    if (this.closed) return;
    this.closed = { code };
    this.onclose?.({ code });
  }
}

/** In-process gateway. `factory` is injected as `webSocket`. Handshake frames are answered automatically unless `auto` is false. */
export class FakeGateway {
  readonly sockets: FakeSocket[] = [];
  readonly urls: string[] = [];
  readonly frames: { socket: number; frame: Record<string, unknown> }[] = [];
  auto = true;
  /** Heartbeats are ACKed unless the socket index is listed here (used to simulate a zombie connection). */
  silentSockets = new Set<number>();
  heartbeatInterval = 41_250;
  sessionId = "session-1";
  resumeUrl = "wss://resume.discord.gg";
  #seq = 0;
  #readyWaiters: Array<() => void> = [];
  #ready = false;
  readonly factory = (url: string): WebSocketLike => {
    const s = new FakeSocket(this, url, this.sockets.length);
    this.sockets.push(s);
    this.urls.push(url);
    setImmediate(() => {
      s.onopen?.({});
      if (this.auto) s.server({ op: 10, d: { heartbeat_interval: this.heartbeatInterval } });
    });
    return s;
  };
  get latest(): FakeSocket {
    const s = this.sockets.at(-1);
    if (!s) throw new Error("no socket");
    return s;
  }
  nextSeq(): number {
    return ++this.#seq;
  }
  whenReady(): Promise<void> {
    if (this.#ready) return Promise.resolve();
    return new Promise((r) => this.#readyWaiters.push(r));
  }
  /** Dispatch an event on the latest socket. */
  dispatch(t: string, d: unknown, socket: FakeSocket = this.latest): void {
    socket.server({ op: 0, t, s: this.nextSeq(), d });
  }
  onClientFrame(s: FakeSocket, f: Record<string, unknown>): void {
    if (!this.auto) return;
    if (f.op === 1) {
      if (!this.silentSockets.has(s.index)) s.server({ op: 11 });
    } else if (f.op === 2) {
      s.server({
        op: 0,
        t: "READY",
        s: this.nextSeq(),
        d: {
          v: 10,
          user: { id: BOT_ID, bot: true, username: "testbot" },
          application: { id: APP_ID },
          session_id: this.sessionId,
          resume_gateway_url: this.resumeUrl,
          guilds: [],
        },
      });
      this.#markReady();
    } else if (f.op === 6) {
      s.server({ op: 0, t: "RESUMED", s: this.nextSeq(), d: {} });
      this.#markReady();
    }
  }
  #markReady(): void {
    this.#ready = true;
    for (const r of this.#readyWaiters.splice(0)) r();
  }
}

export function snowflake(n: number): string {
  return String(1_000_000_000_000_000_000n + BigInt(n));
}

/** fetch seam: Discord CDN URLs are rewritten onto the loopback stand-in; nothing else leaves the process. */
export function cdnAwareFetch(rest: FakeDiscordRest): typeof fetch {
  const real = globalThis.fetch;
  return (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === "cdn.discordapp.com") return real(`${rest.baseUrl}/cdn${url.pathname}`, init);
    return real(url, init);
  };
}
