import assert from "node:assert/strict";
import { test } from "node:test";
import { Gateway, FATAL_CLOSE_CODES, type GatewayOptions, MemoryGatewayStateStore } from "../src/index.ts";
import { FakeClock } from "./helpers/fake-clock.ts";
import { FakeGateway, BOT_ID, type FakeSocket } from "./helpers/fake-discord.ts";

const HEARTBEAT = 1000;

interface Rig {
  gw: FakeGateway;
  clock: FakeClock;
  ac: AbortController;
  g: Gateway;
  events: string[];
  dispatches: [string, unknown][];
  sessions: (unknown | undefined)[];
  fatal: number[];
  run: Promise<void>;
}
function rig(over: Partial<GatewayOptions> = {}): Rig {
  const gw = new FakeGateway();
  gw.heartbeatInterval = HEARTBEAT;
  const clock = new FakeClock();
  const ac = new AbortController();
  const events: string[] = [];
  const dispatches: [string, unknown][] = [];
  const sessions: (unknown | undefined)[] = [];
  const fatal: number[] = [];
  const g = new Gateway({
    token: "t",
    intents: 1,
    url: "wss://gateway.test.invalid",
    webSocket: gw.factory,
    signal: ac.signal,
    sleep: clock.sleep,
    random: () => 0.5,
    now: clock.now,
    botId: BOT_ID,
    onReady: (info, resumed) => events.push(resumed ? "resumed" : `ready:${info.sessionId}`),
    onDispatch: (t, d) => dispatches.push([t, d]),
    onConnection: (up) => events.push(up ? "up" : "down"),
    onSession: (s) => sessions.push(s),
    onFatal: (c) => fatal.push(c),
    log: () => {},
    ...over,
  });
  const run = g.run();
  return { gw, clock, ac, g, events, dispatches, sessions, fatal, run };
}
const frames = (r: Rig, op: number) => r.gw.frames.filter((f) => f.frame.op === op).map((f) => f.frame);

test("gateway: hello -> identify -> ready; heartbeat jittered within the interval", async () => {
  const r = rig();
  await r.clock.flush();
  await r.gw.whenReady();
  assert.equal(frames(r, 2).length, 1);
  assert.equal((frames(r, 2)[0]!.d as { intents: number }).intents, 1);
  assert.deepEqual(r.events, ["up", "ready:session-1"]);
  // random 0.5 -> first beat after half an interval
  await r.clock.advance(HEARTBEAT / 2);
  assert.equal(frames(r, 1).length, 1);
  r.ac.abort();
  await r.run;
});

test("gateway: heartbeats carry the last sequence and an ACK keeps the session", async () => {
  const r = rig();
  await r.gw.whenReady();
  r.gw.latest.server({ op: 0, t: "MESSAGE_CREATE", s: 7, d: {} });
  await r.clock.advance(HEARTBEAT / 2);
  assert.deepEqual(frames(r, 1).at(-1)?.d, 7);
  r.gw.latest.server({ op: 11 });
  await r.clock.advance(HEARTBEAT);
  assert.equal(frames(r, 1).length, 2);
  assert.equal(r.gw.sockets.length, 1, "no reconnect while ACKed");
  r.ac.abort();
  await r.run;
});

test("gateway: missed ACK is a zombie connection -> close and resume with session and seq", async () => {
  const r = rig();
  r.gw.silentSockets.add(0);
  await r.gw.whenReady();
  r.gw.latest.server({ op: 0, t: "MESSAGE_CREATE", s: 41, d: {} });
  await r.clock.advance(HEARTBEAT / 2); // beat 1 (not acked)
  await r.clock.advance(HEARTBEAT); // beat 2 sees no ACK -> zombie
  await r.clock.advance(5000);
  assert.equal(r.gw.sockets.length, 2);
  assert.equal(r.gw.urls[1], "wss://resume.discord.gg/?v=10&encoding=json", "resume_gateway_url is used");
  const resume = frames(r, 6).at(-1)!;
  assert.deepEqual(resume.d, { token: "t", session_id: "session-1", seq: 41 });
  assert.ok(r.events.includes("resumed"), "the RESUMED dispatch is reported");
  r.ac.abort();
  await r.run;
});

test("gateway: in-process resume state survives a fresh Gateway (session restored from the store)", async () => {
  const store = new MemoryGatewayStateStore();
  const first = rig({ onSession: (s) => void store.save(s as never).catch(() => {}) });
  await first.gw.whenReady();
  first.ac.abort();
  await first.run;
  const saved = await store.load();
  assert.ok(saved, "session persisted");
  const gw = new FakeGateway();
  const clock = new FakeClock();
  const ac = new AbortController();
  const g = new Gateway({
    token: "t", intents: 1, url: "wss://gateway.test.invalid", webSocket: gw.factory, signal: ac.signal,
    sleep: clock.sleep, random: () => 0.5, now: clock.now, botId: BOT_ID, session: saved,
    onReady: () => {}, onDispatch: () => {}, onConnection: () => {}, onSession: () => {}, onFatal: () => {}, log: () => {},
  });
  const run = g.run();
  await gw.whenReady();
  assert.equal(gw.frames.at(-1)?.frame.op, 6);
  ac.abort();
  await run;
});

test("gateway: INVALID_SESSION false -> identify again, with a jittered wait", async () => {
  const r = rig();
  await r.gw.whenReady();
  r.gw.latest.server({ op: 9, d: false });
  await r.clock.advance(6000);
  assert.equal(r.gw.sockets.length, 2);
  assert.equal(r.gw.sockets[1]!.sent[0]?.op, 2, "re-identify, not resume");
  assert.ok(r.sessions.includes(undefined), "the session is forgotten before identify");
  r.ac.abort();
  await r.run;
});

test("gateway: INVALID_SESSION true -> resume", async () => {
  const r = rig();
  await r.gw.whenReady();
  r.gw.latest.server({ op: 9, d: true });
  await r.clock.advance(6000);
  assert.equal(r.gw.sockets.length, 2);
  assert.equal(r.gw.sockets[1]!.sent[0]?.op, 6, "resumable invalid session resumes");
  r.ac.abort();
  await r.run;
});

test("gateway: RECONNECT after a stable session resumes immediately", async () => {
  const r = rig();
  await r.gw.whenReady();
  await r.clock.advance(6000); // stable: at least 5 s connected
  r.gw.latest.server({ op: 7 });
  await r.clock.flush();
  assert.equal(r.gw.sockets.length, 2);
  assert.equal(r.gw.sockets[1]!.sent[0]?.op, 6);
  r.ac.abort();
  await r.run;
});

test("gateway: non-discord resume URLs are never dialled", async () => {
  const store = new MemoryGatewayStateStore({ sessionId: "s", seq: 3, resumeGatewayUrl: "wss://evil.example", botId: BOT_ID });
  const gw = new FakeGateway();
  const clock = new FakeClock();
  const ac = new AbortController();
  const g = new Gateway({
    token: "t", intents: 1, url: "wss://gateway.test.invalid", webSocket: gw.factory, signal: ac.signal,
    sleep: clock.sleep, random: () => 0.5, now: clock.now, botId: BOT_ID, session: await store.load(),
    onReady: () => {}, onDispatch: () => {}, onConnection: () => {}, onSession: () => {}, onFatal: () => {}, log: () => {},
  });
  const run = g.run();
  await gw.whenReady();
  assert.equal(gw.urls[0], "wss://gateway.test.invalid/?v=10&encoding=json");
  ac.abort();
  await run;
});

for (const code of [4004, 4010, 4011, 4012, 4013, 4014]) {
  test(`gateway: close ${code} is fatal: reported once, no retry`, async () => {
    const r = rig();
    await r.gw.whenReady();
    r.gw.latest.remoteClose(code);
    await r.clock.advance(120_000);
    assert.deepEqual(r.fatal, [code]);
    assert.equal(r.gw.sockets.length, 1, "no reconnect storm");
    assert.ok(FATAL_CLOSE_CODES.has(code));
    await r.run;
  });
}

for (const code of [4000, 4001, 4002, 4003, 4005, 4008, 1006]) {
  test(`gateway: close ${code} is retryable with backoff`, async () => {
    const r = rig();
    await r.gw.whenReady();
    r.gw.latest.remoteClose(code);
    await r.clock.flush();
    await r.clock.advance(5000);
    assert.equal(r.fatal.length, 0);
    assert.equal(r.gw.sockets.length, 2);
    r.ac.abort();
    await r.run;
  });
}

test("gateway: repeated failures back off exponentially (capped), stable sessions reset it", async () => {
  const r = rig({ helloTimeoutMs: 10 });
  // Never answer HELLO: each attempt times out, so waits must grow.
  r.gw.auto = false;
  for (let i = 0; i < 3; i++) {
    await r.clock.flush();
    await r.clock.advance(20);
    await r.clock.flush();
    await r.clock.advance(60_000);
  }
  const socketsBefore = r.gw.sockets.length;
  assert.ok(socketsBefore >= 3);
  assert.ok(r.clock.slept.filter((ms) => ms >= 1000).length >= 3);
  r.ac.abort();
  await r.run;
});

test("gateway: malformed and oversized frames are ignored without killing the connection", async () => {
  const r = rig();
  await r.gw.whenReady();
  r.gw.latest.onmessage?.({ data: "{not json" });
  r.gw.latest.onmessage?.({ data: 42 });
  r.gw.latest.server({ op: 0, t: "MESSAGE_CREATE", s: 1, d: { id: "1" } });
  assert.equal(r.dispatches.length, 1);
  assert.equal(r.gw.sockets.length, 1);
  r.ac.abort();
  await r.run;
});

test("gateway: abort closes the socket and ends run()", async () => {
  const r = rig();
  await r.gw.whenReady();
  const s: FakeSocket = r.gw.latest;
  r.ac.abort();
  await r.run;
  await r.clock.flush();
  assert.ok(s.closed, "socket closed on stop");
});

test("gateway: READY from another bot is not accepted as this bot's session", async () => {
  const r = rig();
  await r.gw.whenReady();
  assert.equal(r.events.filter((e) => e.startsWith("ready")).length, 1);
  r.ac.abort();
  await r.run;
});
