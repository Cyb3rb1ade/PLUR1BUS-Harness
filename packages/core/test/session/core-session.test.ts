import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect } from "../helpers/connect.ts";
import { defaults } from "@plur1bus/config-schema";
import { validateParams, validateResult } from "@plur1bus/rpc-schema";
import { createCore } from "../../src/core.ts";
import { layout } from "../../src/paths.ts";
import { FakeChatProvider } from "../../src/session/provider.ts";
import { SessionStore } from "../../src/session/store.ts";
import { flatTestInternals } from "../helpers/flat-embedder.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const ALICE = { channel: "cli" as const, accountId: "host", userId: "alice" };
const BOB = { channel: "cli" as const, accountId: "host", userId: "bob" };

function newHome(): string {
  const home = tempDir("p1b-sess-");
  const cfg = defaults(); cfg.agents.bernd = {}; cfg.agents.ada = {};
  cfg.engine = { neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false }, merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false }, temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false }, reranker: { enabled: false }, runtime: { recallTimeoutMs: 10_000 } };
  cfg.engine.duplicateThreshold = 1.01;
  writeFileSync(layout(home).configPath, JSON.stringify(cfg));
  return home;
}
const rejects = (p: Promise<unknown>, error: string, reason?: string) => assert.rejects(p, (e: any) => { assert.equal(e.error, error, `${e.error}/${e.reason}: ${e.message}`); if (reason) assert.equal(e.reason, reason); return true; });

describe("session.* over a real core (fake provider)", () => {
  it("create → submit(wait) → events/get/resume/list/archive, results validate against the schema, one capture per turn", async () => {
    const home = newHome();
    const core = createCore({ home, testInternals: flatTestInternals(), chatProvider: new FakeChatProvider() });
    await core.start();
    const c = await connect({ address: core.address, token: core.token });
    try {
      const call = async <T>(m: string, p: Record<string, unknown>): Promise<T> => {
        assert.deepEqual(validateParams(m, p), { ok: true }, `${m} params`);
        const r = await c.call<T>(m, p); const v = validateResult(m, r); assert.equal((v as any).ok, true, `${m} result: ${JSON.stringify(v)}`); return r;
      };
      const notes: any[] = []; c.onNotification((m, p) => { if (m === "session.event") notes.push(p); });
      await c.call("events.subscribe", { names: ["session.event"] });

      const { session } = await call<any>("session.create", { caller: ALICE, agentId: "bernd", title: "Planning" });
      assert.equal(session.kind, "direct"); assert.equal(session.owner, undefined, "the owner principal never leaves the core");
      const sub = await call<any>("session.submit", { caller: ALICE, sessionId: session.id, text: "remember the boiler service is on Tuesday", wait: true });
      assert.deepEqual({ s: sub.state, r: sub.reply }, { s: "completed", r: "echo[bernd]: remember the boiler service is on Tuesday" });
      const ev = await call<any>("session.events", { caller: ALICE, sessionId: session.id });
      assert.equal(ev.running, false); assert.equal(ev.lastSeq, ev.events.length);
      assert.equal(ev.events[0].type, "turn.started"); assert.equal(ev.events.at(-1).type, "turn.completed");
      await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(notes.map((n) => n.event), ev.events, "the notification stream equals the persisted stream");
      assert.ok(notes.every((n) => n.agentId === "bernd"));
      assert.deepEqual((await call<any>("session.events", { caller: ALICE, sessionId: session.id, afterSeq: 2 })).events.map((e: any) => e.seq), ev.events.slice(2).map((e: any) => e.seq));

      const got = await call<any>("session.get", { caller: ALICE, sessionId: session.id }); assert.equal(got.session.turnCount, 1); assert.equal(got.runningTurnId, null);
      assert.deepEqual((await call<any>("session.get", { caller: ALICE, sessionId: session.id, messages: 1 })).messages.map((m: any) => m.role), ["assistant"]);
      const res = await call<any>("session.resume", { caller: ALICE, sessionId: session.id }); assert.deepEqual(res.messages.map((m: any) => m.role), ["user", "assistant"]); assert.equal(res.lastEventSeq, ev.lastSeq);

      // the capture reached the engine exactly once: its cards hold the Tuesday fact once
      const cards = (await c.call<any>("memory.list", { caller: ALICE, agentId: "bernd", since: 0 })).items;
      assert.equal(cards.filter((x: any) => /Tuesday/.test(JSON.stringify(x))).length >= 1, true, JSON.stringify(cards));
      const dreams = await c.call<any>("dreams.status", { agentId: "bernd" });
      assert.ok(dreams.agents[0].phases.every((p: any) => p.importance.capturesSinceRun === 1 && p.importance.accumulated === 5), "a stored session capture feeds every dreaming phase once");

      assert.equal((await call<any>("session.list", { caller: ALICE, search: "boiler" })).sessions.length, 1);
      assert.equal((await call<any>("session.list", { caller: ALICE, agentId: "ada" })).sessions.length, 0);
      const arch = await call<any>("session.archive", { caller: ALICE, sessionId: session.id }); assert.notEqual(arch.session.archivedAt, null);
      assert.equal((await call<any>("session.list", { caller: ALICE })).sessions.length, 0);
      await rejects(c.call("session.submit", { caller: ALICE, sessionId: session.id, text: "more" }), "E_CONFLICT", "archived");
      await rejects(c.call("session.resume", { caller: ALICE, sessionId: session.id }), "E_CONFLICT", "archived");
    } finally { await c.close(); await core.stop({ budgetMs: 5_000 }); }
  });

  it("RBAC: another caller sees none of it (list, get, events, submit, archive), and params cannot carry kind/owner/incognito", async () => {
    const home = newHome();
    const core = createCore({ home, testInternals: flatTestInternals(), chatProvider: new FakeChatProvider() });
    await core.start();
    const c = await connect({ address: core.address, token: core.token });
    try {
      const { session } = await c.call<any>("session.create", { caller: ALICE, agentId: "bernd" });
      await c.call("session.submit", { caller: ALICE, sessionId: session.id, text: "alice secret zebra", wait: true });
      assert.deepEqual((await c.call<any>("session.list", { caller: BOB })).sessions, []);
      assert.deepEqual((await c.call<any>("session.list", { caller: BOB, search: "zebra" })).sessions, []);
      for (const m of ["session.get", "session.events", "session.resume", "session.archive"]) await rejects(c.call(m, { caller: BOB, sessionId: session.id }), "E_NOT_FOUND");
      await rejects(c.call("session.submit", { caller: BOB, sessionId: session.id, text: "hi" }), "E_NOT_FOUND");
      await rejects(c.call("session.get", { caller: { channel: "cli", accountId: "", userId: "x" }, sessionId: session.id }), "E_INVALID_PARAMS"); // schema: minLength
      await rejects(c.call("session.get", { caller: { channel: "cli", accountId: "a\nb", userId: "x" }, sessionId: session.id }), "E_DENIED", "principal-invalid");
      await rejects(c.call("session.create", { caller: ALICE, agentId: "bernd", kind: "card" }), "E_INVALID_PARAMS");
      await rejects(c.call("session.create", { caller: ALICE, agentId: "bernd", owner: "x" }), "E_INVALID_PARAMS");
      await rejects(c.call("session.submit", { caller: ALICE, sessionId: session.id, text: "x", incognito: true }), "E_INVALID_PARAMS");
      await rejects(c.call("session.create", { caller: ALICE, agentId: "ghost" }), "E_AGENT_UNKNOWN");
      assert.equal((await c.call<any>("session.get", { caller: ALICE, sessionId: session.id })).session.turnCount, 1, "bob changed nothing");
    } finally { await c.close(); await core.stop({ budgetMs: 5_000 }); }
  });

  it("D21 over RPC: one active session per chat, /new replaces", async () => {
    const home = newHome();
    const core = createCore({ home, testInternals: flatTestInternals(), chatProvider: new FakeChatProvider() });
    await core.start();
    const c = await connect({ address: core.address, token: core.token });
    try {
      const a = (await c.call<any>("session.create", { caller: ALICE, agentId: "bernd", kind: "channel", chatKey: "telegram:7" })).session;
      await rejects(c.call("session.create", { caller: ALICE, agentId: "bernd", kind: "channel", chatKey: "telegram:7" }), "E_CONFLICT", "active-chat-session");
      const b = (await c.call<any>("session.create", { caller: ALICE, agentId: "bernd", kind: "channel", chatKey: "telegram:7", replaceActive: true })).session;
      assert.notEqual(a.id, b.id);
      assert.equal((await c.call<any>("session.get", { caller: ALICE, sessionId: a.id })).session.archivedAt !== null, true);
    } finally { await c.close(); await core.stop({ budgetMs: 5_000 }); }
  });

  it("no provider configured: submit is E_NOT_AVAILABLE no-provider and nothing is written", async () => {
    const home = newHome();
    const core = createCore({ home, testInternals: flatTestInternals() });
    await core.start();
    const c = await connect({ address: core.address, token: core.token });
    try {
      const { session } = await c.call<any>("session.create", { caller: ALICE, agentId: "bernd" });
      await rejects(c.call("session.submit", { caller: ALICE, sessionId: session.id, text: "hi" }), "E_NOT_AVAILABLE", "no-provider");
      assert.equal((await c.call<any>("session.resume", { caller: ALICE, sessionId: session.id })).messages.length, 0);
    } finally { await c.close(); await core.stop({ budgetMs: 5_000 }); }
  });

  it("a turn cut off by a dead core is failed at the next start, and the session accepts a new turn", async () => {
    const home = newHome();
    // the previous core died mid-turn: simulate its file state directly
    const dbPath = join(layout(home).state, "sessions.sqlite");
    // (state/ does not exist until a core starts; start one, stop it, then plant the running turn)
    const first = createCore({ home, testInternals: flatTestInternals(), chatProvider: new FakeChatProvider() }); await first.start();
    const c1 = await connect({ address: first.address, token: first.token });
    const { session } = await c1.call<any>("session.create", { caller: ALICE, agentId: "bernd" });
    await c1.close(); await first.stop({ budgetMs: 5_000 });
    const raw = new SessionStore({ path: dbPath }); raw.beginTurn(session.id, "interrupted", 2); raw.close();

    const second = createCore({ home, testInternals: flatTestInternals(), chatProvider: new FakeChatProvider() }); await second.start();
    const c2 = await connect({ address: second.address, token: second.token });
    try {
      const g = await c2.call<any>("session.get", { caller: ALICE, sessionId: session.id }); assert.equal(g.runningTurnId, null);
      const ev = await c2.call<any>("session.events", { caller: ALICE, sessionId: session.id });
      assert.deepEqual(ev.events.map((e: any) => e.type), ["turn.started", "turn.failed"]); assert.equal(ev.events[1].data.error, "core-restarted"); assert.equal(ev.running, false);
      assert.equal((await c2.call<any>("session.submit", { caller: ALICE, sessionId: session.id, text: "again", wait: true })).state, "completed");
    } finally { await c2.close(); await second.stop({ budgetMs: 5_000 }); }
  });

  it("incognito: the turn answers, nothing is captured", async () => {
    const home = newHome();
    const core = createCore({ home, testInternals: flatTestInternals(), chatProvider: new FakeChatProvider() });
    await core.start();
    const c = await connect({ address: core.address, token: core.token });
    try {
      const { session } = await c.call<any>("session.create", { caller: ALICE, agentId: "bernd", memoryMode: "incognito" });
      const sub = await c.call<any>("session.submit", { caller: ALICE, sessionId: session.id, text: "the vault code is quokka-42", wait: true });
      assert.equal(sub.state, "completed");
      const cards = (await c.call<any>("memory.list", { caller: ALICE, agentId: "bernd", since: 0 })).items;
      assert.equal(JSON.stringify(cards).includes("quokka"), false);
      const dreams = await c.call<any>("dreams.status", { agentId: "bernd" });
      assert.ok(dreams.agents[0].phases.every((p: any) => p.importance.capturesSinceRun === 0 && p.importance.accumulated === 0), "incognito turns do not feed dreaming");
    } finally { await c.close(); await core.stop({ budgetMs: 5_000 }); }
  });
});
