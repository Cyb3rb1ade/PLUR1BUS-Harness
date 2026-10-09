import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { SocketEnvelope, SocketFactory, SocketLike } from "../../src/index.ts";

/** Invented credentials. They match the shape the channel validates and nothing else. */
export const FAKE_BOT_TOKEN = ["xoxb", "000000000000", "FAKEBOTTOKENFORTESTSONLY"].join("-");
export const FAKE_APP_TOKEN = ["xapp", "1", "A000000000", "FAKEAPPTOKENFORTESTSONLY"].join("-");
export const FAKE_SOCKET_URL = "wss://wss.fake-slack.test/link/?ticket=FAKE-TICKET-DO-NOT-LOG";
export const BOT_USER = "UBOT0001";
export const TEAM = "T0FAKE001";

export interface Call {
  method: string;
  body: Record<string, unknown>;
  auth: string | undefined;
}
export interface Failure {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}
export interface StoredFile {
  name: string;
  mime: string;
  data: Buffer;
  /** Serve a redirect instead of the bytes (for host-restriction tests). */
  redirect?: string;
}

type Listener = (ev: { data?: unknown }) => void;

/** In-process Socket Mode connection. Server-side helpers push frames; the client's acks are recorded in `sent`. */
export class FakeSocket implements SocketLike {
  readonly url: string;
  readonly sent: string[] = [];
  closed = false;
  #listeners = new Map<string, Set<Listener>>();
  #hello: boolean;
  constructor(url: string, autoHello: boolean) {
    this.url = url;
    this.#hello = autoHello;
  }
  /** Runs on the microtask queue after creation, like a real socket's open. */
  open(): void {
    if (this.closed) return;
    this.#emit("open", {});
    if (this.#hello) this.serverSend({ type: "hello", num_connections: 1, connection_info: { app_id: "A0FAKE" } });
  }
  addEventListener(type: "open" | "message" | "close" | "error", listener: Listener): void {
    let set = this.#listeners.get(type);
    if (!set) this.#listeners.set(type, (set = new Set()));
    set.add(listener);
  }
  send(data: string): void {
    if (this.closed) throw new Error("socket closed");
    this.sent.push(data);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.#emit("close", {}));
  }
  serverSend(frame: Record<string, unknown>): void {
    if (this.closed) return;
    this.#emit("message", { data: JSON.stringify(frame) });
  }
  serverPush(env: SocketEnvelope): void {
    this.serverSend(env as Record<string, unknown>);
  }
  /** Connection drops without a close handshake. */
  serverDrop(): void {
    if (this.closed) return;
    this.closed = true;
    this.#emit("close", {});
  }
  ackedIds(): string[] {
    return this.sent.map((s) => (JSON.parse(s) as { envelope_id: string }).envelope_id);
  }
  #emit(type: string, ev: { data?: unknown }): void {
    for (const l of [...(this.#listeners.get(type) ?? [])]) l(ev);
  }
}

/** Fake Slack: Web API over loopback HTTP plus an in-process Socket Mode hub. No network beyond 127.0.0.1. */
export class FakeSlack {
  readonly calls: Call[] = [];
  readonly files = new Map<string, StoredFile>();
  readonly uploads = new Map<string, Buffer>();
  readonly sockets: FakeSocket[] = [];
  readonly failures: Record<string, Failure[]> = {};
  /** Whether new sockets send hello on open. */
  autoHello = true;
  /** Overrides for auth.test (e.g. a different team). */
  authTeam = TEAM;
  root = "";
  baseUrl = "";
  #server!: Server;
  #ts = 1_700_000_000;
  #seq = 0;

  async listen(): Promise<void> {
    this.#server = createServer((req, res) => void this.#handle(req, res));
    await new Promise<void>((r) => this.#server.listen(0, "127.0.0.1", r));
    const port = (this.#server.address() as AddressInfo).port;
    this.root = `http://127.0.0.1:${port}`;
    this.baseUrl = `${this.root}/api`;
  }

  #closed = false;
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const s of this.sockets) s.close();
    this.#server.closeAllConnections();
    await new Promise<void>((r) => this.#server.close(() => r()));
  }

  /** The socket factory the channel is given. Each socket opens on the next microtask. */
  readonly webSocket: SocketFactory = (url: string) => {
    const s = new FakeSocket(url, this.autoHello);
    this.sockets.push(s);
    queueMicrotask(() => s.open());
    return s;
  };

  latest(): FakeSocket {
    const open = this.sockets.filter((s) => !s.closed);
    const s = open.at(-1);
    if (!s) throw new Error("no open fake socket");
    return s;
  }

  push(env: SocketEnvelope): void {
    this.latest().serverPush(env);
  }

  nextTs(): string {
    this.#ts += 1;
    return `${this.#ts}.000100`;
  }

  failNext(method: string, status: number, body?: unknown, headers?: Record<string, string>): void {
    (this.failures[method] ??= []).push({ status, ...(body !== undefined ? { body } : {}), ...(headers ? { headers } : {}) });
  }

  callsOf(method: string): Call[] {
    return this.calls.filter((c) => c.method === method);
  }

  postedTexts(): string[] {
    return this.calls
      .filter((c) => c.method === "chat.postMessage" || c.method === "chat.update")
      .map((c) => String(c.body.text ?? ""));
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const url = req.url ?? "";
    const auth = req.headers.authorization;
    if (url.startsWith("/upload/v1/")) {
      this.uploads.set(url.slice("/upload/v1/".length), Buffer.concat(chunks));
      res.writeHead(200, { "content-type": "text/plain" });
      return void res.end("OK");
    }
    if (url.startsWith("/files/")) {
      const f = this.files.get(url.slice("/files/".length));
      if (auth !== `Bearer ${FAKE_BOT_TOKEN}`) {
        res.writeHead(401);
        return void res.end();
      }
      if (!f) {
        res.writeHead(404);
        return void res.end();
      }
      if (f.redirect) {
        res.writeHead(302, { location: f.redirect });
        return void res.end();
      }
      res.writeHead(200, { "content-type": f.mime, "content-length": String(f.data.length) });
      return void res.end(f.data);
    }
    const m = /^\/api\/([\w.]+)$/.exec(url);
    if (!m) {
      res.writeHead(404);
      return void res.end();
    }
    const method = m[1]!;
    const raw = Buffer.concat(chunks).toString("utf8");
    const body: Record<string, unknown> = /^application\/x-www-form-urlencoded/.test(req.headers["content-type"] ?? "")
      ? Object.fromEntries(new URLSearchParams(raw))
      : raw
        ? (JSON.parse(raw) as Record<string, unknown>)
        : {};
    this.calls.push({ method, body, auth });
    const fail = this.failures[method]?.shift();
    if (fail) {
      res.writeHead(fail.status, { "content-type": "application/json", ...(fail.headers ?? {}) });
      return void res.end(typeof fail.body === "string" ? fail.body : JSON.stringify(fail.body ?? { ok: false, error: "fake_failure" }));
    }
    const wantToken = method === "apps.connections.open" ? FAKE_APP_TOKEN : FAKE_BOT_TOKEN;
    if (auth !== `Bearer ${wantToken}`) return this.#json(res, { ok: false, error: "invalid_auth" });
    switch (method) {
      case "auth.test":
        return this.#json(res, { ok: true, url: "https://fake.slack.test/", team: "fake", team_id: this.authTeam, user: "fakebot", user_id: BOT_USER, bot_id: "B0FAKE01" });
      case "apps.connections.open":
        return this.#json(res, { ok: true, url: FAKE_SOCKET_URL });
      case "chat.postMessage": {
        const ts = this.nextTs();
        return this.#json(res, { ok: true, channel: body.channel, ts, message: { text: body.text, ts } });
      }
      case "chat.update":
        return this.#json(res, { ok: true, channel: body.channel, ts: body.ts, text: body.text });
      case "chat.postEphemeral":
        return this.#json(res, { ok: true, message_ts: this.nextTs() });
      case "files.getUploadURLExternal": {
        const id = `up${++this.#seq}`;
        return this.#json(res, { ok: true, upload_url: `${this.root}/upload/v1/${id}`, file_id: `F${id.toUpperCase()}` });
      }
      case "files.completeUploadExternal":
        return this.#json(res, { ok: true, files: body.files });
      default:
        return this.#json(res, { ok: false, error: "unknown_method" });
    }
  }

  #json(res: ServerResponse, value: unknown): void {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  }
}

let eventSeq = 0;
/** events_api envelope carrying one event. */
export function eventsApi(event: Record<string, unknown>, extra: { eventId?: string; retry?: number } = {}): SocketEnvelope {
  const eventId = extra.eventId ?? `Ev${++eventSeq}`;
  return {
    envelope_id: `env-${eventId}`,
    type: "events_api",
    accepts_response_payload: false,
    retry_attempt: extra.retry ?? 0,
    retry_reason: "",
    payload: { token: "verification-unused", team_id: TEAM, api_app_id: "A0FAKE", type: "event_callback", event_id: eventId, event_time: 1_700_000_000, event },
  };
}

export function message(fields: {
  channel: string;
  user: string;
  text: string;
  ts?: string;
  channelType?: "im" | "channel" | "group" | "mpim";
  threadTs?: string;
  files?: unknown[];
  subtype?: string;
  botId?: string;
  eventId?: string;
}): SocketEnvelope {
  const event: Record<string, unknown> = {
    type: "message",
    channel: fields.channel,
    channel_type: fields.channelType ?? (fields.channel.startsWith("D") ? "im" : "channel"),
    user: fields.user,
    text: fields.text,
    ts: fields.ts ?? "1700000100.000200",
    ...(fields.threadTs !== undefined ? { thread_ts: fields.threadTs } : {}),
    ...(fields.files !== undefined ? { files: fields.files } : {}),
    ...(fields.subtype !== undefined ? { subtype: fields.subtype } : {}),
    ...(fields.botId !== undefined ? { bot_id: fields.botId } : {}),
  };
  return eventsApi(event, fields.eventId !== undefined ? { eventId: fields.eventId } : {});
}

export function appMention(fields: { channel: string; user: string; text: string; ts: string; eventId?: string }): SocketEnvelope {
  return eventsApi(
    { type: "app_mention", channel: fields.channel, user: fields.user, text: fields.text, ts: fields.ts },
    fields.eventId !== undefined ? { eventId: fields.eventId } : {},
  );
}

export function blockAction(fields: {
  user: string;
  channel: string;
  messageTs: string;
  actionId: string;
  threadTs?: string;
  envelopeId?: string;
}): SocketEnvelope {
  return {
    envelope_id: fields.envelopeId ?? `env-act-${++eventSeq}`,
    type: "interactive",
    accepts_response_payload: false,
    payload: {
      type: "block_actions",
      user: { id: fields.user },
      channel: { id: fields.channel },
      message: { ts: fields.messageTs, ...(fields.threadTs !== undefined ? { thread_ts: fields.threadTs } : {}) },
      actions: [{ action_id: fields.actionId, type: "button", value: "" }],
      trigger_id: `trig-${++eventSeq}`,
      response_url: "https://hooks.slack.test/actions/FAKE",
    },
  };
}

export function slash(fields: { user: string; channel: string; text: string; channelName?: string }): SocketEnvelope {
  return {
    envelope_id: `env-slash-${++eventSeq}`,
    type: "slash_commands",
    accepts_response_payload: true,
    payload: {
      command: "/plur1bus",
      text: fields.text,
      user_id: fields.user,
      channel_id: fields.channel,
      channel_name: fields.channelName ?? "directmessage",
      team_id: TEAM,
      response_url: "https://hooks.slack.test/commands/FAKE",
      trigger_id: `trig-${++eventSeq}`,
    },
  };
}

/** Standard test wiring: allowlisted group C0FAKE01, DM human UHUMAN01, bot UBOT0001, invented tokens in a fake secret store. */
export const TEST_SECRETS: Record<string, string> = {
  "slack-bot-token": FAKE_BOT_TOKEN,
  "slack-app-token": FAKE_APP_TOKEN,
};
export const TEST_CONFIG = {
  botTokenSecret: "slack-bot-token",
  appTokenSecret: "slack-app-token",
  allowlist: ["C0FAKE01", "G0GROUP1"],
  dmAllowlist: ["UHUMAN01"],
};
export const quietSleep = async (): Promise<void> => {};
