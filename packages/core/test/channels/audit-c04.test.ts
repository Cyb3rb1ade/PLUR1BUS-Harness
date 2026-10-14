// Audit c04: channel router and registry findings. Each test was red before its fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChannelRegistry, ChannelRouter, MAX_PENDING_PER_CHAT, type Channel, type ChannelHost, type ChannelHealth, type InboundMessage, type OutboundMessage } from "../../src/channels/index.ts";
import { FakeClock, FakeIdentity, FakeSessions, silentLog, flush } from "./helpers.ts";

const SECRET = "hunter-two-value";
const mask = (t: string) => t.split(SECRET).join("[redacted]");
const manifest = { name: "lb", version: "0.1.0", kind: "channel", apiVersion: "1" };
const msg = (o: Partial<InboundMessage> = {}): InboundMessage => ({ channel: "lb", chatId: "c1", chatKind: "direct", senderId: "alice", text: "hi", ...o });

function routerSetup() {
  const clock = new FakeClock(), identity = new FakeIdentity(), sessions = new FakeSessions();
  identity.link("lb", "alice", "u1");
  const sent: OutboundMessage[] = [];
  const router = new ChannelRouter({ identity, sessions, clock, log: silentLog });
  return { clock, identity, sessions, sent, router, send: async (m: OutboundMessage) => { sent.push(m); } };
}

class Probe implements Channel {
  name = "lb"; host?: ChannelHost; health$: ChannelHealth = { ok: true }; sendError?: Error;
  async start(h: ChannelHost) { this.host = h; }
  async stop() {}
  async health() { return this.health$; }
  async send(_m: OutboundMessage): Promise<void> { if (this.sendError) throw this.sendError; }
}
function registrySetup(extra: { log?: Record<string, (m: string, f?: Record<string, unknown>) => void> } = {}) {
  const clock = new FakeClock(), ch = new Probe(), logged: string[] = [];
  const log = { info() {}, warn: (m: string, f?: Record<string, unknown>) => { logged.push(JSON.stringify([m, f])); }, error: (m: string, f?: Record<string, unknown>) => { logged.push(JSON.stringify([m, f])); }, ...extra.log };
  const identity = new FakeIdentity(); identity.link("lb", "alice", "u1");
  const router = new ChannelRouter({ identity, sessions: new FakeSessions(), clock, log });
  const registry = new ChannelRegistry({ clock, router, log, redact: mask, healthIntervalMs: 1000 });
  registry.register({ manifest, factory: () => ch });
  return { clock, ch, registry, logged };
}

test("the same message redelivered by an adapter (same messageId) is one turn, not two", async () => {
  const t = routerSetup();
  await t.router.handle(msg({ messageId: "m1" }), t.send);
  await t.router.handle(msg({ messageId: "m1" }), t.send);
  await Promise.all([t.router.handle(msg({ messageId: "m2" }), t.send), t.router.handle(msg({ messageId: "m2" }), t.send)]);
  assert.deepEqual(t.sessions.submits.map((s) => s.text), ["hi", "hi"]);
  await t.router.handle(msg({ messageId: "m1", chatId: "c2" }), t.send);
  await t.router.handle(msg(), t.send);
  await t.router.handle(msg(), t.send);
  assert.equal(t.sessions.submits.length, 5, "other chats and messages without an id are never merged");
});

test("a whitespace-only message is dropped, not sent to the model as a turn", async () => {
  const t = routerSetup();
  await t.router.handle(msg({ text: " \n\t " }), t.send);
  assert.equal(t.sessions.submits.length, 0);
  assert.equal(t.sent.length, 0);
});

test("one chat cannot queue unbounded work behind a slow turn", async () => {
  const t = routerSetup();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const submit = t.sessions.submit.bind(t.sessions);
  t.sessions.submit = async (id, input) => { await gate; return submit(id, input); };
  const all = Array.from({ length: MAX_PENDING_PER_CHAT + 30 }, (_, i) => t.router.handle(msg({ text: `m${i}`, messageId: `id${i}` }), t.send));
  await flush(10);
  release();
  await Promise.all(all);
  assert.equal(t.sessions.submits.length, MAX_PENDING_PER_CHAT, "the rest was dropped");
  assert.equal(t.sessions.submits[0]!.text, "m0", "order is kept");
  const other = routerSetup();
  await other.router.handle(msg({ chatId: "other" }), other.send);
  assert.equal(other.sessions.submits.length, 1);
});

test("a health detail is masked and bounded in probe and in the watched status", async () => {
  const t = registrySetup();
  t.registry.start("lb");
  await t.clock.advance(0);
  t.ch.health$ = { ok: true, detail: `token ${SECRET} ${"x".repeat(5000)}` };
  const p = await t.registry.probe("lb");
  assert.ok(!p!.detail!.includes(SECRET));
  assert.ok(p!.detail!.length <= 600);
  await t.clock.advance(1000);
  const h = t.registry.status("lb")!.health!;
  assert.ok(!h.detail!.includes(SECRET));
  assert.ok(h.detail!.length <= 600);
});

test("a failing send rejects with a masked error and logs nothing raw", async () => {
  const t = registrySetup();
  t.registry.start("lb");
  await t.clock.advance(0);
  t.ch.sendError = new Error(`401 for https://x.invalid/${SECRET}/sendMessage`);
  await assert.rejects(() => t.registry.sendTo("lb", { chatId: "c", text: "t" }), (e: Error) => !e.message.includes(SECRET) && e.message.includes("[redacted]"));
  await t.ch.host!.receive(msg());
  assert.ok(t.logged.length > 0, "the failed reply is logged");
  assert.ok(!t.logged.join("\n").includes(SECRET));
});

test("lastError is bounded", async () => {
  const t = registrySetup();
  t.registry.start("lb");
  await t.clock.advance(0);
  t.ch.host!.fail(new Error("e".repeat(10_000)));
  await t.clock.advance(0);
  assert.ok(t.registry.status("lb")!.lastError!.length <= 600);
});
