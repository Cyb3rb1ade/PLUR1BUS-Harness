import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSessionService } from "../../src/session/service.ts";
import { FakeChatProvider } from "../../src/session/provider.ts";
import { userPrincipalHash } from "../../src/principal.ts";

const ALICE = { channel: "cli" as const, accountId: "host", userId: "alice" };
const BOB = { channel: "cli" as const, accountId: "host", userId: "bob" };
const logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; }, async close() {} } as never;

function rig(gate?: () => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "p1b-meth-owner-"));
  const sessions = openSessionService({
    dbPath: join(root, "sessions.sqlite"), clock: Date.now, logger, agents: { workspaceOf: () => "/ws", has: () => true, list: () => ["bernd"] } as never, isStopping: () => false,
    provider: () => new FakeChatProvider(gate ? { gate } : {}) as never, notify() {}, signal: new AbortController().signal,
    memory: { recall: async () => ({ text: "", degraded: null }), capture: async () => {}, checkpoint: async () => {} } as never,
  });
  const call = (m: string, p: object) => sessions.methods[m]!(p, { signal: new AbortController().signal } as never) as Promise<any>;
  const done = async () => { await sessions.close(); rmSync(root, { recursive: true, force: true }); };
  return { root, sessions, call, done };
}
const conflict = (reason: string) => (e: any) => { assert.equal(e.error, "E_CONFLICT", `${e.error}: ${e.message}`); assert.equal(e.reason, reason); return true; };

describe("session.create: chat sessions and incognito over the methods", () => {
  it("replaceActive replaces only the caller's own channel session; a foreign owner is refused and the session survives", async () => {
    const r = rig();
    try {
      const mine = (await r.call("session.create", { caller: ALICE, agentId: "bernd", kind: "channel", chatKey: "cli:chat-100" })).session;
      await assert.rejects(r.call("session.create", { caller: BOB, agentId: "bernd", kind: "channel", chatKey: "cli:chat-100", replaceActive: true }), conflict("active-chat-session"));
      assert.equal(r.sessions.store.getSession(mine.id)!.archivedAt, null, "her session was not archived");
      assert.equal(r.sessions.store.activeForChat("cli:chat-100")!.owner, userPrincipalHash(ALICE), "the chat still belongs to her");
      assert.deepEqual((await r.call("session.list", { caller: BOB, kind: "channel" })).sessions, [], "nothing was created for him");
      // legitimate: the owner replaces her own idle session
      const next = (await r.call("session.create", { caller: ALICE, agentId: "bernd", kind: "channel", chatKey: "cli:chat-100", replaceActive: true })).session;
      assert.notEqual(next.id, mine.id);
      assert.notEqual(r.sessions.store.getSession(mine.id)!.archivedAt, null);
    } finally { await r.done(); }
  });

  it("a chatKey must name the caller's own channel: a member cannot pre-claim a foreign chat (Telegram group) before it has a session", async () => {
    const r = rig();
    try {
      const invalid = (e: any) => { assert.equal(e.error, "E_INVALID_PARAMS", `${e.error}: ${e.message}`); assert.equal(e.reason, "chat-key"); return true; };
      for (const chatKey of ["telegram:-100", "slack:C123", "matrix:!room", "cli", "cli:", "clix:1", ":1"]) {
        await assert.rejects(r.call("session.create", { caller: BOB, agentId: "bernd", kind: "channel", chatKey }), invalid, chatKey);
        await assert.rejects(r.call("session.create", { caller: BOB, agentId: "bernd", kind: "channel", chatKey, replaceActive: true }), invalid, `${chatKey} replaceActive`);
      }
      assert.equal(r.sessions.store.activeForChat("telegram:-100"), null, "the group's chat key stays unclaimed");
      assert.deepEqual((await r.call("session.list", { caller: BOB, kind: "channel" })).sessions, [], "nothing was created");
      // the caller's own channel is fine
      assert.equal((await r.call("session.create", { caller: BOB, agentId: "bernd", kind: "channel", chatKey: "cli:mine" })).session.chatKey, "cli:mine");
    } finally { await r.done(); }
  });

  it("replaceActive does not cancel the owner's own running turn", async () => {
    let release!: () => void; const gate = new Promise<void>((res) => { release = res; });
    const r = rig(async () => { await gate; });
    try {
      const mine = (await r.call("session.create", { caller: ALICE, agentId: "bernd", kind: "channel", chatKey: "cli:chat-101" })).session;
      const sub = await r.call("session.submit", { caller: ALICE, sessionId: mine.id, text: "long work" });
      assert.equal(sub.state, "running");
      await assert.rejects(r.call("session.create", { caller: ALICE, agentId: "bernd", kind: "channel", chatKey: "cli:chat-101", replaceActive: true }), conflict("turn-in-progress"));
      assert.equal(r.sessions.store.getSession(mine.id)!.archivedAt, null);
      release();
      await r.sessions.runner.idle();
      assert.equal((await r.call("session.create", { caller: ALICE, agentId: "bernd", kind: "channel", chatKey: "cli:chat-101", replaceActive: true })).session.kind, "channel");
    } finally { release(); await r.done(); }
  });

  it("incognito: the session, its transcript and its events live only in the memory store; the durable file never sees them", async () => {
    const r = rig();
    try {
      const { session } = await r.call("session.create", { caller: ALICE, agentId: "bernd", memoryMode: "incognito" });
      assert.equal(r.sessions.store.getSession(session.id), null, "not in the durable store");
      assert.notEqual(r.sessions.ephemeral().store.getSession(session.id), null, "in the memory-only store");
      const sub = await r.call("session.submit", { caller: ALICE, sessionId: session.id, text: "the vault code is quokka-42", wait: true });
      assert.equal(sub.state, "completed");
      assert.equal((await r.call("session.resume", { caller: ALICE, sessionId: session.id })).messages.length, 2);
      assert.equal((await r.call("session.events", { caller: ALICE, sessionId: session.id })).events.at(-1).type, "turn.completed");
      assert.equal(r.sessions.store.listMessages(session.id).length, 0);
      // a remembered session next to it keeps working on the durable store
      const kept = (await r.call("session.create", { caller: ALICE, agentId: "bernd" })).session;
      assert.equal((await r.call("session.submit", { caller: ALICE, sessionId: kept.id, text: "hello there", wait: true })).state, "completed");
      assert.equal(r.sessions.store.listMessages(kept.id).length, 2);
      // the owner archives it through the same method; another person never sees it
      await assert.rejects(r.call("session.archive", { caller: BOB, sessionId: session.id }), (e: any) => e.error === "E_NOT_FOUND");
      assert.notEqual((await r.call("session.archive", { caller: ALICE, sessionId: session.id })).session.archivedAt, null);
      // nothing of the incognito text reached any file under the data dir (db, wal, shm)
      for (const f of readdirSync(r.root)) assert.equal(readFileSync(join(r.root, f)).includes("quokka"), false, f);
    } finally { await r.done(); }
  });
});
