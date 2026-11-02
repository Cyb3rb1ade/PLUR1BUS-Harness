/** CLI-1: native worktree identity, D109 consent and D115 card/session reuse at the owning store. */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { SessionStore } from "../../src/session/store.ts";
import { CodingSessions } from "../../src/coding/sessions.ts";
import { createCollab } from "../../src/collab/service.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import { deriveUserPrincipal } from "../../src/identity/principals.ts";
import type { Grant } from "../../src/policy/decide.ts";
import { buildSessionMethods } from "../../src/session/methods.ts";
import { guardMethods } from "../../src/rbac/guard.ts";

const person = { userId: "owner", kind: "person", role: "owner" } as const;
const caller = { channel: "cli", accountId: "host", userId: "owner" } as const;
const connection = { connectionId: "calls", surface: 3 as const };

function rig(t: TestContext, granted = true) {
  const directory = mkdtempSync(join(tmpdir(), "code-session-"));
  const root = join(directory, "repo"),
    home = join(directory, "home");
  mkdirSync(root);
  mkdirSync(home);
  execFileSync("git", ["init", "-q", root]);
  const store = new SessionStore({ path: ":memory:", clock: () => 100 });
  const grants: Grant[] = [];
  const collab = createCollab({ path: ":memory:" });
  t.after(() => {
    store.close();
    collab.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const audit = memoryAuditSink();
  const endedTasks: string[] = [];
  let taskEndFailure = false;
  let codingAgent = false;
  let nextRoots: (() => void) | undefined;
  const coding = new CodingSessions({
    home,
    store: () => store,
    storeFor: () => store,
    ephemeral: () => store,
    agents: { workspaceOf: (id: string) => (id === "worker" ? root : undefined) } as never,
    codingAgent: () => codingAgent,
    roots: () => {
      const hook = nextRoots;
      nextRoots = undefined;
      hook?.();
      return granted ? [{ id: "workspace", path: root }] : [];
    },
    grants: {
      list: (q) => grants.filter((g) => g.person === q.person && g.agent === q.agent && g.capability === q.capability),
      get: (id) => grants.find((g) => g.id === id),
    },
    clock: () => 100,
    audit,
    project: { collab, worktrees: { root: () => root } },
    resolvePerson: (id) => (id === person.userId ? person : null),
    requestFolder: () => ({ id: "fixture-root-request", status: "pending" }) as never,
    endTask: (id) => {
      endedTasks.push(id);
      if (taskEndFailure) throw new Error("fixture permission writer closed");
      for (const grant of grants) if (grant.taskId === id) grant.revoked = true;
    },
  });
  const params = { caller, agentId: "worker", root };
  return {
    coding,
    store,
    root,
    home,
    directory,
    grants,
    collab,
    audit,
    params,
    endedTasks,
    failTaskEnd: () => {
      taskEndFailure = true;
    },
    setCoding: (value: boolean) => {
      codingAgent = value;
    },
    duringNextRoot: (hook: () => void) => {
      nextRoots = hook;
    },
  };
}

test("opening and resuming one code session preserves native root identity, owner and immutable binding", async (t) => {
  const r = rig(t);
  const opened = await r.coding.open(r.params, person, connection);
  assert.equal(opened.state, "open");
  if (opened.state !== "open") return assert.fail("expected an opened session");
  assert.equal(opened.session.kind, "direct");
  assert.equal(r.store.getSession(opened.session.id)?.owner, deriveUserPrincipal(person.userId));
  assert.equal(opened.root, realpathSync.native(r.root));
  assert.equal(r.store.worktree(opened.session.id)?.root, opened.root);
  const again = await r.coding.open({ ...r.params, sessionId: opened.session.id }, person, connection);
  assert.equal(again.session.id, opened.session.id);
  assert.equal(r.store.listSessions({ owner: deriveUserPrincipal(person.userId) }).sessions.length, 1);
  const second = join(r.directory, "other");
  mkdirSync(second);
  execFileSync("git", ["init", "-q", second]);
  await assert.rejects(
    r.coding.open({ ...r.params, root: second, sessionId: opened.session.id }, person, connection),
    /binding|worktree|root/i,
  );
});

test("an ungranted folder is refused without a live person and creates no binding", async (t) => {
  const r = rig(t, false);
  await assert.rejects(r.coding.open(r.params, { ...person, kind: "agent" }, connection), /person/i);
  await assert.rejects(
    r.coding.open({ ...r.params, interactive: false }, person, connection),
    (e) => !!e && typeof e === "object" && "error" in e && e.error === "E_APPROVAL_REQUIRED",
  );
  assert.equal(r.store.listSessions({ owner: deriveUserPrincipal(person.userId) }).sessions.length, 0);
});

test("a live CLI gets a folder-scoped D109 grant plan; only live grants allow the retry and revocation wins", async (t) => {
  const r = rig(t, false);
  const pending = await r.coding.open({ ...r.params, interactive: true }, person, connection);
  assert.equal(pending.state, "grant-required");
  if (pending.state !== "grant-required") return assert.fail("expected a grant plan");
  assert.equal(r.store.worktree(pending.session.id), null);
  assert.equal(pending.grant.path, realpathSync.native(r.root));
  assert.equal(pending.grant.recursive, true);
  assert.deepEqual(pending.grant.capabilities, ["fs.read", "fs.write"]);
  for (const capability of pending.grant.capabilities)
    r.grants.push({
      id: capability,
      capability,
      person: person.userId,
      agent: "worker",
      scope: pending.grant.scope,
      match: {
        kind: "path",
        path: pending.grant.path,
        access: capability === "fs.read" ? "read" : "write",
        recursive: true,
      },
      surface: 3,
      createdAt: 1,
      sessionId: pending.session.id,
    });
  const opened = await r.coding.open({ ...r.params, sessionId: pending.session.id }, person, connection);
  assert.equal(opened.state, "open");
  r.grants.forEach((g) => {
    g.revoked = true;
  });
  await assert.rejects(r.coding.requireRoot(pending.session.id, person), /grant/i);
  assert.equal(
    r.store.worktree(pending.session.id)?.root,
    realpathSync.native(r.root),
    "metadata is retained without becoming permission",
  );
});

test("a native tool task belongs to one coding connection and ends when that connection closes", async (t) => {
  const r = rig(t, false);
  const pending = await r.coding.open({ ...r.params, interactive: true }, person, connection);
  if (pending.state !== "grant-required") return assert.fail("expected a grant plan");
  const taskId = r.coding.taskId(connection.connectionId, pending.session.id);
  assert.ok(taskId);
  assert.equal(pending.grant.scope, "session");
  assert.notEqual(taskId, pending.session.id, "a task cap must not become session-wide authority");
  const origin = r.coding.approver(connection.connectionId, pending.session.id, { person: person.userId, surface: 3 });
  assert.equal(origin.taskId, taskId);
  assert.equal(
    r.coding.approver("other-connection", pending.session.id, { person: person.userId, surface: 3 }).taskId,
    undefined,
  );
  r.coding.connectionClosed(connection.connectionId);
  assert.equal(r.coding.taskId(connection.connectionId, pending.session.id), undefined);
  assert.deepEqual(r.endedTasks, [taskId]);
});

test("a card reuses its one active session and the shared worktree; reassignment revokes the binding", async (t) => {
  const r = rig(t);
  const project = r.collab.createProject(person, { name: "Coding" });
  r.collab.addAgent(person, project.id, "worker");
  const actor = { kind: "person", id: person.userId } as const;
  const card = r.collab.boardStore.createCard(
    project.id,
    { title: "Task", columnId: r.collab.boardStore.columns(project.id)[0]!.id },
    actor,
  );
  r.collab.boardStore.assign(project.id, card.id, { kind: "agent", id: "worker" }, true, actor);
  const params = { ...r.params, projectId: project.id, cardId: card.id };
  const first = await r.coding.open(params, person, connection);
  assert.equal(first.session.kind, "card");
  assert.equal(r.store.getSession(first.session.id)?.scope, project.id);
  const second = await r.coding.open(params, person, connection);
  assert.equal(second.session.id, first.session.id);
  const resumed = await r.coding.open({ ...r.params, sessionId: first.session.id }, person, connection);
  assert.equal(resumed.session.id, first.session.id, "a persisted card binding supplies the resume scope");
  assert.deepEqual(r.collab.boardStore.getCard(project.id, card.id).links, [{ kind: "session", id: first.session.id }]);
  r.collab.boardStore.assign(project.id, card.id, { kind: "agent", id: "worker" }, false, actor);
  await assert.rejects(r.coding.requireRoot(first.session.id, person), /assigned/i);
});

test("a nested directory, private core tree and another person's session cannot become a code binding", async (t) => {
  const r = rig(t);
  const nested = join(r.root, "nested");
  mkdirSync(nested);
  await assert.rejects(r.coding.open({ ...r.params, root: nested }, person, connection), /worktree root/i);
  execFileSync("git", ["init", "-q", r.home]);
  await assert.rejects(r.coding.open({ ...r.params, root: r.home }, person, connection), /protected|core home/i);
  const foreign = r.store.createSession({
    kind: "direct",
    agentId: "worker",
    owner: deriveUserPrincipal("someone-else"),
  });
  await assert.rejects(r.coding.open({ ...r.params, sessionId: foreign.id }, person, connection), /not found/i);
  writeFileSync(join(r.root, "kept.txt"), "untouched\r\n");
  assert.equal(r.store.worktree(foreign.id), null);
});

test("noninteractive presence belongs to its code connection, not every future client of that session", async (t) => {
  const r = rig(t);
  const opened = await r.coding.open({ ...r.params, interactive: false }, person, connection);
  const base = { person: person.userId, surface: 3 as const };
  assert.equal(r.coding.approver(connection.connectionId, opened.session.id, base).surface, 0);
  assert.equal(r.coding.approver("web", opened.session.id, base).surface, 3);
  r.coding.connectionClosed(connection.connectionId);
  assert.equal(r.coding.approver(connection.connectionId, opened.session.id, base).surface, 3);
});

test("normal session RPCs resume a person's canonical code session without opening it to an agent or another person", async (t) => {
  const r = rig(t);
  const opened = await r.coding.open(r.params, person, connection);
  const raw = buildSessionMethods({
    store: r.store,
    runner: {} as never,
    agents: { workspaceOf: () => r.root } as never,
    isStopping: () => false,
  });
  const context = { connectionId: "caller", requestId: "1", signal: new AbortController().signal };
  const methods = (who: typeof person | { userId: string; kind: "agent" | "person"; role: "owner" }) =>
    guardMethods(raw, { resolve: () => who, now: () => 100 });
  const resumed = await methods(person)["session.resume"]!({ caller, sessionId: opened.session.id }, context);
  assert.equal((resumed as { session: { id: string } }).session.id, opened.session.id);
  await assert.rejects(
    methods({ ...person, userId: "other" })["session.resume"]!({ caller, sessionId: opened.session.id }, context),
  );
  await assert.rejects(
    methods({ ...person, kind: "agent" })["session.resume"]!({ caller, sessionId: opened.session.id }, context),
  );
});

test("closed native task metadata cannot keep a task grant alive when cleanup fails", async (t) => {
  const r = rig(t, false);
  const pending = await r.coding.open({ ...r.params, interactive: true }, person, connection);
  if (pending.state !== "grant-required") return assert.fail("expected a grant plan");
  const taskId = r.coding.taskId(connection.connectionId, pending.session.id);
  assert.ok(taskId);
  for (const capability of pending.grant.capabilities)
    r.grants.push({
      id: capability,
      capability,
      person: person.userId,
      agent: "worker",
      scope: "task",
      taskId: taskId,
      match: {
        kind: "path",
        path: pending.grant.path,
        access: capability === "fs.read" ? "read" : "write",
        recursive: true,
      },
      surface: 3,
      createdAt: 1,
    });
  await r.coding.open({ ...r.params, sessionId: pending.session.id }, person, connection);
  r.failTaskEnd();
  assert.doesNotThrow(() => r.coding.connectionClosed(connection.connectionId));
  await assert.rejects(r.coding.requireRoot(pending.session.id, person, caller, taskId), /grant/i);
});

test("configured coding agents and genuine project-card sessions select the profile; background roles do not", (t) => {
  const r = rig(t);
  const session = r.store.createSession({
    kind: "direct",
    agentId: "worker",
    owner: deriveUserPrincipal(person.userId),
  });
  const request = {
    sessionId: session.id,
    agentId: "worker",
    summaries: [],
    memory: "",
    messages: [],
    signal: new AbortController().signal,
  };
  assert.equal(r.coding.enabled(request), false);
  r.setCoding(true);
  assert.equal(r.coding.enabled(request), true);
  assert.equal(r.coding.enabled({ ...request, role: "summarize" }), false);
  r.setCoding(false);
  const card = r.store.createSession({
    kind: "card",
    scope: "project",
    agentId: "worker",
    owner: deriveUserPrincipal(person.userId),
  });
  assert.equal(r.coding.enabled({ ...request, sessionId: card.id }), true);
  assert.equal(r.coding.enabled({ ...request, sessionId: card.id, role: "decision" }), false);
  assert.equal(r.store.worktree(card.id), null, "offering a profile never creates a binding or permission");
});

test("a card reassigned while native root preparation awaits cannot retain coding authority", async (t) => {
  const r = rig(t),
    project = r.collab.createProject(person, { name: "Race" }),
    actor = { kind: "person", id: person.userId } as const;
  r.collab.addAgent(person, project.id, "worker");
  const card = r.collab.boardStore.createCard(
    project.id,
    { title: "Task", columnId: r.collab.boardStore.columns(project.id)[0]!.id },
    actor,
  );
  r.collab.boardStore.assign(project.id, card.id, { kind: "agent", id: "worker" }, true, actor);
  const opened = await r.coding.open({ ...r.params, projectId: project.id, cardId: card.id }, person, connection);
  r.duringNextRoot(() =>
    queueMicrotask(() =>
      r.collab.boardStore.assign(project.id, card.id, { kind: "agent", id: "worker" }, false, actor),
    ),
  );
  await assert.rejects(r.coding.requireRoot(opened.session.id, person), /assigned/i);
});

test("a session archived while native root preparation awaits cannot retain coding authority", async (t) => {
  const r = rig(t),
    opened = await r.coding.open(r.params, person, connection);
  r.duringNextRoot(() => queueMicrotask(() => r.store.archiveSession(opened.session.id)));
  await assert.rejects(r.coding.requireRoot(opened.session.id, person), /archived/i);
});
