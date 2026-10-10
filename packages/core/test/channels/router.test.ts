import { test } from "node:test";
import assert from "node:assert/strict";
import { ChannelRouter, PAIRED_TEXT, type InboundMessage, type OutboundMessage } from "../../src/channels/index.ts";
import { FakeClock, FakeIdentity, FakeSessions, silentLog, flush } from "./helpers.ts";

function setup() {
  const clock = new FakeClock();
  const identity = new FakeIdentity();
  const sessions = new FakeSessions();
  const sent: OutboundMessage[] = [];
  const router = new ChannelRouter({ identity, sessions, clock, log: silentLog });
  const send = async (m: OutboundMessage) => { sent.push(m); };
  const msg = (o: Partial<InboundMessage> = {}): InboundMessage => ({ channel: "lb", chatId: "c1", chatKind: "direct", senderId: "alice", text: "hi", ...o });
  return { clock, identity, sessions, sent, router, send, msg };
}

test("a linked sender's message is submitted to the chat's session and answered", async () => {
  const t = setup();
  t.identity.link("lb", "alice", "u1");
  await t.router.handle(t.msg(), t.send);
  assert.deepEqual(t.sessions.submits.map((s) => [s.userId, s.text]), [["u1", "hi"]]);
  assert.deepEqual(t.sent, [{ chatId: "c1", text: "echo:hi" }]);
});

test("unknown sender: rejected, no session created, content never submitted", async () => {
  const t = setup();
  await t.router.handle(t.msg({ text: "secret plan" }), t.send);
  assert.equal(t.sessions.all.length, 0);
  assert.equal(t.sessions.submits.length, 0);
  assert.equal(t.sent.length, 1);
  assert.ok(!t.sent[0]!.text.includes("secret plan"), "the reply must not echo the content");
});

test("unknown sender gets at most one rejection per minute; later ones are silent", async () => {
  const t = setup();
  await t.router.handle(t.msg(), t.send);
  await t.router.handle(t.msg(), t.send);
  assert.equal(t.sent.length, 1);
  await t.clock.advance(61_000);
  await t.router.handle(t.msg(), t.send);
  assert.equal(t.sent.length, 2);
});

test("unknown sender in a group is dropped silently", async () => {
  const t = setup();
  await t.router.handle(t.msg({ chatKind: "group" }), t.send);
  assert.equal(t.sent.length, 0);
  assert.equal(t.sessions.all.length, 0);
  assert.equal(t.identity.claims.length, 0, "no pairing attempts from groups");
});

test("a valid pairing code from an unknown sender links them; the next message is accepted", async () => {
  const t = setup();
  t.identity.codes.set("ABCD2345", "u7");
  await t.router.handle(t.msg({ text: " abcd2345 " }), t.send);
  assert.deepEqual(t.identity.claims, ["ABCD2345"]);
  assert.equal(t.sent[0]!.text, PAIRED_TEXT("pair-1"));
  assert.ok(!t.sent[0]!.text.includes("ABCD2345"), "the pairing code is not echoed");
  assert.equal(t.sessions.submits.length, 0, "the code itself is not a turn");
  await t.router.handle(t.msg({ text: "hello" }), t.send);
  assert.deepEqual(t.sessions.submits.map((s) => s.userId), ["u7"]);
});

test("a wrong pairing code is rejected and does not link", async () => {
  const t = setup();
  await t.router.handle(t.msg({ text: "ZZZZ2222" }), t.send);
  assert.equal(t.identity.links.size, 0);
  assert.equal(t.sessions.all.length, 0);
});

test("text that is not shaped like a code is never offered to claimPairing", async () => {
  const t = setup();
  for (const text of ["hello", "ABCD234", "ABCD23456", "ABCD0O1I", "ABCD 2345"]) await t.router.handle(t.msg({ text }), t.send);
  assert.equal(t.identity.claims.length, 0);
});

test("D21: concurrent first messages in one chat create exactly one active session", async () => {
  const t = setup();
  t.identity.link("lb", "alice", "u1");
  await Promise.all([1, 2, 3, 4, 5].map((i) => t.router.handle(t.msg({ text: `m${i}` }), t.send)));
  assert.equal(t.sessions.activeCount({ channel: "lb", chatId: "c1" }), 1);
  assert.equal(new Set(t.sessions.submits.map((s) => s.sessionId)).size, 1);
  assert.deepEqual(t.sessions.submits.map((s) => s.text), ["m1", "m2", "m3", "m4", "m5"], "per-chat order is kept");
});

test("D21: different chats and different channels get different sessions", async () => {
  const t = setup();
  t.identity.link("lb", "alice", "u1"); t.identity.link("other", "alice", "u1");
  await t.router.handle(t.msg({ chatId: "c1" }), t.send);
  await t.router.handle(t.msg({ chatId: "c2" }), t.send);
  await t.router.handle(t.msg({ channel: "other", chatId: "c1" }), t.send);
  assert.equal(new Set(t.sessions.submits.map((s) => s.sessionId)).size, 3);
});

test("D21: /new archives the active session and starts a fresh one; only one stays active", async () => {
  const t = setup();
  t.identity.link("lb", "alice", "u1");
  await t.router.handle(t.msg({ text: "one" }), t.send);
  await t.router.handle(t.msg({ text: "/new" }), t.send);
  await t.router.handle(t.msg({ text: "two" }), t.send);
  const ids = t.sessions.submits.map((s) => s.sessionId);
  assert.notEqual(ids[0], ids[1]);
  assert.equal(t.sessions.activeCount({ channel: "lb", chatId: "c1" }), 1);
  assert.equal(t.sessions.all.filter((s) => s.archived).length, 1);
  assert.ok(!t.sessions.submits.some((s) => s.text === "/new"), "the command is not a turn");
});

test("D21: an existing active session (e.g. after a restart) is reused, not duplicated", async () => {
  const t = setup();
  t.identity.link("lb", "alice", "u1");
  t.sessions.active.set("lb\0c1", "pre-existing");
  await t.router.handle(t.msg(), t.send);
  assert.equal(t.sessions.submits[0]!.sessionId, "pre-existing");
  assert.equal(t.sessions.all.length, 0);
});

test("a failing session store does not throw out of handle and does not wedge the chat", async () => {
  const t = setup();
  t.identity.link("lb", "alice", "u1");
  const real = t.sessions.submit.bind(t.sessions);
  let fail = true;
  t.sessions.submit = async (id, i) => { if (fail) { fail = false; throw new Error("boom"); } return real(id, i); };
  await t.router.handle(t.msg({ text: "a" }), t.send); // must resolve
  await t.router.handle(t.msg({ text: "b" }), t.send);
  assert.deepEqual(t.sessions.submits.map((s) => s.text), ["b"]);
  assert.ok(t.sent.some((m) => m.text.includes("echo:b")));
});

test("a failing identity layer fails closed", async () => {
  const t = setup();
  t.identity.resolve = async () => { throw new Error("identity down"); };
  await t.router.handle(t.msg(), t.send);
  assert.equal(t.sessions.all.length, 0);
  assert.equal(t.sessions.submits.length, 0);
});

test("a throwing send does not break handling", async () => {
  const t = setup();
  t.identity.link("lb", "alice", "u1");
  await t.router.handle(t.msg(), async () => { throw new Error("network"); });
  await flush();
  assert.equal(t.sessions.submits.length, 1);
});

test("malformed inbound (empty text, oversize) is dropped before identity is consulted", async () => {
  const t = setup();
  await t.router.handle(t.msg({ text: "" }), t.send);
  await t.router.handle(t.msg({ text: "x".repeat(70_000) }), t.send);
  await t.router.handle(t.msg({ senderId: "" }), t.send);
  assert.equal(t.identity.resolves, 0);
});
