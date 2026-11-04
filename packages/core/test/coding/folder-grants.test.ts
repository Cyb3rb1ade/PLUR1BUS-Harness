/** Q25: a Core-created code-root request uses the real D109 service and OS attestation RPC. */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, parse } from "node:path";
import { deriveUserPrincipal } from "../../src/identity/principals.ts";
import { execFileSync } from "node:child_process";
import { CodingSessions } from "../../src/coding/sessions.ts";
import { SessionStore } from "../../src/session/store.ts";
import { codingRoot } from "../../src/coding/root.ts";
import { createApprovalService } from "../../src/approvals/service.ts";
import { PERSON, AGENT_PRINCIPAL, rpcRig, refused } from "../approvals/rpc-helpers.ts";

async function fixture(t: TestContext, confirmation = true) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "code-folder-grant-")));
  const root = join(dir, "repo"),
    home = join(dir, "harness");
  mkdirSync(root);
  mkdirSync(home);
  execFileSync("git", ["init", "-q", root]);
  let unblock: (() => void) | undefined;
  let entered: (() => void) | undefined;
  let gate: Promise<void> | undefined;
  const r = await rpcRig({
    deps: {
      attester: {
        probe: async () => ({ available: true as const, method: "touch-id" }),
        attest: async () => {
          entered?.();
          if (gate) await gate;
          return confirmation
            ? { ok: true as const, method: "touch-id", at: 1 }
            : { ok: false as const, reason: "cancelled" as const };
        },
      },
    },
  });
  const store = new SessionStore({ path: ":memory:" });
  const controller = new AbortController();
  const coding = new CodingSessions({
    home,
    store: () => store,
    storeFor: () => store,
    ephemeral: () => store,
    agents: { workspaceOf: () => root } as never,
    roots: () => [],
    grants: r.stores.grants,
    clock: () => r.clock.now(),
    audit: r.audit,
    requestFolder: (input) => r.service.requestCodeRoot(input),
    folderRequest: (id, person) => r.service.get(id, person),
    cancelFolder: (id, person) => {
      r.service.cancel({ requestId: id, person });
    },
    endTask: (id) => {
      r.stores.grants.endTask(id);
    },
    endSession: (id) => {
      r.stores.grants.endSession(id);
    },
  });
  store.onArchived((id) => {
    coding.sessionEnded(id);
    r.stores.grants.endSession(id);
  });
  t.after(() => {
    coding.close();
    r.service.dispose();
    store.close();
    r.stores.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const params = {
    caller: { channel: "cli" as const, accountId: "host", userId: PERSON.userId },
    agentId: "bernd",
    root,
    interactive: true,
  };
  const connection = { connectionId: "native", surface: 1 as const, signal: controller.signal };
  return {
    ...r,
    store,
    coding,
    params,
    connection,
    controller,
    root: realpathSync.native(root),
    home,
    holdConfirmation: () => {
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      gate = new Promise<void>((resolve) => {
        unblock = resolve;
      });
      const release = () => {
        unblock?.();
      };
      t.after(release);
      return { started, release };
    },
  };
}

test("a T1 native code request needs OS confirmation, grants only its exact recursive root and expires with its session", async (t) => {
  const r = await fixture(t);
  const pending = await r.coding.open(r.params, PERSON, r.connection);
  assert.equal(pending.state, "grant-required");
  if (pending.state !== "grant-required") return assert.fail("expected a folder request");
  const id = pending.grant.approvalId;
  assert.equal(typeof id, "string");
  assert.equal(pending.grant.scope, "session");
  assert.equal(r.service.get(id)?.requiredSurface, 2);
  assert.deepEqual(r.service.get(id)?.grantOptions, [{ scope: "session", requiredSurface: 2 }]);
  assert.equal(r.store.worktree(pending.session.id), null);
  assert.deepEqual(await refused(r.call("approval.decide", { id, decision: "approve", scope: "session" })), {
    error: "E_APPROVAL_REQUIRED",
    reason: "attestation-required",
    detail: "touch-id",
  });
  assert.equal(r.stores.grants.inspect({ person: PERSON.userId }).length, 0);
  const granted = await r.call("approval.decide", { id, decision: "approve", scope: "session", attest: true });
  assert.equal(granted.approval.status, "approved");
  const grants = r.stores.grants.inspect({ person: PERSON.userId });
  assert.equal(grants.length, 2);
  assert.deepEqual(grants.map((v) => v.grant.capability).sort(), ["fs.read", "fs.write"]);
  for (const { grant, state } of grants) {
    assert.equal(state, "active");
    assert.equal(grant.scope, "session");
    assert.equal(grant.sessionId, pending.session.id);
    assert.equal(grant.surface, 2);
    assert.equal(grant.delegable ?? false, false, "the grant never delegates to helpers");
    assert.deepEqual(grant.match, {
      kind: "path",
      path: r.root,
      access: grant.capability === "fs.read" ? "read" : "write",
      recursive: true,
    });
  }
  const opened = await r.coding.open({ ...r.params, sessionId: pending.session.id }, PERSON, r.connection);
  assert.equal(opened.state, "open");
  assert.equal(r.store.worktree(pending.session.id)?.root, r.root);
  assert.ok(
    r.audit.events.some(
      (e) =>
        e.action === "approval.requested" &&
        e.detail.tool === "code.session.open" &&
        e.detail.reason === "code-session-root",
    ),
  );
  assert.ok(
    r.audit.events.some((e) => e.action === "approval.decided" && e.detail.attestedVia === "attested:touch-id"),
  );
  r.store.archiveSession(pending.session.id);
  assert.ok(r.stores.grants.inspect({ person: PERSON.userId }).every((v) => v.state === "revoked"));
});

test("a code-root request refuses always and helper delegation without producing any grant", async (t) => {
  const r = await fixture(t);
  const pending = await r.coding.open(r.params, PERSON, r.connection);
  if (pending.state !== "grant-required") return assert.fail("expected a request");
  const id = pending.grant.approvalId;
  assert.deepEqual(
    r.service.decideForSession({
      requestId: id,
      person: PERSON.userId,
      surface: 3,
      decision: "approve",
      scope: "always",
    }),
    { ok: false, reason: "scope-unavailable" },
  );
  assert.equal(
    (await refused(r.call("approval.decide", { id, decision: "approve", scope: "always", attest: true }))).error,
    "E_INVALID_PARAMS",
  );
  assert.equal(
    (
      await refused(
        r.call("approval.decide", { id, decision: "approve", scope: "session", delegable: true, attest: true }),
      )
    ).error,
    "E_INVALID_PARAMS",
  );
  assert.equal(r.stores.grants.inspect({ person: PERSON.userId }).length, 0);
  assert.equal(r.store.worktree(pending.session.id), null);
});

test("agents, ACP, pipes and an already aborted open cannot request or bind an ungranted root", async (t) => {
  const r = await fixture(t);
  await assert.rejects(r.coding.open(r.params, AGENT_PRINCIPAL, r.connection), /person/i);
  const acp = r.store.createSession({
    kind: "acp",
    agentId: "bernd",
    owner: deriveUserPrincipal(PERSON.userId),
    memoryMode: "remember",
  });
  await assert.rejects(
    r.coding.open({ ...r.params, sessionId: acp.id }, PERSON, r.connection),
    (e) => !!e && typeof e === "object" && "error" in e && e.error === "E_APPROVAL_REQUIRED",
  );
  await assert.rejects(
    r.coding.open({ ...r.params, interactive: false }, PERSON, r.connection),
    (e) => !!e && typeof e === "object" && "error" in e && e.error === "E_APPROVAL_REQUIRED",
  );
  r.controller.abort();
  await assert.rejects(r.coding.open(r.params, PERSON, r.connection), /abort|cancel/i);
  assert.equal(r.service.list().length, 0);
  assert.equal(r.stores.grants.inspect({ person: PERSON.userId }).length, 0);
});

test("cancelling OS confirmation or disconnecting creates no binding or grant", async (t) => {
  const r = await fixture(t, false);
  const pending = await r.coding.open(r.params, PERSON, r.connection);
  if (pending.state !== "grant-required") return assert.fail("expected a request");
  assert.equal(
    (
      await refused(
        r.call("approval.decide", {
          id: pending.grant.approvalId,
          decision: "approve",
          scope: "session",
          attest: true,
        }),
      )
    ).error,
    "E_DENIED",
  );
  r.coding.connectionClosed(r.connection.connectionId);
  assert.equal(r.service.get(pending.grant.approvalId)?.status, "cancelled");
  assert.equal(r.stores.grants.inspect({ person: PERSON.userId }).length, 0);
  assert.equal(r.store.worktree(pending.session.id), null);
});

test("home, drive/system roots and Harness state/run remain refused before Git or an approval", async (t) => {
  const r = await fixture(t);
  for (const path of [
    homedir(),
    parse(homedir()).root,
    ...(process.platform === "darwin" ? ["/private"] : []),
    ...(process.platform === "win32" ? [] : ["/usr"]),
    process.platform === "win32" ? process.env.SystemRoot! : "/",
    join(r.home, "state"),
    join(r.home, "run"),
  ]) {
    if (path.startsWith(r.home)) mkdirSync(path, { recursive: true });
    await assert.rejects(
      codingRoot(path, r.home, []),
      (e) => !!e && typeof e === "object" && "error" in e && e.error === "E_DENIED",
    );
  }
  assert.equal(r.service.list().length, 0);
});

test("a tool cannot opt into the code-root exception through its name or model arguments", async (t) => {
  const r = await fixture(t);
  const target = join(r.root, "nested", "file.txt");
  const request = await r.park({
    capability: "fs.write",
    tool: "code.session.open",
    effect: "local-write",
    access: "write",
    targets: [target],
    args: { origin: "code-session-root", recursive: true, root: r.root },
    ctx: { surface: 1 },
  });
  const out = await r.call("approval.decide", { id: request.id, decision: "approve", scope: "session", attest: true });
  assert.deepEqual(out.grant.match, { kind: "path", path: join(r.root, "nested"), access: "write", recursive: false });
  assert.equal(r.stores.grants.inspect({ person: PERSON.userId }).length, 1);
  assert.equal((await request.answer).approved, true);
});

test("a session ending while OS confirmation is pending wins over the eventual confirmation", async (t) => {
  const r = await fixture(t);
  const pending = await r.coding.open(r.params, PERSON, r.connection);
  if (pending.state !== "grant-required") return assert.fail("expected a request");
  const held = r.holdConfirmation();
  const decision = r.call("approval.decide", {
    id: pending.grant.approvalId,
    decision: "approve",
    scope: "session",
    attest: true,
  });
  await held.started;
  r.store.archiveSession(pending.session.id);
  held.release();
  const out = await refused(decision);
  assert.equal(out.error, "E_DENIED");
  assert.equal(r.stores.grants.inspect({ person: PERSON.userId }).length, 0);
  assert.equal(r.store.worktree(pending.session.id), null);
});

test("incognito code-session permission ends when its volatile session closes", async (t) => {
  const r = await fixture(t);
  const pending = await r.coding.open({ ...r.params, memoryMode: "incognito" }, PERSON, r.connection);
  if (pending.state !== "grant-required") return assert.fail("expected a request");
  await r.call("approval.decide", {
    id: pending.grant.approvalId,
    decision: "approve",
    scope: "session",
    attest: true,
  });
  r.coding.close();
  assert.ok(r.stores.grants.inspect({ person: PERSON.userId }).every((view) => view.state === "revoked"));
});

test("a folder grant for one code session does not open a second session on the same root", async (t) => {
  const r = await fixture(t);
  const first = await r.coding.open(r.params, PERSON, r.connection);
  if (first.state !== "grant-required") return assert.fail("expected a request");
  await r.call("approval.decide", { id: first.grant.approvalId, decision: "approve", scope: "session", attest: true });
  await r.coding.open({ ...r.params, sessionId: first.session.id }, PERSON, r.connection);
  const second = await r.coding.open(r.params, PERSON, { ...r.connection, connectionId: "another" });
  assert.notEqual(second.session.id, first.session.id);
  assert.equal(second.state, "grant-required");
  assert.equal(r.store.worktree(second.session.id), null);
});

test("a fresh approval-service instance cannot approve an old code-root request without its live host binding", async (t) => {
  const r = await fixture(t);
  const pending = await r.coding.open(r.params, PERSON, r.connection);
  if (pending.state !== "grant-required") return assert.fail("expected a request");
  const restarted = createApprovalService({ stores: r.stores, clock: r.clock, timers: r.timers });
  t.after(() => restarted.dispose());
  assert.deepEqual(
    restarted.decideForSession({
      requestId: pending.grant.approvalId,
      person: PERSON.userId,
      surface: 2,
      attestedVia: "attested:touch-id",
      decision: "approve",
      scope: "session",
    }),
    { ok: false, reason: "approval-mismatch" },
  );
  assert.equal(r.stores.grants.inspect({ person: PERSON.userId }).length, 0);
  assert.equal(r.store.worktree(pending.session.id), null);
});
