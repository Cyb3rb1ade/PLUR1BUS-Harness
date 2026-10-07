import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SessionStore } from "../../src/session/store.ts";
import { SessionError } from "../../src/session/types.ts";
import { MIGRATIONS } from "../../src/session/migrations.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const ALICE = "user:v1:alice"; const BOB = "user:v1:bob";
function mk(): { store: SessionStore; tick: () => number } {
  let t = 1_000;
  const tick = () => ++t;
  return { store: new SessionStore({ path: ":memory:", clock: tick }), tick };
}
const code = (c: string, reason?: string) => (e: unknown) => e instanceof SessionError && e.code === c && (reason === undefined || e.reason === reason);

describe("session store", () => {
  it("I1: kind, agent, owner, scope are immutable — through the API and through raw SQL", () => {
    const { store } = mk();
    const s = store.createSession({ kind: "direct", agentId: "bernd", owner: ALICE });
    for (const patch of [{ kind: "card" }, { agentId: "x" }, { owner: BOB }, { scope: "global" }, { chatKey: "tg:1" }]) {
      assert.throws(() => store.updateSession(s.id, patch as never), code("immutable"), JSON.stringify(patch));
    }
    assert.deepEqual({ k: store.getSession(s.id)!.kind, a: store.getSession(s.id)!.agentId, o: store.getSession(s.id)!.owner }, { k: "direct", a: "bernd", o: ALICE });
    assert.equal(store.updateSession(s.id, { title: "Hi", pinned: true, memoryMode: "incognito" }).title, "Hi");
    // Defence in depth: the trigger refuses a direct UPDATE as well.
    const dir = tempDir("p1b-store-"); const path = join(dir, "s.db");
    const file = new SessionStore({ path }); const f = file.createSession({ kind: "direct", agentId: "bernd", owner: ALICE }); file.close();
    const raw = new DatabaseSync(path);
    assert.throws(() => raw.prepare("UPDATE sessions SET owner = 'x' WHERE id = ?").run(f.id), /I1/);
    raw.close();
  });

  it("D21: one active session per chat; /new replaces atomically", () => {
    const { store } = mk();
    const a = store.createSession({ kind: "channel", agentId: "bernd", owner: ALICE, chatKey: "telegram:42" });
    assert.throws(() => store.createSession({ kind: "channel", agentId: "bernd", owner: ALICE, chatKey: "telegram:42" }), code("conflict", "active-chat-session"));
    assert.equal(store.createSession({ kind: "channel", agentId: "bernd", owner: ALICE, chatKey: "telegram:43" }).chatKey, "telegram:43");
    const b = store.createSession({ kind: "channel", agentId: "bernd", owner: ALICE, chatKey: "telegram:42", replaceActive: true });
    assert.notEqual(a.id, b.id);
    assert.notEqual(store.getSession(a.id)!.archivedAt, null);
    assert.equal(store.getSession(b.id)!.archivedAt, null);
    assert.throws(() => store.createSession({ kind: "channel", agentId: "b", owner: ALICE }), code("invalid", "chat-key"));
    assert.throws(() => store.createSession({ kind: "direct", agentId: "b", owner: ALICE, chatKey: "x" }), code("invalid", "chat-key"));
  });

  it("archive-first: archive hides, keeps rows, erasure refuses until archived and leaves a content-free tombstone", () => {
    const { store } = mk();
    const s = store.createSession({ kind: "direct", agentId: "bernd", owner: ALICE });
    const { turn } = store.beginTurn(s.id, "secret plan", 3);
    store.completeTurn(turn.id, { text: "ok", tokens: 1 });
    assert.throws(() => store.eraseSession(s.id, { actor: "owner", reason: "gdpr" }), code("conflict", "not-archived"));
    const arch = store.archiveSession(s.id);
    assert.notEqual(arch.archivedAt, null);
    assert.equal(store.listSessions({ owner: ALICE }).sessions.length, 0);
    assert.equal(store.listSessions({ owner: ALICE, archived: "only" }).sessions.length, 1);
    assert.equal(store.listMessages(s.id).length, 2); // archived, not deleted
    assert.throws(() => store.beginTurn(s.id, "more", 1), code("conflict", "archived"));
    assert.equal(store.archiveSession(s.id).archivedAt, arch.archivedAt); // idempotent
    const r = store.eraseSession(s.id, { actor: "owner", reason: "gdpr" });
    assert.equal(r.messages, 2);
    assert.equal(store.getSession(s.id), null);
    assert.equal(store.searchMessages({ owner: ALICE, search: "secret", archived: "any" }).length, 0);
    const [t] = store.erasures();
    assert.deepEqual({ s: t!.sessionId, o: t!.owner, n: t!.messageCount, a: t!.actor }, { s: s.id, o: ALICE, n: 2, a: "owner" });
    assert.ok(!JSON.stringify(t).includes("secret"));
    assert.throws(() => store.eraseSession("nope", { actor: "a", reason: "r" }), code("not-found"));
  });

  it("archive refuses while a turn is running", () => {
    const { store } = mk();
    const s = store.createSession({ kind: "direct", agentId: "bernd", owner: ALICE });
    store.beginTurn(s.id, "hi", 1);
    assert.throws(() => store.archiveSession(s.id), code("conflict", "turn-in-progress"));
  });

  it("one running turn per session; events are gap-free and ordered per session", () => {
    const { store } = mk();
    const s = store.createSession({ kind: "direct", agentId: "bernd", owner: ALICE });
    const { turn, event } = store.beginTurn(s.id, "hi", 1);
    assert.equal(event.type, "turn.started");
    assert.throws(() => store.beginTurn(s.id, "again", 1), code("conflict", "turn-in-progress"));
    store.appendEvent(turn.id, "delta", { text: "a" });
    store.appendEvent(turn.id, "tool.call", { name: "x" });
    store.completeTurn(turn.id, { text: "a", tokens: 1 });
    assert.deepEqual(store.listEvents(s.id).map((e) => [e.seq, e.type]), [[1, "turn.started"], [2, "delta"], [3, "tool.call"], [4, "turn.completed"]]);
    assert.deepEqual(store.listEvents(s.id, 2).map((e) => e.seq), [3, 4]);
    assert.throws(() => store.appendEvent(turn.id, "delta", {}), code("conflict", "turn-not-running"));
    assert.equal(store.completeTurn(turn.id, { text: "x", tokens: 1 }), null); // not twice
    store.beginTurn(s.id, "next", 1); // allowed again
  });

  it("crash recovery: a running turn is marked failed with a turn.failed event", () => {
    const dir = tempDir("p1b-store-"); const path = join(dir, "s.db");
    const first = new SessionStore({ path });
    const s = first.createSession({ kind: "direct", agentId: "bernd", owner: ALICE });
    const { turn } = first.beginTurn(s.id, "hi", 1);
    first.close(); // the core died mid-turn
    const second = new SessionStore({ path });
    const ev = second.recoverRunningTurns();
    assert.equal(ev.length, 1);
    assert.deepEqual({ t: ev[0]!.type, e: ev[0]!.data.error }, { t: "turn.failed", e: "core-restarted" });
    assert.equal(second.getTurn(turn.id)!.state, "failed");
    assert.equal(second.runningTurn(s.id), null);
    assert.equal(second.recoverRunningTurns().length, 0);
    second.beginTurn(s.id, "after", 1);
  });

  it("FTS: finds messages and titles, scoped to the owner, with filters and hostile query text", () => {
    const { store } = mk();
    const a = store.createSession({ kind: "direct", agentId: "bernd", owner: ALICE, title: "Garden plans" });
    const b = store.createSession({ kind: "direct", agentId: "bernd", owner: BOB });
    const c = store.createSession({ kind: "card", agentId: "ada", owner: ALICE });
    for (const [s, text] of [[a, "the zucchini harvest"], [b, "zucchini of bob"], [c, "zucchini card"]] as const) {
      const { turn } = store.beginTurn(s.id, text, 3); store.completeTurn(turn.id, { text: "noted", tokens: 1 });
    }
    assert.deepEqual(store.listSessions({ owner: ALICE, search: "zucchini" }).sessions.map((s) => s.id).sort(), [a.id, c.id].sort());
    assert.deepEqual(store.listSessions({ owner: BOB, search: "zucchini" }).sessions.map((s) => s.id), [b.id]);
    assert.deepEqual(store.listSessions({ owner: ALICE, search: "zucchini", kind: "card" }).sessions.map((s) => s.id), [c.id]);
    assert.deepEqual(store.listSessions({ owner: ALICE, search: "zucchini", agentId: "bernd" }).sessions.map((s) => s.id), [a.id]);
    assert.deepEqual(store.listSessions({ owner: ALICE, search: "garden" }).sessions.map((s) => s.id), [a.id]); // title
    const hits = store.searchMessages({ owner: ALICE, search: "harvest" });
    assert.equal(hits.length, 1); assert.match(hits[0]!.snippet, /\[harvest\]/);
    assert.equal(store.searchMessages({ owner: BOB, search: "harvest" }).length, 0);
    for (const evil of ['"', "zucchini OR", "* NEAR(", "a:b", "NOT"]) assert.doesNotThrow(() => store.listSessions({ owner: ALICE, search: evil }), evil);
    assert.throws(() => store.listSessions({ owner: ALICE, search: "   " }), code("invalid", "search-empty"));
    store.updateSession(a.id, { title: "Orchard" });
    assert.equal(store.listSessions({ owner: ALICE, search: "garden" }).sessions.length, 0); // title index follows renames
    assert.equal(store.listSessions({ owner: ALICE, search: "orchard" }).sessions.length, 1);
  });

  it("list order: pinned first, then most recent turn; limit reports truncation", () => {
    const { store } = mk();
    const x = store.createSession({ kind: "direct", agentId: "b", owner: ALICE });
    const y = store.createSession({ kind: "direct", agentId: "b", owner: ALICE });
    const z = store.createSession({ kind: "direct", agentId: "b", owner: ALICE });
    store.beginTurn(x.id, "hi", 1); // x has the latest turn
    store.updateSession(z.id, { pinned: true });
    const l = store.listSessions({ owner: ALICE });
    assert.deepEqual(l.sessions.map((s) => s.id), [z.id, x.id, y.id]);
    const two = store.listSessions({ owner: ALICE, limit: 2 });
    assert.equal(two.sessions.length, 2); assert.equal(two.truncated, true);
  });

  it("getOwned hides other owners' sessions as not-found", () => {
    const { store } = mk();
    const s = store.createSession({ kind: "direct", agentId: "b", owner: ALICE });
    assert.equal(store.getOwned(s.id, ALICE).id, s.id);
    assert.throws(() => store.getOwned(s.id, BOB), code("not-found"));
  });

  it("migrations are versioned and a newer file is refused", () => {
    const dir = tempDir("p1b-store-"); const path = join(dir, "s.db");
    new SessionStore({ path }).close();
    const raw = new DatabaseSync(path);
    assert.equal((raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, MIGRATIONS.length);
    raw.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`); raw.close();
    assert.throws(() => new SessionStore({ path }), code("storage", "schema-too-new"));
  });
});
