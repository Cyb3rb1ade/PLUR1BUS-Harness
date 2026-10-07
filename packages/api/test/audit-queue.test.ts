import assert from "node:assert/strict";
import test from "node:test";
import { createBufferedSink } from "../src/audit-queue.ts";
import type { AuditEvent, AuditSink } from "../src/rbac-bridge.ts";

const ev = (n: number): AuditEvent => ({ at: n, actor: { user: "u", host: "api" }, action: "auth.test", target: `t${n}`, detail: { n } });
const logs: string[] = [];
const log = { error: (m: string, f?: Record<string, unknown>) => { logs.push(`${m} ${JSON.stringify(f ?? {})}`); } };
const sink = (failFirst = 0) => { const written: AuditEvent[] = []; let fails = failFirst; const s: AuditSink = { append(e) { if (fails > 0) { fails--; throw new Error("audit-chain: lock timeout"); } written.push(e); } }; return { s, written }; };

test("append never throws and never blocks: the inner sink is written after the call returns, in order", async () => {
  const { s, written } = sink(); const b = createBufferedSink(s, { log });
  for (let i = 0; i < 5; i++) b.append(ev(i));
  assert.equal(written.length, 0, "nothing written synchronously"); assert.equal(b.pending, 5);
  await b.flush();
  assert.deepEqual(written.map((e) => e.at), [0, 1, 2, 3, 4]); assert.equal(b.pending, 0); assert.equal(b.dropped, 0);
});

test("a failing inner sink is retried, order is kept, and nothing is lost while it recovers", async () => {
  const { s, written } = sink(2); const b = createBufferedSink(s, { log, retryMs: 1 });
  b.append(ev(1)); b.append(ev(2)); b.append(ev(3));
  await b.flush();
  assert.deepEqual(written.map((e) => e.at), [1, 2, 3]); assert.equal(b.dropped, 0);
});

test("an event that keeps failing is dropped after the attempts, counted and logged without its detail; the ones behind it still go through", async () => {
  logs.length = 0;
  const written: AuditEvent[] = [];
  const s: AuditSink = { append(e) { if (e.at === 2) throw new Error("always"); written.push(e); } };
  const b = createBufferedSink(s, { log, retryMs: 1, maxAttempts: 3 });
  b.append(ev(1)); b.append({ ...ev(2), detail: { secretish: "do-not-log-me" } }); b.append(ev(3));
  await b.flush();
  assert.deepEqual(written.map((e) => e.at), [1, 3]); assert.equal(b.dropped, 1);
  assert.ok(logs.some((l) => l.includes("audit event dropped") && l.includes("auth.test")));
  assert.ok(!logs.join("\n").includes("do-not-log-me"), "the log names the action, never the detail");
});

test("the queue is bounded: past the limit new events are dropped and counted, the log is told once per burst, memory does not grow", async () => {
  logs.length = 0;
  const { s, written } = sink(); const b = createBufferedSink(s, { log, maxQueue: 3 });
  for (let i = 0; i < 10; i++) b.append(ev(i));
  assert.equal(b.pending, 3); assert.equal(b.dropped, 7);
  assert.equal(logs.filter((l) => l.includes("audit queue full")).length, 1);
  await b.flush(); assert.deepEqual(written.map((e) => e.at), [0, 1, 2]);
});

test("events are copied on the way in: changing the object afterwards does not change what is written", async () => {
  const { s, written } = sink(); const b = createBufferedSink(s, { log });
  const e = ev(1); b.append(e); (e.detail as Record<string, unknown>).n = 99; e.actor.user = "mallory";
  await b.flush();
  assert.deepEqual([written[0]!.detail.n, written[0]!.actor.user], [1, "u"]);
});

test("flush on an empty queue returns at once; a sink that is down for good makes flush give up, not hang", async () => {
  const b0 = createBufferedSink(sink().s, { log }); await b0.flush();
  const down: AuditSink = { append() { throw new Error("down"); } };
  const b = createBufferedSink(down, { log, retryMs: 1, maxAttempts: 2 });
  b.append(ev(1)); await b.flush();
  assert.equal(b.pending, 0); assert.equal(b.dropped, 1);
});
