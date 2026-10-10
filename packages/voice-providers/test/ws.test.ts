// Direct tests for the hand-written RFC 6455 client against a raw TCP server (loopback, port 0). Hostile frames are
// written byte by byte; every wait is on an observable event, timers are injected, nothing sleeps.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { isVoiceProviderError } from "../src/errors.ts";
import { defaultWsFactory, type WsLike, type WsTimers } from "../src/ws.ts";
import { closePayload, frameBytes, startRawServer, type RawPeer, type RawServer } from "./helpers/raw-ws-server.ts";

interface Fake { timers: WsTimers; pending(): number; fireNext(): void; fireAll(): void }
/** Manual timers: nothing runs until the test says so. */
function fakeTimers(): Fake {
  let seq = 0;
  const q = new Map<number, () => void>();
  return {
    timers: { setTimeout: (fn) => { const id = ++seq; q.set(id, fn); return id; }, clearTimeout: (h) => { q.delete(h as number); } },
    pending: () => q.size,
    fireNext() { const [id, fn] = q.entries().next().value as [number, () => void]; q.delete(id); fn(); },
    fireAll() { for (const [id, fn] of [...q.entries()]) { q.delete(id); fn(); } },
  };
}

interface Rec { messages: Array<string | Uint8Array>; closes: Array<{ code: number; reason: string }>; errors: Array<{ message: string }>; closed: Promise<{ code: number; reason: string }>; waitMessages(n: number): Promise<void> }
function record(ws: WsLike): Rec {
  let waiters: Array<() => void> = [];
  const r: Rec = {
    messages: [], closes: [], errors: [], closed: undefined as never,
    async waitMessages(n) { while (r.messages.length < n) await new Promise<void>((res) => waiters.push(res)); },
  };
  r.closed = new Promise((resolve) => ws.addEventListener("close", (e) => { r.closes.push(e); resolve(e); }));
  ws.addEventListener("message", (e) => { r.messages.push(e.data); const w = waiters; waiters = []; for (const f of w) f(); });
  ws.addEventListener("error", (e) => { r.errors.push(e); });
  return r;
}

let server: RawServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

async function connect(opts: Parameters<typeof startRawServer>[0] = {}, init: Partial<Parameters<typeof defaultWsFactory>[1]> = {}): Promise<{ ws: WsLike; peer: RawPeer; rec: Rec }> {
  server = await startRawServer(opts);
  const ws = await defaultWsFactory(server.url, { provider: "t", ...init });
  const peer = await server.nextPeer();
  return { ws, peer, rec: record(ws) };
}

test("every client frame is masked, for short, medium and large payloads, text and binary", async () => {
  const { ws, peer } = await connect();
  ws.send("hello");
  ws.send("x".repeat(300));
  ws.send(new Uint8Array(70_000).fill(7));
  ws.send(new Uint8Array([1, 2, 3]));
  await peer.waitFrames(4);
  assert.ok(peer.frames.every((f) => f.masked), "client frames must carry the mask bit");
  assert.equal(peer.frames[0]!.opcode, 1);
  assert.equal(peer.frames[0]!.payload.toString("utf8"), "hello");
  assert.equal(peer.frames[1]!.payload.length, 300);
  assert.equal(peer.frames[2]!.opcode, 2);
  assert.equal(peer.frames[2]!.payload.length, 70_000);
  assert.deepEqual([...peer.frames[3]!.payload], [1, 2, 3]);
  ws.close();
});

test("handshake carries the vendor headers once, with the protocol headers in their own case-insensitive slot", async () => {
  const { ws, peer } = await connect({}, { headers: { "x-test": "a", connection: "close", Upgrade: "h2c" } });
  assert.equal(peer.headers["x-test"], "a");
  assert.match(peer.headers["connection"]!, /upgrade/i);
  assert.equal(peer.headers["upgrade"], "websocket");
  assert.equal(peer.headers["sec-websocket-version"], "13");
  ws.close();
});

test("a fragmented text message is reassembled before it is decoded, even when a multibyte character straddles fragments", async () => {
  const { ws, peer, rec } = await connect();
  const euro = Buffer.from("€");
  peer.write(Buffer.concat([
    frameBytes(1, Buffer.concat([Buffer.from("a"), euro.subarray(0, 1)]), { fin: false }),
    frameBytes(9, "ping-in-between"),
    frameBytes(0, euro.subarray(1), { fin: true }),
  ]));
  await peer.waitOpcode(10);
  peer.send(1, "end");
  await rec.waitMessages(2);
  assert.deepEqual(rec.messages, ["a€", "end"]);
  ws.close();
});

test("a binary message arrives as bytes", async () => {
  const { ws, peer, rec } = await connect();
  peer.send(2, Buffer.from([9, 8, 7]));
  await rec.waitMessages(1);
  assert.ok(rec.messages[0] instanceof Uint8Array);
  assert.deepEqual([...(rec.messages[0] as Uint8Array)], [9, 8, 7]);
  ws.close();
});

test("a ping is answered with a masked pong that echoes the payload", async () => {
  const { ws, peer } = await connect();
  peer.send(9, "are-you-there");
  const pong = await peer.waitOpcode(10);
  assert.equal(pong.masked, true);
  assert.equal(pong.payload.toString("utf8"), "are-you-there");
  ws.close();
});

test("a message over the total limit fails the connection with 1009, also when it is split into small fragments", async () => {
  const { ws, peer, rec } = await connect({}, { limits: { maxMessageBytes: 1024 } });
  const chunk = Buffer.alloc(400, 0x61);
  peer.write(Buffer.concat([frameBytes(1, chunk, { fin: false }), frameBytes(0, chunk, { fin: false }), frameBytes(0, chunk, { fin: false })]));
  const closed = await rec.closed;
  assert.equal(closed.code, 1009);
  const f = await peer.waitOpcode(8);
  assert.equal(f.payload.readUInt16BE(0), 1009);
  assert.equal(rec.messages.length, 0);
  assert.throws(() => ws.send("x"), (e) => isVoiceProviderError(e) && e.code === "closed");
});

test("a single frame that announces more than the limit is refused from the header alone", async () => {
  const { peer, rec } = await connect({}, { limits: { maxMessageBytes: 1024 } });
  const head = Buffer.alloc(10);
  head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(2n ** 40n, 2);
  peer.write(head);
  assert.equal((await rec.closed).code, 1009);
});

for (const [name, bytes, code] of [
  ["reserved bits set", () => frameBytes(1, "x", { rsv: 4 }), 1002],
  ["a masked server frame", () => frameBytes(1, "x", { masked: true }), 1002],
  ["a continuation frame without a start", () => frameBytes(0, "x"), 1002],
  ["a new data frame in the middle of a fragmented message", () => Buffer.concat([frameBytes(1, "a", { fin: false }), frameBytes(1, "b")]), 1002],
  ["a fragmented control frame", () => frameBytes(9, "x", { fin: false }), 1002],
  ["a control frame over 125 bytes", () => frameBytes(9, Buffer.alloc(126)), 1002],
  ["an unknown opcode", () => frameBytes(3, "x"), 1002],
  ["an unknown control opcode", () => frameBytes(11, "x"), 1002],
  ["a close frame with a one-byte payload", () => frameBytes(8, Buffer.from([3])), 1002],
  ["a close frame with a reserved status code", () => frameBytes(8, closePayload(1005)), 1002],
  ["invalid UTF-8 in a text message", () => frameBytes(1, Buffer.from([0xff, 0xfe, 0xfd])), 1007],
  ["invalid UTF-8 in a close reason", () => frameBytes(8, Buffer.concat([closePayload(1000), Buffer.from([0xff])])), 1007],
] as const) {
  test(`hostile input: ${name} fails the connection with ${code}`, async () => {
    const { peer, rec } = await connect();
    peer.write(bytes());
    const closed = await rec.closed;
    assert.equal(closed.code, code);
    assert.equal(rec.messages.length, 0);
    const f = await peer.waitOpcode(8);
    assert.equal(f.payload.readUInt16BE(0), code);
    assert.equal(f.masked, true);
  });
}

test("invalid UTF-8 split over fragments is caught on the assembled message", async () => {
  const { peer, rec } = await connect();
  peer.write(Buffer.concat([frameBytes(1, Buffer.from([0xe2, 0x82]), { fin: false }), frameBytes(0, Buffer.from([0x20]))]));
  assert.equal((await rec.closed).code, 1007);
});

test("client close: a close frame with the code goes out, the peer's echo ends the session with that code", async () => {
  const { ws, peer, rec } = await connect();
  ws.close(1000, "done");
  const f = await peer.waitOpcode(8);
  assert.equal(f.payload.readUInt16BE(0), 1000);
  assert.equal(f.payload.subarray(2).toString("utf8"), "done");
  peer.send(8, closePayload(1000));
  assert.deepEqual(await rec.closed, { code: 1000, reason: "" });
  assert.equal(ws.readyState, 3);
  assert.equal(rec.errors.length, 0);
});

test("server close: the client echoes the code and the session ends", async () => {
  const { peer, rec } = await connect();
  peer.send(8, closePayload(1001, "going away"));
  assert.deepEqual(await rec.closed, { code: 1001, reason: "going away" });
  const f = await peer.waitOpcode(8);
  assert.equal(f.payload.readUInt16BE(0), 1001);
});

test("a peer that never answers our close frame is dropped when the close timeout fires", async () => {
  const t = fakeTimers();
  const { ws, peer, rec } = await connect({}, { timers: t.timers, limits: { pingIntervalMs: 0 } });
  ws.close(1000, "bye");
  await peer.waitOpcode(8);
  assert.equal(t.pending(), 1, "exactly the close timer is armed");
  t.fireNext();
  const closed = await rec.closed;
  assert.equal(closed.code, 1006);
  await peer.waitClosed();
});

test("a peer that answers the close frame ends the session once; leftover timers are harmless", async () => {
  const t = fakeTimers();
  const { ws, peer, rec } = await connect({}, { timers: t.timers, limits: { pingIntervalMs: 0 } });
  ws.close();
  await peer.waitOpcode(8);
  peer.send(8, closePayload(1000));
  await rec.closed;
  await peer.waitClosed();
  t.fireAll(); // whatever is left (the socket-drop guard) must be harmless
  assert.equal(rec.closes.length, 1);
  assert.equal(rec.errors.length, 0);
});

test("keepalive: a ping goes out on the interval, any traffic from the peer clears the dead-peer deadline", async () => {
  const t = fakeTimers();
  const { ws, peer, rec } = await connect({}, { timers: t.timers });
  assert.equal(t.pending(), 1, "the ping timer is armed after the handshake");
  t.fireNext();
  const ping = await peer.waitOpcode(9);
  assert.equal(ping.masked, true);
  assert.ok(ping.payload.length <= 125);
  assert.equal(t.pending(), 1, "the pong deadline is armed");
  peer.send(10, ping.payload);
  peer.send(1, "sync"); // frames are handled in order: once this arrives the pong has been processed
  await rec.waitMessages(1);
  assert.equal(t.pending(), 1, "the deadline was replaced by the next ping timer");
  assert.equal(rec.closes.length, 0);
  ws.close();
});

test("keepalive: a peer that answers nothing within the pong deadline is declared dead", async () => {
  const t = fakeTimers();
  const { peer, rec } = await connect({}, { timers: t.timers });
  t.fireNext(); // ping out, deadline armed
  await peer.waitOpcode(9);
  t.fireNext(); // deadline
  const closed = await rec.closed;
  assert.equal(closed.code, 1006);
  assert.match(closed.reason, /dead/);
  await peer.waitClosed();
});

test("a listener that throws does not crash the process: it becomes an error event and the socket closes with 1011", async () => {
  server = await startRawServer();
  const ws = await defaultWsFactory(server.url, { provider: "t" });
  const peer = await server.nextPeer();
  const errors: string[] = [];
  const closed = new Promise<{ code: number }>((r) => ws.addEventListener("close", r));
  ws.addEventListener("error", (e) => errors.push(e.message));
  ws.addEventListener("message", () => { throw new TypeError("boom"); });
  peer.send(1, "{}");
  const f = await peer.waitOpcode(8);
  assert.equal(f.payload.readUInt16BE(0), 1011);
  peer.send(8, closePayload(1011));
  await closed;
  assert.deepEqual(errors, ["listener_error"]);
});

test("frames that arrive after we sent a close frame are not delivered, and a late ping is not answered", async () => {
  const { ws, peer, rec } = await connect();
  ws.close();
  await peer.waitOpcode(8);
  peer.write(Buffer.concat([frameBytes(1, "late"), frameBytes(9, "late-ping")]));
  peer.send(8, closePayload(1000));
  await rec.closed;
  assert.equal(rec.messages.length, 0);
  assert.equal(rec.errors.length, 0);
  assert.equal(peer.frames.filter((f) => f.opcode === 10).length, 0);
});

test("a socket that drops without a close frame ends the session as 1006", async () => {
  const { peer, rec } = await connect();
  peer.socket.destroy();
  assert.equal((await rec.closed).code, 1006);
});

test("handshake: a wrong accept key, a negotiated extension or a negotiated subprotocol are refused", async () => {
  for (const [opts, label] of [[{ badAccept: true }, "accept"], [{ upgradeHeaders: { "Sec-WebSocket-Extensions": "permessage-deflate" } }, "extension"], [{ upgradeHeaders: { "Sec-WebSocket-Protocol": "chat" } }, "subprotocol"]] as const) {
    const s = await startRawServer(opts);
    try {
      await assert.rejects(defaultWsFactory(s.url, { provider: "t" }), (e) => isVoiceProviderError(e) && e.code === "bad_response", label);
    } finally { await s.close(); }
  }
});

test("handshake: 401 maps to auth, 429 to rate_limited with Retry-After, 503 to overloaded", async () => {
  for (const [status, headers, code, retry] of [[401, {}, "auth", undefined], [429, { "Retry-After": "7" }, "rate_limited", 7000], [503, {}, "overloaded", undefined]] as const) {
    const s = await startRawServer({ status, statusHeaders: headers });
    try {
      await assert.rejects(defaultWsFactory(s.url, { provider: "t" }), (e) => isVoiceProviderError(e) && e.code === code && e.status === status && e.retryAfterMs === retry);
    } finally { await s.close(); }
  }
});

test("plain ws:// is only accepted to loopback", async () => {
  await assert.rejects(defaultWsFactory("ws://example.com/x", { provider: "t" }), (e) => isVoiceProviderError(e) && e.code === "config");
});

test("an aborted signal rejects the connect with aborted", async () => {
  server = await startRawServer();
  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(defaultWsFactory(server.url, { provider: "t", signal: ctl.signal }), (e) => isVoiceProviderError(e) && e.code === "aborted");
});
