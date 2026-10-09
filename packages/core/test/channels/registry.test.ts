import { test } from "node:test";
import assert from "node:assert/strict";
import { ChannelRegistry, ChannelRouter, LoopbackChannel, type Channel, type ChannelHost, type ChannelHealth, type OutboundMessage } from "../../src/channels/index.ts";
import { FakeClock, FakeIdentity, FakeSessions, silentLog, flush } from "./helpers.ts";

const manifest = (o: Record<string, unknown> = {}) => ({ name: "lb", version: "0.1.0", kind: "channel", apiVersion: "1", ...o });

function setup() {
  const clock = new FakeClock();
  const identity = new FakeIdentity();
  const sessions = new FakeSessions();
  const router = new ChannelRouter({ identity, sessions, clock, log: silentLog });
  const registry = new ChannelRegistry({ clock, router, log: silentLog, backoff: { baseMs: 1000, maxMs: 8000 } });
  return { clock, identity, sessions, router, registry };
}

class Scripted implements Channel {
  name: string;
  starts = 0; stops = 0; host?: ChannelHost;
  startPlan: ("ok" | "throw" | "reject" | "hang")[] = [];
  stopPlan: ("ok" | "throw" | "hang")[] = [];
  healthPlan: (ChannelHealth | "throw")[] = [];
  sentOut: OutboundMessage[] = [];
  constructor(name = "lb") { this.name = name; }
  async start(host: ChannelHost) {
    this.starts++; this.host = host;
    const step = this.startPlan.shift() ?? "ok";
    if (step === "throw") throw new Error("start boom");
    if (step === "reject") return Promise.reject(new Error("start reject"));
    if (step === "hang") return new Promise<void>(() => {});
  }
  async stop() {
    this.stops++;
    const step = this.stopPlan.shift() ?? "ok";
    if (step === "throw") throw new Error("stop boom");
    if (step === "hang") return new Promise<void>(() => {});
  }
  async health(): Promise<ChannelHealth> {
    const h = this.healthPlan.shift() ?? { ok: true };
    if (h === "throw") throw new Error("health boom");
    return h;
  }
  async send(m: OutboundMessage) { this.sentOut.push(m); }
}

test("register validates the manifest and refuses duplicates", () => {
  const { registry } = setup();
  assert.equal(registry.register({ manifest: { name: "x" }, factory: () => new Scripted() }).ok, false);
  assert.equal(registry.register({ manifest: manifest(), factory: () => new Scripted() }).ok, true);
  assert.equal(registry.register({ manifest: manifest(), factory: () => new Scripted() }).ok, false);
});

test("a factory name that disagrees with the manifest is refused", async () => {
  const { registry, clock } = setup();
  registry.register({ manifest: manifest(), factory: () => new Scripted("other") });
  registry.start("lb");
  await clock.advance(0);
  assert.equal(registry.status("lb")?.state, "failed");
});

test("start is delayed by startDelayMs (fake clock), start() itself returns at once", async () => {
  const { registry, clock } = setup();
  const ch = new Scripted();
  registry.register({ manifest: manifest({ startDelayMs: 5000 }), factory: () => ch });
  registry.start("lb");
  await clock.advance(4999);
  assert.equal(ch.starts, 0);
  assert.equal(registry.status("lb")?.state, "waiting");
  await clock.advance(1);
  assert.equal(ch.starts, 1);
  assert.equal(registry.status("lb")?.state, "running");
});

test("isolation: throwing and rejecting start never propagate; other channels keep running", async () => {
  const { registry, clock } = setup();
  const bad = new Scripted("bad"); bad.startPlan = ["throw", "reject", "throw", "reject", "throw", "reject", "throw", "reject", "throw"];
  const good = new Scripted("good");
  registry.register({ manifest: manifest({ name: "bad", maxRestarts: 3 }), factory: () => bad });
  registry.register({ manifest: manifest({ name: "good" }), factory: () => good });
  registry.startAll();
  await clock.advance(60_000);
  assert.equal(registry.status("good")?.state, "running");
  assert.equal(good.starts, 1);
  assert.equal(registry.status("bad")?.state, "failed");
  assert.equal(bad.starts, 4, "first try plus maxRestarts=3 retries, then give up");
  assert.match(registry.status("bad")?.lastError ?? "", /start (boom|reject)/);
});

test("backoff: restart delays follow base*2^n on the fake clock", async () => {
  const { registry, clock } = setup();
  const ch = new Scripted(); ch.startPlan = ["throw", "throw", "throw", "ok"];
  registry.register({ manifest: manifest({ maxRestarts: 10 }), factory: () => ch });
  registry.start("lb");
  await clock.advance(0);
  assert.equal(ch.starts, 1);
  await clock.advance(999); assert.equal(ch.starts, 1);
  await clock.advance(1); assert.equal(ch.starts, 2);       // after 1000
  await clock.advance(1999); assert.equal(ch.starts, 2);
  await clock.advance(1); assert.equal(ch.starts, 3);       // after 2000
  await clock.advance(3999); assert.equal(ch.starts, 3);
  await clock.advance(1); assert.equal(ch.starts, 4);       // after 4000
  assert.equal(registry.status("lb")?.state, "running");
});

test("a hanging start is cut off by the call timeout and retried", async () => {
  const { registry, clock } = setup();
  const ch = new Scripted(); ch.startPlan = ["hang", "ok"];
  registry.register({ manifest: manifest(), factory: () => ch });
  registry.start("lb");
  await clock.advance(10_000);
  assert.equal(ch.starts, 1);
  assert.equal(registry.status("lb")?.state, "backoff");
  await clock.advance(1000);
  assert.equal(ch.starts, 2);
  assert.equal(registry.status("lb")?.state, "running");
});

test("a channel that reports failure through the host is stopped and restarted with backoff", async () => {
  const { registry, clock } = setup();
  const ch = new Scripted();
  registry.register({ manifest: manifest(), factory: () => ch });
  registry.start("lb"); await clock.advance(0);
  ch.host!.fail(new Error("socket died"));
  await clock.advance(0);
  assert.equal(ch.stops, 1);
  assert.equal(registry.status("lb")?.state, "backoff");
  await clock.advance(1000);
  assert.equal(ch.starts, 2);
  assert.equal(registry.status("lb")?.state, "running");
});

test("health polling: an unhealthy or throwing health() triggers a restart", async () => {
  const { registry, clock } = setup();
  const ch = new Scripted(); ch.healthPlan = [{ ok: true }, { ok: false, detail: "no network" }];
  registry.register({ manifest: manifest(), factory: () => ch });
  registry.start("lb"); await clock.advance(0);
  await clock.advance(30_000); assert.equal(ch.starts, 1);
  await clock.advance(30_000); assert.equal(ch.stops, 1);
  assert.equal(registry.status("lb")?.state, "backoff");
  await clock.advance(1000); assert.equal(ch.starts, 2);
  ch.healthPlan = ["throw"];
  await clock.advance(30_000); assert.equal(ch.stops, 2);
});

test("backoff attempt counter resets after a stable run", async () => {
  const { registry, clock } = setup();
  const ch = new Scripted();
  registry.register({ manifest: manifest({ maxRestarts: 2 }), factory: () => ch });
  registry.start("lb"); await clock.advance(0);
  for (let i = 0; i < 5; i++) {
    await clock.advance(120_000);               // stable well past the window
    ch.host!.fail(new Error("flap"));
    await clock.advance(1000);                  // always the *first* backoff step
  }
  assert.equal(registry.status("lb")?.state, "running");
  assert.equal(ch.starts, 6);
});

test("stop(): a throwing or hanging stop is isolated and the channel ends up stopped", async () => {
  const { registry, clock } = setup();
  const a = new Scripted("aa"); a.stopPlan = ["throw"];
  const b = new Scripted("bb"); b.stopPlan = ["hang"];
  registry.register({ manifest: manifest({ name: "aa" }), factory: () => a });
  registry.register({ manifest: manifest({ name: "bb" }), factory: () => b });
  registry.startAll(); await clock.advance(0);
  const p = registry.stopAll();
  await clock.advance(10_000);
  await p;
  assert.equal(registry.status("aa")?.state, "stopped");
  assert.equal(registry.status("bb")?.state, "stopped");
});

test("stop() cancels pending start and backoff timers; nothing fires afterwards", async () => {
  const { registry, clock } = setup();
  const ch = new Scripted(); ch.startPlan = ["throw"];
  registry.register({ manifest: manifest({ startDelayMs: 100 }), factory: () => ch });
  registry.start("lb");
  await registry.stop("lb");
  await clock.advance(100_000);
  assert.equal(ch.starts, 0);
  assert.equal(clock.pending(), 0);
});

test("inbound through a running channel reaches the router; a throwing router path never kills the channel or the process", async () => {
  const { registry, clock, identity, sessions } = setup();
  const ch = new Scripted();
  registry.register({ manifest: manifest(), factory: () => ch });
  registry.start("lb"); await clock.advance(0);
  identity.link("lb", "alice", "u1");
  await ch.host!.receive({ channel: "lb", chatId: "c", chatKind: "direct", senderId: "alice", text: "hi" });
  assert.equal(sessions.submits.length, 1);
  assert.equal(ch.sentOut[0]?.text, "echo:hi");
  sessions.submit = async () => { throw new Error("store down"); };
  await ch.host!.receive({ channel: "lb", chatId: "c", chatKind: "direct", senderId: "alice", text: "again" }); // resolves
  assert.equal(registry.status("lb")?.state, "running");
});

test("a channel cannot receive messages claiming another channel's name", async () => {
  const { registry, clock, identity, sessions } = setup();
  const ch = new Scripted();
  registry.register({ manifest: manifest(), factory: () => ch });
  registry.start("lb"); await clock.advance(0);
  identity.link("telegram", "alice", "u1");
  await ch.host!.receive({ channel: "telegram", chatId: "c", chatKind: "direct", senderId: "alice", text: "spoof" });
  assert.equal(sessions.submits.length, 0);
});

test("a chat kind the manifest does not declare is dropped", async () => {
  const { registry, clock, identity, sessions } = setup();
  const ch = new Scripted();
  registry.register({ manifest: manifest(), factory: () => ch }); // direct only
  registry.start("lb"); await clock.advance(0);
  identity.link("lb", "alice", "u1");
  await ch.host!.receive({ channel: "lb", chatId: "g", chatKind: "group", senderId: "alice", text: "hi" });
  assert.equal(sessions.submits.length, 0);
});

test("messages from a stopped generation of a channel are ignored", async () => {
  const { registry, clock, identity, sessions } = setup();
  const ch = new Scripted();
  registry.register({ manifest: manifest(), factory: () => ch });
  registry.start("lb"); await clock.advance(0);
  const oldHost = ch.host!;
  await registry.stop("lb");
  identity.link("lb", "alice", "u1");
  await oldHost.receive({ channel: "lb", chatId: "c", chatKind: "direct", senderId: "alice", text: "late" });
  assert.equal(sessions.submits.length, 0);
});

test("loopback reference channel: end to end through the registry, pairing included", async () => {
  const { registry, clock, identity, sessions } = setup();
  const lb = new LoopbackChannel("lb");
  registry.register({ manifest: manifest(), factory: () => lb });
  registry.start("lb"); await clock.advance(0);
  assert.deepEqual(await lb.health(), { ok: true });

  await lb.inject({ chatId: "c", senderId: "bob", text: "hello" });
  assert.equal(sessions.submits.length, 0, "unpaired bob is rejected");
  assert.match(lb.outbox[0]!.text, /pair/i);

  identity.codes.set("KMNP2345", "u9");
  await lb.inject({ chatId: "c", senderId: "bob", text: "KMNP2345" });
  await lb.inject({ chatId: "c", senderId: "bob", text: "hello" });
  assert.equal(sessions.submits.length, 1);
  assert.equal(lb.outbox.at(-1)?.text, "echo:hello");

  await registry.stop("lb");
  assert.deepEqual(await lb.health(), { ok: false, detail: "stopped" });
  await flush();
});

test("crashing channel does not take the test process down (uncaught async error inside the call is contained)", async () => {
  const { registry, clock } = setup();
  const ch = new Scripted(); ch.startPlan = ["reject"];
  registry.register({ manifest: manifest(), factory: () => ch });
  registry.start("lb");
  await clock.advance(20_000);
  assert.equal(registry.status("lb")?.state, "running");
});

test("read accessors for channel.*: manifestOf, probe and sendTo never change the channel's state", async () => {
  const { registry, clock } = setup();
  const ch = new Scripted();
  registry.register({ manifest: manifest({ displayName: "LB", linkHelp: "Send /link CODE." }), factory: () => ch });
  assert.equal(registry.manifestOf("lb")?.displayName, "LB");
  assert.equal(registry.manifestOf("lb")?.linkHelp, "Send /link CODE.");
  assert.equal(registry.manifestOf("nope"), undefined);
  assert.equal(registry.register({ manifest: manifest({ name: "x1", linkHelp: "" }), factory: () => new Scripted("x1") }).ok, false);
  assert.equal(await registry.probe("nope"), undefined);
  assert.deepEqual(await registry.probe("lb"), { ok: false, detail: "not running" });
  assert.equal(await registry.sendTo("lb", { chatId: "1", text: "hi" }), false);
  registry.start("lb");
  await clock.advance(0);
  ch.healthPlan = [{ ok: false, detail: "gateway closed" }, "throw", { ok: true }];
  assert.deepEqual(await registry.probe("lb"), { ok: false, detail: "gateway closed" });
  assert.deepEqual(await registry.probe("lb"), { ok: false, detail: "health boom" });
  assert.deepEqual(await registry.probe("lb"), { ok: true });
  assert.equal(registry.status("lb")?.state, "running");
  assert.equal(await registry.sendTo("lb", { chatId: "1", text: "hi" }), true);
  assert.deepEqual(ch.sentOut, [{ chatId: "1", text: "hi" }]);
  await registry.stop("lb");
  assert.equal(await registry.sendTo("lb", { chatId: "1", text: "again" }), false);
});
