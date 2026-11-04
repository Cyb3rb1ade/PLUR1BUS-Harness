/** CX5: ACP mode belongs to one authenticated connection/session; it never creates filesystem authority. */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { CodingSessions } from "../../src/coding/sessions.ts";
import { SessionStore } from "../../src/session/store.ts";
import { deriveUserPrincipal } from "../../src/identity/principals.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import { buildCodeSurface } from "../../src/rpc/code-surface.ts";
import { guardMethods } from "../../src/rbac/guard.ts";
import type { ChatRequest } from "../../src/session/provider.ts";

const person = { userId: "owner", kind: "person", role: "owner" } as const;
const caller = { channel: "cli", accountId: "host", userId: "owner" } as const;
const connection = { connectionId: "editor", surface: 1 as const };

function rig(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "acp-code-mode-"));
  const home = join(directory, "home");
  const root = join(directory, "repo");
  mkdirSync(home);
  mkdirSync(root);
  execFileSync("git", ["init", "-q", root]);
  const store = new SessionStore({ path: ":memory:", clock: () => 100 });
  const audit = memoryAuditSink();
  const ended: string[] = [];
  let granted = true;
  let asked = 0;
  let auditFailure = false;
  const coding = new CodingSessions({
    home, store: () => store, storeFor: () => store, ephemeral: () => store,
    agents: { workspaceOf: () => root } as never,
    roots: () => granted ? [{ id: "workspace", path: root }] : [],
    grants: { list: () => [], get: () => undefined },
    clock: () => 100,
    audit: { append(event) {
      if (auditFailure) throw new Error("audit unavailable");
      audit.append(event);
    } },
    resolvePerson: id => id === person.userId ? person : null,
    requestFolder: () => {
      asked++;
      throw new Error("an editor cannot request a folder grant");
    },
    endTask: id => {
      ended.push(id);
    },
  });
  t.after(() => {
    coding.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const create = () => store.createSession({ kind: "acp", agentId: "worker",
    owner: deriveUserPrincipal(person.userId), title: "ACP" });
  const open = async () => {
    const session = create();
    await coding.open({ caller, agentId: "worker", sessionId: session.id, root, interactive: false },
      person, connection);
    return session;
  };
  const request = (id: string, connectionId = connection.connectionId): ChatRequest => ({
    sessionId: id, agentId: "worker", principal: deriveUserPrincipal(person.userId), caller,
    approver: coding.approver(connectionId, id, { person: person.userId, surface: 1 }),
    summaries: [], memory: "frozen memory", messages: [{ role: "user", text: "task" }],
    signal: new AbortController().signal,
  });
  return { coding, store, audit, ended, open, create, request,
    revoke: () => { granted = false; },
    asked: () => asked,
    failAudit: () => { auditFailure = true; },
  };
}

test("two ACP sessions on one connection keep independent modes and task lifetimes", async t => {
  const r = rig(t);
  const first = await r.open();
  const firstTask = r.coding.taskId(connection.connectionId, first.id);
  await r.coding.setMode({ caller, sessionId: first.id, mode: "chat" }, person, connection);
  const second = await r.open();
  const secondTask = r.coding.taskId(connection.connectionId, second.id);
  assert.ok(firstTask && secondTask && firstTask !== secondTask);
  assert.deepEqual(r.ended, [], "opening the second editor tab must not revoke the first tab's task");
  assert.equal(r.coding.enabled(r.request(first.id)), false);
  assert.equal(r.coding.enabled(r.request(second.id)), true);
  r.coding.connectionClosed(connection.connectionId);
  assert.deepEqual(new Set(r.ended), new Set([firstTask, secondTask]));
  assert.equal(r.coding.enabled(r.request(second.id)), false, "a closed ACP connection retains no coding mode");
});

test("a mode switch changes only future turns, with one audit record and no transcript rewrite", async t => {
  const r = rig(t);
  const session = await r.open();
  const active = r.request(session.id);
  const before = JSON.stringify([r.store.listMessages(session.id), r.store.listEvents(session.id),
    r.store.worktree(session.id)]);
  assert.equal(r.coding.enabled(active), true);
  const changed = await r.coding.setMode({ caller, sessionId: session.id, mode: "chat" }, person, connection);
  assert.deepEqual(changed, { mode: "chat", changed: true });
  assert.equal(r.coding.enabled(active), true, "the admitted turn keeps its captured profile");
  assert.equal(r.coding.enabled(r.request(session.id)), false);
  assert.equal(r.coding.enabled(r.request(session.id, "other-editor")), false);
  assert.deepEqual(await r.coding.setMode({ caller, sessionId: session.id, mode: "chat" }, person, connection),
    { mode: "chat", changed: false });
  assert.equal(JSON.stringify([r.store.listMessages(session.id), r.store.listEvents(session.id),
    r.store.worktree(session.id)]), before);
  const changes = r.audit.events.filter(e => e.action === "code.session.mode");
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0]?.detail, { from: "coding", to: "chat" });
});

test("mode selection refuses an agent, foreign owner, unbound session and revoked folder without asking for a grant", async t => {
  const r = rig(t);
  const session = await r.open();
  const params = { caller, sessionId: session.id, mode: "coding" as const };
  await assert.rejects(r.coding.setMode(params, { ...person, kind: "agent" }, connection),
    { error: "E_DENIED" });
  await assert.rejects(r.coding.setMode(params, { ...person, userId: "other" }, connection),
    { error: "E_NOT_FOUND" });
  const unbound = r.create();
  await assert.rejects(r.coding.setMode({ ...params, sessionId: unbound.id }, person, connection),
    { error: "E_NOT_AVAILABLE" });
  await r.coding.setMode({ ...params, mode: "chat" }, person, connection);
  r.revoke();
  await assert.rejects(r.coding.setMode(params, person, connection), { error: "E_APPROVAL_REQUIRED" });
  assert.equal(r.asked(), 0);
  assert.equal(r.coding.enabled(r.request(session.id)), false);
});

test("an unavailable audit writer leaves the selected mode unchanged", async t => {
  const r = rig(t);
  const session = await r.open();
  r.failAudit();
  await assert.rejects(r.coding.setMode({ caller, sessionId: session.id, mode: "chat" }, person, connection),
    /audit unavailable/);
  assert.equal(r.coding.enabled(r.request(session.id)), true);
});

test("a bound ACP session whose connection mode expired refuses a new turn instead of silently changing profile", async t => {
  const r = rig(t);
  const session = await r.open();
  r.coding.connectionClosed(connection.connectionId);
  await assert.rejects(r.coding.prepare(r.request(session.id)),
    { error: "E_CONFLICT", reason: "code-mode-connection" });
});

test("the guarded coding RPC rejects agent principals before opening permissions", async t => {
  const r = rig(t);
  let permissionOpens = 0;
  const raw = buildCodeSurface({ coding: r.coding, actions: {} as never,
    surfaceOf: () => 1, openPermissions: async () => { permissionOpens++; } });
  const methods = guardMethods(raw, { resolve: () => ({ ...person, kind: "agent" }), now: () => 100 });
  await assert.rejects(methods["code.session.mode"]!({ caller, sessionId: "any", mode: "coding" },
    { connectionId: "agent", requestId: "mode", signal: new AbortController().signal }),
    { error: "E_DENIED", reason: "agent-principal" });
  assert.equal(permissionOpens, 0);
});
