import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { MatrixEvent } from "../../src/events.ts";

/** Invented token, shaped like a Matrix access token for the redaction tests. Not a credential. */
export const FAKE_TOKEN = "syt_Zm9ybWF0cml4X2Zha2VfdG9rZW5fZm9yX3Rlc3Rz_0a1b2c3d4";
export const BOT = "@bot:hs.test";
export const BOT_DEVICE = "BOTDEVICE";
export const ALICE = "@alice:hs.test"; // in dmAllowlist
export const CAROL = "@carol:hs.test"; // ordinary group member, not allowlisted
export const ROOM = "!room:hs.test"; // allowlisted group room
export const DM = "!dm:hs.test"; // direct room with alice (m.direct)
export const OTHER = "!other:hs.test"; // not allowlisted

export interface Call {
  method: string;
  path: string;
  body?: unknown;
  since?: string | null;
  contentType?: string;
}
export interface Sent {
  roomId: string;
  type: string;
  content: Record<string, unknown>;
  eventId: string;
  txnId: string;
}
interface RoomEntry {
  members: number;
  encrypted: boolean;
  history: MatrixEvent[];
  stateSent: boolean;
}
interface Batch {
  join: Map<string, MatrixEvent[]>;
  invite: Map<string, MatrixEvent[]>;
}
export interface Failure {
  method: string;
  prefix: string;
  status: number;
  body: Record<string, unknown>;
}

/**
 * In-process loopback Client-Server API stand-in. `/sync` is a real long poll: it holds the request until a batch is queued
 * or the `timeout` elapses. `waitIdle()` resolves once the client has processed everything queued (it is holding a poll
 * again), which is how tests stay deterministic without wall-clock sleeps.
 */
export class FakeMatrix {
  readonly calls: Call[] = [];
  readonly sent: Sent[] = [];
  readonly redactions: string[] = [];
  readonly joins: string[] = [];
  readonly leaves: string[] = [];
  readonly typing: { roomId: string; typing: boolean }[] = [];
  readonly uploads: { mime: string; filename: string; size: number }[] = [];
  readonly failures: Failure[] = [];
  readonly media = new Map<string, { data: Buffer; mime: string }>();
  /** Account data `m.direct`: mxid -> room ids. */
  direct: Record<string, string[]> = {};
  /** Set false to make the v1 authenticated media endpoint answer M_UNRECOGNIZED. */
  authenticatedMedia = true;
  /** Set true to make every request answer 401 M_UNKNOWN_TOKEN (revoked token). */
  revoked = false;
  displayname: string | undefined = "Bot Display";
  /** Whoami answer override (e.g. to simulate a mismatched account). */
  whoamiUserId = BOT;
  readonly rooms = new Map<string, RoomEntry>();
  readonly syncs: { since: string | null; timeout: number; filter: string | null }[] = [];
  baseUrl = "";
  #server!: Server;
  #queue: Batch[] = [];
  #held: { res: ServerResponse; timer?: ReturnType<typeof setTimeout> } | undefined = undefined;
  #seq = 1;
  #evSeq = 1;
  #mediaSeq = 1;
  #txns = new Map<string, string>();
  #initialServed = false;

  async listen(): Promise<void> {
    this.#server = createServer((req, res) => void this.#handle(req, res));
    await new Promise<void>((r) => this.#server.listen(0, "127.0.0.1", r));
    this.baseUrl = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    if (this.#held) {
      clearTimeout(this.#held.timer);
      this.#held.res.end();
      this.#held = undefined;
    }
    this.#server.closeAllConnections();
    await new Promise<void>((r) => this.#server.close(() => r()));
  }

  /** Make a room known to the bot: it is joined, has a member count, and may carry history and encryption. */
  addRoom(roomId: string, opts: { members?: number; encrypted?: boolean } = {}): void {
    this.rooms.set(roomId, { members: opts.members ?? 3, encrypted: opts.encrypted ?? false, history: [], stateSent: false });
  }

  /** Old events the first (initial) sync must discard. */
  addHistory(roomId: string, sender: string, content: Record<string, unknown>): void {
    this.#room(roomId).history.push(this.#event(roomId, "m.room.message", sender, content));
  }

  message(roomId: string, sender: string, content: Record<string, unknown>, eventId?: string): MatrixEvent {
    return this.#event(roomId, "m.room.message", sender, content, eventId);
  }

  reaction(roomId: string, sender: string, target: string, key: string): MatrixEvent {
    return this.#event(roomId, "m.reaction", sender, {
      "m.relates_to": { rel_type: "m.annotation", event_id: target, key },
    });
  }

  /** Queues a batch of timeline events for a joined room and waits until the client has processed it. */
  async deliver(roomId: string, events: MatrixEvent[]): Promise<void> {
    const b: Batch = { join: new Map([[roomId, events]]), invite: new Map() };
    this.#queue.push(b);
    this.#flush();
    await this.waitIdle();
  }

  /** Like `deliver`, but does not wait: for tests where the client is expected to stop (fatal errors). */
  deliverNoWait(roomId: string, events: MatrixEvent[]): void {
    this.#queue.push({ join: new Map([[roomId, events]]), invite: new Map() });
    this.#flush();
  }

  async deliverInvite(roomId: string, inviter: string, isDirect = false): Promise<void> {
    const member: MatrixEvent = {
      type: "m.room.member",
      event_id: `$inv${this.#evSeq++}`,
      sender: inviter,
      state_key: BOT,
      content: { membership: "invite", ...(isDirect ? { is_direct: true } : {}) },
    };
    this.#queue.push({ join: new Map(), invite: new Map([[roomId, [member]]]) });
    this.#flush();
    await this.waitIdle();
  }

  /** Resolves once the client is parked on a poll with nothing queued: every delivered batch has been handled. */
  async waitIdle(timeoutMs = 5000): Promise<void> {
    const t0 = Date.now();
    while (!(this.#queue.length === 0 && this.#held !== undefined)) {
      if (Date.now() - t0 > timeoutMs) throw new Error("fake matrix: client did not go idle");
      await new Promise((r) => setTimeout(r, 2));
    }
  }

  failNext(method: string, prefix: string, status: number, body: Record<string, unknown>): void {
    this.failures.push({ method, prefix, status, body });
  }

  callsTo(method: string, pathPrefix: string): Call[] {
    return this.calls.filter((c) => c.method === method && c.path.startsWith(pathPrefix));
  }

  #room(roomId: string): RoomEntry {
    let r = this.rooms.get(roomId);
    if (!r) {
      r = { members: 3, encrypted: false, history: [], stateSent: false };
      this.rooms.set(roomId, r);
    }
    return r;
  }

  #event(roomId: string, type: string, sender: string, content: Record<string, unknown>, eventId?: string): MatrixEvent {
    void roomId;
    return { type, sender, event_id: eventId ?? `$evt${this.#evSeq++}`, origin_server_ts: Date.now(), content };
  }

  #flush(): void {
    if (!this.#held || this.#queue.length === 0) return;
    const { res, timer } = this.#held;
    clearTimeout(timer);
    this.#held = undefined;
    this.#respond(res, this.#merged(), false);
  }

  #merged(): { next_batch: string; rooms: Record<string, unknown>; account_data: unknown } {
    const join = new Map<string, MatrixEvent[]>();
    const invite = new Map<string, MatrixEvent[]>();
    for (const b of this.#queue) {
      for (const [r, ev] of b.join) join.set(r, [...(join.get(r) ?? []), ...ev]);
      for (const [r, ev] of b.invite) invite.set(r, [...(invite.get(r) ?? []), ...ev]);
    }
    this.#queue = [];
    return { next_batch: `s${++this.#seq}`, rooms: this.#rooms(join, invite, false), account_data: this.#accountData() };
  }

  #accountData(): unknown {
    return { events: [{ type: "m.direct", content: this.direct }] };
  }

  #rooms(join: Map<string, MatrixEvent[]>, invite: Map<string, MatrixEvent[]>, initial: boolean): Record<string, unknown> {
    const joinOut: Record<string, unknown> = {};
    const roomIds = new Set<string>([...join.keys()]);
    if (initial) for (const r of this.rooms.keys()) roomIds.add(r);
    for (const roomId of roomIds) {
      const entry = this.#room(roomId);
      const state: MatrixEvent[] = [];
      if (entry.encrypted && (initial || !entry.stateSent)) {
        state.push({ type: "m.room.encryption", state_key: "", sender: BOT, content: { algorithm: "m.megolm.v1.aes-sha2" } });
        entry.stateSent = true;
      }
      const timeline = [...(initial ? entry.history : []), ...(join.get(roomId) ?? [])];
      if (initial) entry.history = [];
      joinOut[roomId] = {
        timeline: { events: timeline, limited: false, prev_batch: "p" },
        state: { events: state },
        summary: { "m.joined_member_count": entry.members },
      };
    }
    const inviteOut: Record<string, unknown> = {};
    for (const [roomId, ev] of invite) inviteOut[roomId] = { invite_state: { events: ev } };
    return { join: joinOut, invite: inviteOut, leave: {} };
  }

  #respond(res: ServerResponse, body: unknown, _x: boolean): void {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  #json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url ?? "/", "http://x");
    const path = decodeURI(url.pathname);
    const method = req.method ?? "GET";
    const contentType = req.headers["content-type"];
    let body: unknown = undefined;
    if (raw.length && contentType?.includes("json")) {
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        return this.#json(res, 400, { errcode: "M_NOT_JSON", error: "bad json" });
      }
    }
    this.calls.push({
      method,
      path: url.pathname,
      ...(body !== undefined ? { body } : {}),
      ...(path.includes("/sync") ? { since: url.searchParams.get("since") } : {}),
      ...(contentType ? { contentType } : {}),
    });
    if (path.startsWith("/_matrix/client/v3/sync")) {
      this.syncs.push({ since: url.searchParams.get("since"), timeout: Number(url.searchParams.get("timeout") ?? 0), filter: url.searchParams.get("filter") });
    }
    if (this.revoked || req.headers.authorization !== `Bearer ${FAKE_TOKEN}`) {
      if (!path.startsWith("/_matrix/client/v1/media") && !path.startsWith("/_matrix/media/v3/download"))
        return this.#json(res, 401, { errcode: "M_UNKNOWN_TOKEN", error: "Unrecognised access token" });
      if (this.revoked) return this.#json(res, 401, { errcode: "M_UNKNOWN_TOKEN", error: "Unrecognised access token" });
    }
    const fi = this.failures.findIndex((f) => f.method === method && path.startsWith(f.prefix));
    if (fi >= 0) {
      const [f] = this.failures.splice(fi, 1);
      return this.#json(res, f!.status, f!.body);
    }

    if (method === "GET" && path === "/_matrix/client/v3/account/whoami")
      return this.#json(res, 200, { user_id: this.whoamiUserId, device_id: BOT_DEVICE });

    if (method === "GET" && path === "/_matrix/client/v3/sync") return this.#sync(req, res, url);

    const room = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/(join|leave|send\/[^/]+\/[^/]+|redact\/[^/]+\/[^/]+|typing\/[^/]+)$/.exec(path);
    if (room && method === "POST" && room[2] === "join") {
      this.joins.push(decodeURIComponent(room[1]!));
      this.addRoom(decodeURIComponent(room[1]!));
      this.rooms.get(decodeURIComponent(room[1]!))!.stateSent = false;
      return this.#json(res, 200, { room_id: room[1] });
    }
    if (room && method === "POST" && room[2] === "leave") {
      this.leaves.push(decodeURIComponent(room[1]!));
      return this.#json(res, 200, {});
    }
    if (room && method === "PUT" && room[2]!.startsWith("send/")) {
      const [, type, txn] = room[2]!.split("/");
      const roomId = decodeURIComponent(room[1]!);
      if (!this.rooms.has(roomId)) return this.#json(res, 403, { errcode: "M_FORBIDDEN", error: "not joined" });
      const key = `${roomId}|${txn}|${type}`;
      let eventId = this.#txns.get(key);
      if (!eventId) {
        eventId = `$sent${this.#evSeq++}`;
        this.#txns.set(key, eventId);
        this.sent.push({ roomId, type: type!, content: (body ?? {}) as Record<string, unknown>, eventId, txnId: txn! });
      }
      return this.#json(res, 200, { event_id: eventId });
    }
    if (room && method === "PUT" && room[2]!.startsWith("redact/")) {
      this.redactions.push(decodeURIComponent(room[2]!.split("/")[1]!));
      return this.#json(res, 200, { event_id: `$redact${this.#evSeq++}` });
    }
    if (room && method === "PUT" && room[2]!.startsWith("typing/")) {
      this.typing.push({ roomId: decodeURIComponent(room[1]!), typing: (body as { typing?: boolean })?.typing === true });
      return this.#json(res, 200, {});
    }

    const profile = /^\/_matrix\/client\/v3\/profile\/([^/]+)$/.exec(path);
    if (profile && method === "GET") {
      return this.displayname === undefined ? this.#json(res, 200, {}) : this.#json(res, 200, { displayname: this.displayname });
    }

    if (path === "/_matrix/media/v3/upload" && method === "POST") {
      const mxc = `mxc://hs.test/m${this.#mediaSeq++}`;
      const id = mxc.split("/").pop()!;
      this.media.set(id, { data: raw, mime: contentType ?? "application/octet-stream" });
      this.uploads.push({ mime: contentType ?? "", filename: url.searchParams.get("filename") ?? "", size: raw.length });
      return this.#json(res, 200, { content_uri: mxc });
    }

    const dl1 = /^\/_matrix\/client\/v1\/media\/download\/([^/]+)\/([^/]+)$/.exec(path);
    if (dl1 && method === "GET") {
      if (!this.authenticatedMedia) return this.#json(res, 404, { errcode: "M_UNRECOGNIZED", error: "Unrecognized request" });
      if (req.headers.authorization !== `Bearer ${FAKE_TOKEN}`) return this.#json(res, 401, { errcode: "M_UNKNOWN_TOKEN", error: "no" });
      const m = this.media.get(dl1[2]!);
      if (!m) return this.#json(res, 404, { errcode: "M_NOT_FOUND", error: "no media" });
      const boundary = "BOUNDARY42";
      const payload = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json\r\n\r\n{}\r\n--${boundary}\r\nContent-Type: ${m.mime}\r\n\r\n`),
        m.data,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      res.writeHead(200, { "content-type": `multipart/mixed; boundary=${boundary}` });
      return void res.end(payload);
    }
    const dl3 = /^\/_matrix\/media\/v3\/download\/([^/]+)\/([^/]+)$/.exec(path);
    if (dl3 && method === "GET") {
      const m = this.media.get(dl3[2]!);
      if (!m) return this.#json(res, 404, { errcode: "M_NOT_FOUND", error: "no media" });
      res.writeHead(200, { "content-type": m.mime });
      return void res.end(m.data);
    }

    return this.#json(res, 404, { errcode: "M_UNRECOGNIZED", error: "Unrecognized request" });
  }

  #sync(req: IncomingMessage, res: ServerResponse, url: URL): void {
    void req;
    const since = url.searchParams.get("since");
    const timeout = Number(url.searchParams.get("timeout") ?? 0);
    if (since === null && !this.#initialServed) {
      this.#initialServed = true;
      const roomsOut = this.#rooms(new Map(), new Map(), true);
      const merged = this.#merged();
      const join = roomsOut.join as Record<string, Record<string, unknown>>;
      const extra = merged.rooms.join as Record<string, { timeline: { events: MatrixEvent[] }; state: { events: MatrixEvent[] } }>;
      for (const [r, v] of Object.entries(extra)) {
        const base = join[r];
        if (base) {
          (base.timeline as { events: MatrixEvent[] }).events.push(...v.timeline.events);
        } else join[r] = v;
      }
      return this.#respond(res, { next_batch: merged.next_batch, rooms: { join, invite: merged.rooms.invite, leave: {} }, account_data: this.#accountData() }, true);
    }
    if (this.#queue.length > 0) return this.#respond(res, this.#merged(), false);
    if (timeout <= 0) return this.#respond(res, { next_batch: `s${this.#seq}`, rooms: { join: {}, invite: {}, leave: {} }, account_data: this.#accountData() }, false);
    const timer = setTimeout(() => {
      if (this.#held?.res === res) {
        this.#held = undefined;
        this.#respond(res, { next_batch: `s${this.#seq}`, rooms: { join: {}, invite: {}, leave: {} }, account_data: this.#accountData() }, false);
      }
    }, timeout);
    this.#held = { res, timer };
    res.on("close", () => {
      if (this.#held?.res === res) {
        clearTimeout(timer);
        this.#held = undefined;
      }
    });
  }
}

export function textMessage(body: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { msgtype: "m.text", body, ...extra };
}
