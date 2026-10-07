// Transcript reducer of the chat page (no browser): messages from session.resume, events by seq, duplicates, gaps.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { addUser, applyEvent, fromResume, type Transcript } from "../src/pages/chat/model.ts";
import type { SessionEvent, SessionMessage } from "../src/pages/chat/rpc-types.ts";

const ev = (seq: number, type: SessionEvent["type"], turnId: string | null, data: Record<string, unknown> = {}): SessionEvent =>
  ({ sessionId: "s1", seq, turnId, type, data, at: 1000 + seq });
const msg = (id: string, seq: number, role: SessionMessage["role"], text: string, turnId: string | null): SessionMessage =>
  ({ id, seq, role, text, turnId, createdAt: 1 });
const apply = (tr: Transcript, ...events: SessionEvent[]): Transcript => events.reduce((t, e) => applyEvent(t, e).tr, tr);
const texts = (tr: Transcript): string[] => tr.entries.map((e) => `${e.role}:${e.text}`);

describe("fromResume", () => {
  test("maps messages in seq order; lastSeq is lastEventSeq when no turn runs", () => {
    const tr = fromResume({ messages: [msg("m2", 2, "assistant", "hi", "t1"), msg("m1", 1, "user", "hello", "t1")], runningTurnId: null, lastEventSeq: 7 });
    assert.deepEqual(texts(tr), ["user:hello", "assistant:hi"]);
    assert.equal(tr.lastSeq, 7);
    assert.equal(tr.runningTurnId, null);
    assert.equal(tr.entries[1]?.state, "completed");
  });

  test("a running turn restarts event replay at 0 and keeps completed turns out of the replay", () => {
    const tr = fromResume({ messages: [msg("m1", 1, "user", "a", "t1"), msg("m2", 2, "assistant", "A", "t1"), msg("m3", 3, "user", "b", "t2")], runningTurnId: "t2", lastEventSeq: 9 });
    assert.equal(tr.lastSeq, 0);
    assert.equal(tr.runningTurnId, "t2");
    const after = apply(tr,
      ev(1, "turn.started", "t1"), ev(2, "delta", "t1", { text: "A" }), ev(3, "turn.completed", "t1"),
      ev(4, "turn.started", "t2"), ev(5, "delta", "t2", { index: 0, text: "par" }));
    assert.deepEqual(texts(after), ["user:a", "assistant:A", "user:b", "assistant:par"]);
    assert.equal(after.lastSeq, 5);
    assert.equal(after.entries[3]?.state, "running");
  });
});

describe("applyEvent", () => {
  const base = fromResume({ messages: [], runningTurnId: null, lastEventSeq: 0 });

  test("turn.started, deltas, turn.completed build one assistant entry", () => {
    const tr = apply(base, ev(1, "turn.started", "t1"), ev(2, "delta", "t1", { text: "Hel" }), ev(3, "delta", "t1", { text: "lo" }));
    assert.deepEqual(texts(tr), ["assistant:Hello"]);
    assert.equal(tr.runningTurnId, "t1");
    const done = apply(tr, ev(4, "turn.completed", "t1", { messageId: "m9" }));
    assert.equal(done.entries[0]?.state, "completed");
    assert.equal(done.runningTurnId, null);
  });

  test("a duplicate or older seq changes nothing (same object back)", () => {
    const tr = apply(base, ev(1, "turn.started", "t1"), ev(2, "delta", "t1", { text: "x" }));
    const r = applyEvent(tr, ev(2, "delta", "t1", { text: "x" }));
    assert.equal(r.tr, tr);
    assert.equal(r.gap, false);
    assert.equal(applyEvent(tr, ev(1, "turn.started", "t1")).tr, tr);
  });

  test("a gap is reported and not applied", () => {
    const tr = apply(base, ev(1, "turn.started", "t1"));
    const r = applyEvent(tr, ev(3, "delta", "t1", { text: "late" }));
    assert.equal(r.gap, true);
    assert.equal(r.tr, tr);
    assert.equal(r.tr.lastSeq, 1);
  });

  test("turn.failed keeps the streamed text and records the error", () => {
    const tr = apply(base, ev(1, "turn.started", "t1"), ev(2, "delta", "t1", { text: "half" }), ev(3, "turn.failed", "t1", { error: "cancelled" }));
    assert.deepEqual(texts(tr), ["assistant:half"]);
    assert.equal(tr.entries[0]?.state, "failed");
    assert.equal(tr.entries[0]?.error, "cancelled");
    assert.equal(tr.runningTurnId, null);
  });

  test("tool.call becomes a tool line; tool.result is ignored", () => {
    const tr = apply(base, ev(1, "turn.started", "t1"), ev(2, "tool.call", "t1", { id: "c1", name: "fake.tool" }), ev(3, "tool.result", "t1", { id: "c1", output: "ok" }));
    assert.deepEqual(texts(tr), ["assistant:", "tool:fake.tool"]);
    assert.equal(tr.lastSeq, 3);
  });

  test("non-string delta text is ignored, not rendered", () => {
    const tr = apply(base, ev(1, "turn.started", "t1"), ev(2, "delta", "t1", { text: 5 }));
    assert.deepEqual(texts(tr), ["assistant:"]);
  });
});

describe("addUser", () => {
  const base = fromResume({ messages: [], runningTurnId: null, lastEventSeq: 0 });

  test("adds the user line and a running assistant placeholder", () => {
    const tr = addUser(base, { id: "m1", text: "hi", turnId: "t1", state: "running" });
    assert.deepEqual(texts(tr), ["user:hi", "assistant:"]);
    assert.equal(tr.runningTurnId, "t1");
  });

  test("goes before an assistant entry that the stream already created, and does not revive a finished turn", () => {
    const streamed = apply(base, ev(1, "turn.started", "t1"), ev(2, "delta", "t1", { text: "yo" }), ev(3, "turn.completed", "t1"));
    const tr = addUser(streamed, { id: "m1", text: "hi", turnId: "t1", state: "running" });
    assert.deepEqual(texts(tr), ["user:hi", "assistant:yo"]);
    assert.equal(tr.runningTurnId, null);
    assert.equal(tr.entries[1]?.state, "completed");
  });

  test("adding the same message twice is a no-op", () => {
    const once = addUser(base, { id: "m1", text: "hi", turnId: "t1", state: "running" });
    assert.equal(addUser(once, { id: "m1", text: "hi", turnId: "t1", state: "running" }), once);
  });
});
