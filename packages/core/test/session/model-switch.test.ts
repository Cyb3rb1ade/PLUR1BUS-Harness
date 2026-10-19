import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { SessionStore } from "../../src/session/store.ts";
import { buildSessionMethods } from "../../src/session/methods.ts";
import { userPrincipalHash } from "../../src/principal.ts";
const caller = { channel: "cli" as const, accountId: "a", userId: "u" };
const owner = userPrincipalHash(caller);
test("L9: preview never mutates, explicit revision confirmation persists, rejects stale/foreign/busy switches", async () => {
  const root = mkdtempSync(join(tmpdir(), "p1b-switch-")), path = join(root, "sessions.sqlite");
  let store = new SessionStore({ path });
  try {
    const session = store.createSession({ kind: "direct", agentId: "bernd", owner });
    const methods = buildSessionMethods({ store, runner: {} as never, agents: { workspaceOf: () => "/ws" } as never, isStopping: () => false, modelProfiles: () => ["default", "second"] });
    const call = (extra: object = {}) => methods["session.model.set"]!({ caller, sessionId: session.id, profile: "second", ...extra }, { signal: new AbortController().signal } as never) as Promise<any>;
    const preview = await call(); assert.equal(preview.applied, false); assert.equal(preview.warning, "cache-rebuild-cost-prefixes-preserved");
    assert.deepEqual(store.modelProfile(session.id), { profile: null, revision: 0 });
    await assert.rejects(call({ confirmed: true }), (e: any) => e.error === "E_INVALID_PARAMS");
    await assert.rejects(call({ caller: { ...caller, userId: "foreign" } }), (e: any) => e.error === "E_NOT_FOUND");
    await assert.rejects(call({ profile: "missing" }), (e: any) => e.reason === "model-profile-unavailable");
    const applied = await call({ confirmed: true, expectedRevision: preview.revision }); assert.equal(applied.applied, true); assert.equal(applied.revision, 1);
    await assert.rejects(call({ confirmed: true, expectedRevision: preview.revision }), (e: any) => e.reason === "stale-model-preview");
    assert.equal(store.modelProfile(session.id).profile, "second");
    // A -> B -> A never revives the earlier preview: revision increases on every confirmed change.
    await call({ profile: "default", confirmed: true, expectedRevision: 1 });
    await call({ profile: "second", confirmed: true, expectedRevision: 2 });
    await assert.rejects(call({ confirmed: true, expectedRevision: 1 }), (e: any) => e.reason === "stale-model-preview");
    const turn = store.beginTurn(session.id, "hello", 2);
    await assert.rejects(call({ confirmed: true, expectedRevision: 3 }), (e: any) => e.reason === "session-busy");
    store.failTurn(turn.turn.id, "cancelled");
    store.close(); store = new SessionStore({ path });
    assert.deepEqual(store.modelProfile(session.id), { profile: "second", revision: 3 });
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("incognito: the profile switch works on an ephemeral session, stays in memory, and keeps the same ownership and preview rules", async () => {
  const root = mkdtempSync(join(tmpdir(), "p1b-switch-incog-")), path = join(root, "sessions.sqlite");
  const durable = new SessionStore({ path }), volatile = new SessionStore({ path: ":memory:" });
  try {
    const session = volatile.createSession({ kind: "direct", agentId: "bernd", owner, memoryMode: "incognito" });
    const methods = buildSessionMethods({ store: durable, storeFor: id => volatile.getSession(id) ? volatile : durable, runner: {} as never, agents: { workspaceOf: () => "/ws" } as never, isStopping: () => false, modelProfiles: () => ["default", "second"] });
    const call = (extra: object = {}) => methods["session.model.set"]!({ caller, sessionId: session.id, profile: "second", ...extra }, { signal: new AbortController().signal } as never) as Promise<any>;
    const preview = await call(); assert.equal(preview.applied, false);
    assert.deepEqual(volatile.modelProfile(session.id), { profile: null, revision: 0 });
    await assert.rejects(call({ caller: { ...caller, userId: "foreign" } }), (e: any) => e.error === "E_NOT_FOUND");
    await assert.rejects(call({ profile: "missing" }), (e: any) => e.reason === "model-profile-unavailable");
    const applied = await call({ confirmed: true, expectedRevision: preview.revision }); assert.equal(applied.applied, true); assert.equal(applied.revision, 1);
    await assert.rejects(call({ confirmed: true, expectedRevision: preview.revision }), (e: any) => e.reason === "stale-model-preview");
    assert.deepEqual(volatile.modelProfile(session.id), { profile: "second", revision: 1 });
    // Nothing leaks into the durable store: neither the session nor a profile row exists there.
    assert.equal(durable.getSession(session.id), null);
    assert.deepEqual(durable.modelProfile(session.id), { profile: null, revision: 0 });
    const turn = volatile.beginTurn(session.id, "hello", 2);
    await assert.rejects(call({ confirmed: true, expectedRevision: 1 }), (e: any) => e.reason === "session-busy");
    volatile.failTurn(turn.turn.id, "cancelled");
  } finally { durable.close(); volatile.close(); rmSync(root, { recursive: true, force: true }); }
});

test("incognito: the real session service routes session.model.set to the ephemeral store and leaves the durable file free of the session", async () => {
  const { openSessionService } = await import("../../src/session/service.ts");
  const root = mkdtempSync(join(tmpdir(), "p1b-switch-svc-"));
  const logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; }, async close() {} } as never;
  const sessions = openSessionService({ dbPath: join(root, "sessions.sqlite"), clock: Date.now, logger, agents: { workspaceOf: () => "/ws" } as never, isStopping: () => false, provider: () => ({ modelProfiles: () => ["default", "second"] }) as never, notify() {}, signal: new AbortController().signal, memory: { recall: async () => ({ text: "", degraded: null }), capture: async () => {}, checkpoint: async () => {} } as never });
  try {
    const incognito = sessions.ephemeral().store.createSession({ kind: "direct", agentId: "bernd", owner, memoryMode: "incognito" });
    const remembered = sessions.store.createSession({ kind: "direct", agentId: "bernd", owner });
    assert.equal(sessions.forSession(incognito.id), sessions.ephemeral());
    for (const id of [incognito.id, remembered.id]) {
      const call = (extra: object = {}) => sessions.methods["session.model.set"]!({ caller, sessionId: id, profile: "second", ...extra }, { signal: new AbortController().signal } as never) as Promise<any>;
      const preview = await call(); const applied = await call({ confirmed: true, expectedRevision: preview.revision });
      assert.equal(applied.applied, true); assert.equal(applied.revision, 1);
    }
    assert.deepEqual(sessions.ephemeral().store.modelProfile(incognito.id), { profile: "second", revision: 1 });
    assert.deepEqual(sessions.store.modelProfile(incognito.id), { profile: null, revision: 0 }, "durable store holds no row for the incognito session");
    assert.deepEqual(sessions.store.modelProfile(remembered.id), { profile: "second", revision: 1 });
  } finally { await sessions.close(); rmSync(root, { recursive: true, force: true }); }
});
