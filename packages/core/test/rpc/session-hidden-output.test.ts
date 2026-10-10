// `session.get` with includeHidden: hidden tool outputs (ADR-003 "hide, don't delete") come back only on request, to the
// same transcript reader that may already read the session, and never change what the context view shows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionStore } from "../../src/session/store.ts";
import { createBreakGlass } from "../../src/rbac/break-glass.ts";
import { guardMethods } from "../../src/rbac/guard.ts";
import { sessionTranscriptSurface } from "../../src/rpc/session-overview.ts";
import { RpcError } from "../../src/rpc/errors.ts";
import type { Principal } from "../../src/rbac/types.ts";

const context = () => ({ requestId: "offline", connectionId: "offline", signal: new AbortController().signal });
const OWNER: Principal = { userId: "owner", role: "owner", kind: "person" };

function fixture(t: { after(fn: () => void): void }) {
  const store = new SessionStore({ path: ":memory:" }); t.after(() => store.close());
  const record = store.createSession({ kind: "direct", agentId: "alpha", owner: "own-principal" });
  const turn = store.beginTurn(record.id, "read the file", 2).turn;
  const hiddenCall = store.appendEvent(turn.id, "tool.call", { id: "c1", name: "fs.read", args: { path: "/notes/a.md" } });
  store.appendEvent(turn.id, "tool.result", { id: "c1", output: "ORIGINAL-OUTPUT body of a.md" });
  const shownCall = store.appendEvent(turn.id, "tool.call", { id: "c2", name: "fs.read", args: { path: "/notes/b.md" } });
  store.appendEvent(turn.id, "tool.result", { id: "c2", output: "still visible" });
  store.setToolVisibility(record.id, `event:${hiddenCall.seq}`, true, "superseded-by-later-read");
  const raw = sessionTranscriptSurface({ sessions: () => store, breakglass: createBreakGlass({ clock: () => 1, audit: { append() {} }, notify: () => {} }), ownership: () => ["own-principal"], personOf: () => undefined });
  const methods = guardMethods(raw, { resolve: () => OWNER, now: () => 1 });
  return { store, record, hiddenCall, shownCall, get: (p: Record<string, unknown>) => methods["session.get"]!(p, context()) as Promise<Record<string, any>> };
}

test("includeHidden is off by default: the existing session.get result is unchanged", async t => {
  const f = fixture(t);
  const result = await f.get({ sessionId: f.record.id, messages: 5 });
  assert.equal("hiddenToolOutputs" in result, false);
});

test("includeHidden returns the hidden original with its reference and reason, and leaves visible outputs out", async t => {
  const f = fixture(t);
  const result = await f.get({ sessionId: f.record.id, messages: 5, includeHidden: true });
  assert.equal(result.hiddenToolOutputs.length, 1);
  const [hidden] = result.hiddenToolOutputs;
  assert.equal(hidden.ref, `event:${f.hiddenCall.seq}`);
  assert.equal(hidden.reason, "superseded-by-later-read");
  assert.equal(hidden.name, "fs.read");
  assert.equal(hidden.callId, "c1");
  assert.match(hidden.output, /ORIGINAL-OUTPUT body of a\.md/);
  assert.doesNotMatch(JSON.stringify(result), /still visible/);
});

test("includeHidden does not change the event log or the visibility state", async t => {
  const f = fixture(t);
  const before = JSON.stringify(f.store.toolEvents(f.record.id));
  await f.get({ sessionId: f.record.id, includeHidden: true });
  assert.equal(JSON.stringify(f.store.toolEvents(f.record.id)), before);
  assert.equal(f.store.toolVisibility(f.record.id).find(v => v.ref === `event:${f.hiddenCall.seq}`)?.hidden, true);
});

test("includeHidden follows the transcript gate: a foreign session stays E_NOT_FOUND", async t => {
  const f = fixture(t);
  const foreign = f.store.createSession({ kind: "direct", agentId: "alpha", owner: "someone-else" });
  await assert.rejects(f.get({ sessionId: foreign.id, includeHidden: true }), (e: unknown) => e instanceof RpcError && e.error === "E_NOT_FOUND");
});
