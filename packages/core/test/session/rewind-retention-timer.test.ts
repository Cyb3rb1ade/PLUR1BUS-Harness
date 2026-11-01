import assert from "node:assert/strict";
import { setImmediate as nextLoop } from "node:timers/promises";
import { test } from "node:test";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import { CheckpointRetention } from "../../src/session/checkpoint-retention.ts";
import { SessionStore } from "../../src/session/store.ts";

test("a pending restore cannot block later card-completion maintenance checks", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = new SessionStore({ path: ":memory:" }), cancel = new AbortController();
  const session = store.createSession({ kind: "card", agentId: "a", owner: "owner" });
  const turn = store.beginTurn(session.id, "edit", 1);
  store.recordCheckpoint({ sessionId: session.id, turnId: turn.turn.id, projectId: "p", cardId: "c", root: "/fixture",
    ref: "refs/plur1bus/checkpoints/fixture", tree: "a".repeat(40), commitId: "b".repeat(40) });
  store.completeTurn(turn.turn.id, { text: "done", tokens: 1 });
  let ended = false, checks = 0, removed = 0, enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const retention = new CheckpointRetention({ store, audit: memoryAuditSink(), now: Date.now,
    cardEnded: () => { checks++; return ended; }, remove: async () => { removed++; } });
  let pending: Promise<unknown> | undefined;
  try {
    await retention.idle();
    pending = retention.run(session.id, cancel.signal, signal => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true }); enter();
    }));
    void pending.catch(() => {}); await entered;
    const before = checks;
    t.mock.timers.tick(10_000); await nextLoop();
    assert.ok(checks > before);
    const first = checks; ended = true;
    t.mock.timers.tick(10_000); await nextLoop();
    assert.ok(checks > first, "maintenance keeps checking while the session awaits its approval");
    await assert.rejects(pending, { name: "SessionError", code: "conflict", reason: "rewind-checkpoint-unavailable" });
    await retention.idle();
    assert.equal(removed, 1); assert.equal(store.hasCheckpoints(), false);
    assert.equal(store.listMessages(session.id).length, 2);
  } finally { cancel.abort(); await pending?.catch(() => {}); await retention.close(); store.close(); }
});
