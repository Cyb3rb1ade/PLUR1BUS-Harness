// `session.get` with includeHidden on a session somebody else owns. The hidden originals come back only while the caller
// holds a live break-glass read grant for that session's person, the same gate that admits the transcript at all, and
// they stop coming back the moment the grant lapses. The clock is injected, so expiry is exercised without any wait.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionStore } from "../../src/session/store.ts";
import { createBreakGlass } from "../../src/rbac/break-glass.ts";
import { guardMethods } from "../../src/rbac/guard.ts";
import { sessionTranscriptSurface } from "../../src/rpc/session-overview.ts";
import { RpcError } from "../../src/rpc/errors.ts";
import type { Principal } from "../../src/rbac/types.ts";

const context = () => ({ requestId: "offline", connectionId: "offline", signal: new AbortController().signal });
const MIN = 60_000;
const REASON = "ticket 4711: reviewing a hidden tool output";
const ADMIN: Principal = { userId: "admin-1", kind: "person", role: "admin" };
const AGENT: Principal = { userId: "agent-1", kind: "agent", role: "member" };

function fixture(t: { after(fn: () => void): void }, caller: Principal) {
  const store = new SessionStore({ path: ":memory:" }); t.after(() => store.close());
  // The session belongs to another person's principal; the caller is not an owner of it.
  const record = store.createSession({ kind: "direct", agentId: "alpha", owner: "person-x-principal" });
  const turn = store.beginTurn(record.id, "read the file", 2).turn;
  const hiddenCall = store.appendEvent(turn.id, "tool.call", { id: "c1", name: "fs.read", args: { path: "/notes/a.md" } });
  store.appendEvent(turn.id, "tool.result", { id: "c1", output: "ORIGINAL-OUTPUT body of a.md" });
  store.setToolVisibility(record.id, `event:${hiddenCall.seq}`, true, "superseded-by-later-read");
  const clock = { now: 1_000_000 };
  const bg = createBreakGlass({ clock: () => clock.now, audit: { append() {} }, notify: () => {}, idGen: () => "grant-1", host: "test-host" });
  const raw = sessionTranscriptSurface({
    sessions: () => store,
    breakglass: bg,
    ownership: () => [],
    personOf: owner => (owner === "person-x-principal" ? "person-x" : undefined),
  });
  const methods = guardMethods(raw, { resolve: () => caller, now: () => clock.now });
  return {
    store, record, bg, clock,
    get: (p: Record<string, unknown>) => methods["session.get"]!(p, context()) as Promise<Record<string, any>>,
  };
}

test("includeHidden on a foreign session is refused without a break-glass grant", async t => {
  const f = fixture(t, ADMIN);
  await assert.rejects(f.get({ sessionId: f.record.id, includeHidden: true }), (e: unknown) => e instanceof RpcError && e.error === "E_NOT_FOUND");
});

test("with a live break-glass grant for the owner, includeHidden returns the hidden original", async t => {
  const f = fixture(t, ADMIN);
  f.bg.request(ADMIN, { targetUserId: "person-x", reason: REASON, ttlMs: 10 * MIN });
  const result = await f.get({ sessionId: f.record.id, includeHidden: true });
  assert.equal(result.hiddenToolOutputs.length, 1);
  assert.match(result.hiddenToolOutputs[0].output, /ORIGINAL-OUTPUT body of a\.md/);
});

test("with a grant, the default call still leaves hidden outputs out", async t => {
  const f = fixture(t, ADMIN);
  f.bg.request(ADMIN, { targetUserId: "person-x", reason: REASON, ttlMs: 10 * MIN });
  const result = await f.get({ sessionId: f.record.id });
  assert.equal("hiddenToolOutputs" in result, false);
});

test("the hidden outputs disappear once the grant has expired, without a new request", async t => {
  const f = fixture(t, ADMIN);
  f.bg.request(ADMIN, { targetUserId: "person-x", reason: REASON, ttlMs: 10 * MIN });
  assert.equal((await f.get({ sessionId: f.record.id, includeHidden: true })).hiddenToolOutputs.length, 1);
  f.clock.now += 10 * MIN;
  await assert.rejects(f.get({ sessionId: f.record.id, includeHidden: true }), (e: unknown) => e instanceof RpcError && e.error === "E_NOT_FOUND");
});

test("a grant for another person does not open this session's hidden outputs", async t => {
  const f = fixture(t, ADMIN);
  f.bg.request(ADMIN, { targetUserId: "person-y", reason: REASON, ttlMs: 10 * MIN });
  await assert.rejects(f.get({ sessionId: f.record.id, includeHidden: true }), (e: unknown) => e instanceof RpcError && e.error === "E_NOT_FOUND");
});

test("a non-person caller is refused before includeHidden is considered", async t => {
  const f = fixture(t, AGENT);
  await assert.rejects(f.get({ sessionId: f.record.id, includeHidden: true }), (e: unknown) => e instanceof RpcError && e.error === "E_DENIED");
});
