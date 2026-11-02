/** Rewind context readers must stay linear, preserve overlays and avoid reloading compacted history. */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { SessionStore } from "../../src/session/store.ts";
import { Compactor } from "../../src/session/compaction.ts";
import { ToolPruner } from "../../src/session/pruning.ts";
import { activePath } from "../../src/session/rewind-path.ts";

test("400 tool-heavy turns use the reference active path without a correlated events scan", t => {
  const store = new SessionStore({ path: ":memory:" });
  try {
    const session = store.createSession({ kind: "direct", agentId: "a", owner: "person" });
    for (let i = 0; i < 400; i++) {
      const { turn } = store.beginTurn(session.id, `task ${i}`, 1);
      for (let call = 0; call < 6; call++) {
        store.appendEvent(turn.id, "tool.call", { id: `${i}-${call}`, name: "file.read", args: {} });
        store.appendEvent(turn.id, "tool.result", { id: `${i}-${call}`, output: "fixture" });
      }
      store.completeTurn(turn.id, { text: `reply ${i}`, tokens: 1 });
    }
    const command = store.beginTurn(session.id, "/rewind invalid PRIVATE_NOTE", 1, { harnessCommand: true });
    store.failTurn(command.turn.id, "invalid-target");
    const commands = store.harnessCommandTurns(session.id);
    const expected = activePath(store.listMessages(session.id), store.rewinds(session.id))
      .filter(message => message.turnId === null || !commands.has(message.turnId));
    const queries: { sql: string; db: DatabaseSync }[] = [];
    const prepare = DatabaseSync.prototype.prepare;
    t.mock.method(DatabaseSync.prototype, "prepare", function(this: DatabaseSync, sql: string) {
      if (/\bFROM\s+messages\b/i.test(sql)) queries.push({ sql, db: this });
      return prepare.call(this, sql);
    });
    const began = performance.now();
    assert.deepEqual(store.contextMessages(session.id), expected);
    t.diagnostic(`400 turns x 6 tool calls: ${(performance.now() - began).toFixed(3)} ms`);
    assert.equal(queries.length, 1);
    for (const { sql, db } of queries) {
      const parameters = Array.from({ length: (sql.match(/\?/g) ?? []).length }, (_, i) => i ? 0 : session.id);
      const plan = prepare.call(db, `EXPLAIN QUERY PLAN ${sql}`).all(...parameters);
      assert.doesNotMatch(plan.map(row => String(row.detail)).join("\n"), /CORRELATED/i);
    }
  } finally { store.close(); }
});

test("a lower context boundary preserves rewind and undo filtering without changing stored rows", () => {
  const store = new SessionStore({ path: ":memory:" });
  try {
    const session = store.createSession({ kind: "direct", agentId: "a", owner: "person" });
    for (let i = 0; i < 4; i++) {
      const { turn } = store.beginTurn(session.id, `task ${i}`, 1);
      store.completeTurn(turn.id, { text: `reply ${i}`, tokens: 1 });
    }
    const before = store.listMessages(session.id);
    const check = () => assert.deepEqual(store.contextMessages(session.id, { afterSeq: 2 }),
      store.contextMessages(session.id).filter(message => message.seq > 2));
    check();
    const rewind = store.rewindPath(session.id, { toSeq: 4, lesson: "lesson", actor: "person", trigger: "user" });
    check();
    store.undoRewind(session.id, rewind.id, "person");
    check();
    assert.deepEqual(store.listMessages(session.id).slice(0, before.length), before);
  } finally { store.close(); }
});

test("the ordinary compaction path reads only the continuously summarized prefix's tail", t => {
  const store = new SessionStore({ path: ":memory:" });
  try {
    const session = store.createSession({ kind: "direct", agentId: "a", owner: "person" });
    for (let i = 0; i < 4; i++) {
      const { turn } = store.beginTurn(session.id, `task ${i}`, 1);
      store.completeTurn(turn.id, { text: `reply ${i}`, tokens: 1 });
    }
    store.addSummary({ sessionId: session.id, fromSeq: 1, toSeq: 4, text: "prefix", tokens: 1, tier: 1, state: "applied" });
    const read = t.mock.method(store, "contextMessages");
    const view = new Compactor(store).view(session.id);
    assert.deepEqual(view.messages.map(message => message.seq), [5, 6, 7, 8]);
    assert.deepEqual(read.mock.calls[0]?.arguments, [session.id, { afterSeq: 4 }]);
  } finally { store.close(); }
});

test("a gap in applied summaries and explicitly restored old tools remain visible", () => {
  const store = new SessionStore({ path: ":memory:" });
  try {
    const session = store.createSession({ kind: "direct", agentId: "a", owner: "person" });
    const first = store.beginTurn(session.id, "old task", 1);
    const call = store.appendEvent(first.turn.id, "tool.call", { id: "old", name: "file.read", args: {} });
    store.appendEvent(first.turn.id, "tool.result", { id: "old", output: "RESTORED_ORIGINAL" });
    store.completeTurn(first.turn.id, { text: "old reply", tokens: 1 });
    const next = store.beginTurn(session.id, "new task", 1);
    store.completeTurn(next.turn.id, { text: "new reply", tokens: 1 });
    store.addSummary({ sessionId: session.id, fromSeq: 3, toSeq: 4, text: "later", tokens: 1, tier: 1, state: "applied" });
    assert.deepEqual(new Compactor(store).view(session.id).messages.map(message => message.seq), [1, 1, 2]);
    store.addSummary({ sessionId: session.id, fromSeq: 1, toSeq: 2, text: "earlier", tokens: 1, tier: 1, state: "applied" });
    store.setToolVisibility(session.id, `event:${call.seq}`, false, "human-restored");
    const view = new Compactor(store, undefined, { pruner: new ToolPruner(store) }).view(session.id);
    assert.equal(view.messages.length, 1);
    assert.match(view.messages[0]!.text, /RESTORED_ORIGINAL/);
  } finally { store.close(); }
});
