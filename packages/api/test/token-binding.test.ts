import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AccountStore, type CorePerson } from "../src/account-store.ts";
import { systemClock } from "../src/clock.ts";
import type { RouteSpec } from "../src/routes.ts";
import { requireTokenBinding, TokenService } from "../src/tokens.ts";
import { addUser, fakeCore, jsonHeaders, loginAs, raw, start, write, type Harness } from "./helpers.ts";

const wide = {
  auth: { capacity: 1000, refillPerSec: 100 },
  read: { capacity: 1000, refillPerSec: 100 },
  write: { capacity: 1000, refillPerSec: 100 },
  totp: { capacity: 1000, refillPerSec: 100 },
  stream: { capacity: 1000, refillPerSec: 100 },
};

const protocolSpec = (id: string, path: string, audience?: "mcp" | "a2a"): RouteSpec => ({
  id,
  method: "POST",
  path,
  summary: id,
  tag: "protocol",
  transport: "protocol",
  ...(audience ? { protocol: { audience } } : {}),
  auth: "any",
  authz: "delegated",
  csrf: false,
  rate: "write",
  stability: "experimental",
  since: "1.8.0",
  successStatus: 200,
  success: { description: "ok", schema: {} },
});

const setup = async () => {
  const core = fakeCore();
  core.impl = async (m, p) => {
    if (m === "agent.list") {
      return {
        agents: [
          { agentId: "main", open: true, activity: { state: "idle", since: 1 } },
          { agentId: "other", open: true, activity: { state: "idle", since: 2 } },
          { agentId: "deleted-agent", open: false, activity: { state: "idle", since: 3 }, lifecycle: { paused: false, archived: false, deleted: true } },
        ],
      };
    }
    if (m === "project.get") {
      const id = (p as { projectId?: string } | undefined)?.projectId;
      if (id === "proj-alpha") return { id: "proj-alpha", name: "Alpha", owner: "u-mia", members: [{ userId: "u-mia", role: "lead" }] };
      if (id === "proj-secret") throw Object.assign(new Error("project membership required"), { error: "E_DENIED", reason: "project-denied" });
      throw Object.assign(new Error("project not found"), { error: "E_NOT_FOUND", reason: "project" });
    }
    if (m === "core.status") return { rpc: "1.8.0", contract: "c", uptimeMs: 1, engine: { ready: true, degraded: null } };
    throw new Error(`unexpected rpc ${m}`);
  };
  const h = await start({
    rateClasses: wide,
    core,
    extraRoutes: [
      {
        spec: protocolSpec("test.mcp", "/mcp", "mcp"),
        handler: (i) => {
          const binding = requireTokenBinding(i.token, "mcp");
          return { body: { ok: true, binding } };
        },
      },
      {
        spec: protocolSpec("test.a2a", "/a2a", "a2a"),
        handler: (i) => {
          const binding = requireTokenBinding(i.token, "a2a");
          return { body: { ok: true, binding } };
        },
      },
    ],
  });
  await addUser(h, { id: "u-mia", username: "mia", role: "member", agentRights: { main: "use" } });
  await addUser(h, { id: "u-adam", username: "adam", role: "admin" });
  return h;
};

const bearer = (h: Harness, token: string, path = "/api/v1/whoami", method = "GET", body?: unknown) =>
  raw(h, {
    method,
    path,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? jsonHeaders() : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

test("A1.1: tokens.create accepts optional binding after verifying agent existence, agent.use and project access; tokens.list returns binding and whoami rejects bound token", async () => {
  const h = await setup();
  try {
    const { cookie } = await loginAs(h, "mia");
    const binding = {
      audience: "mcp" as const,
      agentId: "main",
      projectId: "proj-alpha",
      system: "claude-desktop",
      groups: ["memory", "agent"],
      memory: {
        recall: { workspace: true, user: true, agentPrivate: false },
        filter: ["credential", "financial"] as const,
      },
    };
    const r = await write(h, cookie, {
      path: "/api/v1/tokens",
      body: { name: "mcp-main", scopes: ["agent.use", "memory.user.read", "memory.workspace.read"], binding },
    });
    assert.equal(r.status, 201, r.text);
    assert.deepEqual(r.json.record.binding, binding);

    const list = await raw(h, { path: "/api/v1/tokens", headers: { cookie } });
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.tokens[0].binding, binding);

    // M6A-B6: Agent-bound tokens are rejected on general API routes like whoami
    const who = await bearer(h, r.json.token, "/api/v1/whoami");
    assert.equal(who.status, 403);
    assert.equal(who.json.reason, "token-bound-protocol-only");

    const createdAudit = h.audit.events.find((e) => e.action === "auth.token.created");
    assert.ok(createdAudit);
    assert.deepEqual((createdAudit.detail as { binding?: unknown }).binding, binding);
  } finally {
    await h.close();
  }
});

test("A1.1: tokens.create persists binding in AccountStore SQLite JSON without schema migration", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "token-binding-store-"));
  const dbPath = join(dir, "accounts.db");
  const person: CorePerson = { userId: "person-a", kind: "person", role: "member", disabled: false, version: 1 };
  let store = new AccountStore({ path: dbPath, resolve: async () => person });
  t.after(() => {
    try {
      store.close();
    } catch {
      /* already closed */
    }
    rmSync(dir, { recursive: true, force: true });
  });
  await store.createPending("person-a", "alice", "unused-hash");
  await store.activate("person-a");

  const svc = new TokenService({ store: store.tokens, clock: systemClock });
  const binding = { audience: "a2a" as const, agentId: "main", system: "peer-1" };
  const minted = await svc.create("person-a", { name: "a2a-peer", scopes: ["agent.use"], binding });
  assert.deepEqual(minted.record.binding, binding);

  store.close();
  store = new AccountStore({ path: dbPath, resolve: async () => person });
  const reopened = new TokenService({ store: store.tokens, clock: systemClock });
  const auth = await reopened.authenticate(minted.token);
  assert.equal(auth.ok, true);
  if (auth.ok) assert.deepEqual(auth.record.binding, binding);
});

test("A1.1: tokens.create rejects unknown/deleted agents, missing agent.use, inaccessible projects and malformed bindings", async () => {
  const h = await setup();
  try {
    const { cookie } = await loginAs(h, "mia");
    const post = (body: unknown) => write(h, cookie, { path: "/api/v1/tokens", body });

    // Unknown agent -> 404
    const unknownAgent = await post({
      name: "t",
      scopes: ["agent.use"],
      binding: { audience: "mcp", agentId: "ghost" },
    });
    assert.equal(unknownAgent.status, 404);
    assert.equal(unknownAgent.json.reason, "agent");

    // Deleted agent -> 404
    const deletedAgent = await post({
      name: "t",
      scopes: ["agent.use"],
      binding: { audience: "mcp", agentId: "deleted-agent" },
    });
    assert.equal(deletedAgent.status, 404);
    assert.equal(deletedAgent.json.reason, "agent");

    // Existing agent without agent.use -> 403
    const noUse = await post({
      name: "t",
      scopes: ["agent.use"],
      binding: { audience: "mcp", agentId: "other" },
    });
    assert.equal(noUse.status, 403);
    assert.equal(noUse.json.reason, "object-right-required");

    // Unknown project -> 404
    const unknownProj = await post({
      name: "t",
      scopes: ["agent.use"],
      binding: { audience: "mcp", agentId: "main", projectId: "proj-missing" },
    });
    assert.equal(unknownProj.status, 404);
    assert.equal(unknownProj.json.reason, "project");

    // Inaccessible project -> 403
    const deniedProj = await post({
      name: "t",
      scopes: ["agent.use"],
      binding: { audience: "mcp", agentId: "main", projectId: "proj-secret" },
    });
    assert.equal(deniedProj.status, 403);

    // Malformed binding shapes -> 400 reason "binding"
    for (const bad of [
      null,
      [],
      {},
      { audience: "web", agentId: "main" },
      { audience: "mcp", agentId: "" },
      { audience: "mcp", agentId: "main", projectId: "" },
      { audience: "mcp", agentId: "main", system: "" },
      { audience: "mcp", agentId: "main", extra: true },
      { audience: "mcp", agentId: "main", groups: ["exec"] },
      { audience: "mcp", agentId: "main", memory: { filter: ["invalid"] } },
    ]) {
      const r = await post({ name: "t", scopes: ["agent.use"], binding: bad });
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.equal(r.json.reason, "binding", JSON.stringify(bad));
    }
  } finally {
    await h.close();
  }
});

test("A1.1: a token without binding or with wrong audience is rejected on /mcp and /a2a", async () => {
  const h = await setup();
  try {
    const { cookie } = await loginAs(h, "mia");
    const unbound = await write(h, cookie, {
      path: "/api/v1/tokens",
      body: { name: "unbound", scopes: ["agent.use"] },
    });
    assert.equal(unbound.status, 201);

    const mcpBound = await write(h, cookie, {
      path: "/api/v1/tokens",
      body: { name: "mcp-bound", scopes: ["agent.use"], binding: { audience: "mcp", agentId: "main" } },
    });
    assert.equal(mcpBound.status, 201);

    const a2aBound = await write(h, cookie, {
      path: "/api/v1/tokens",
      body: { name: "a2a-bound", scopes: ["agent.use"], binding: { audience: "a2a", agentId: "main" } },
    });
    assert.equal(a2aBound.status, 201);

    // Unbound token rejected on both /mcp and /a2a
    const rUnboundMcp = await bearer(h, unbound.json.token, "/mcp", "POST");
    assert.equal(rUnboundMcp.status, 403);
    assert.equal(rUnboundMcp.json.reason, "token-binding-required");

    const rUnboundA2a = await bearer(h, unbound.json.token, "/a2a", "POST");
    assert.equal(rUnboundA2a.status, 403);
    assert.equal(rUnboundA2a.json.reason, "token-binding-required");

    // Wrong audience rejected with 401
    const rWrongOnA2a = await bearer(h, mcpBound.json.token, "/a2a", "POST");
    assert.equal(rWrongOnA2a.status, 401);
    assert.equal(rWrongOnA2a.json.reason, "invalid-audience");

    const rWrongOnMcp = await bearer(h, a2aBound.json.token, "/mcp", "POST");
    assert.equal(rWrongOnMcp.status, 401);
    assert.equal(rWrongOnMcp.json.reason, "invalid-audience");

    // Matching audience allowed
    const rOkMcp = await bearer(h, mcpBound.json.token, "/mcp", "POST");
    assert.equal(rOkMcp.status, 200);
    assert.deepEqual(rOkMcp.json.binding, { audience: "mcp", agentId: "main" });

    const rOkA2a = await bearer(h, a2aBound.json.token, "/a2a", "POST");
    assert.equal(rOkA2a.status, 200);
    assert.deepEqual(rOkA2a.json.binding, { audience: "a2a", agentId: "main" });

    // M6A-B6: Agent-bound tokens are rejected on all non-protocol routes
    const rBoundOnWhoami = await bearer(h, mcpBound.json.token, "/api/v1/whoami", "GET");
    assert.equal(rBoundOnWhoami.status, 403);
    assert.equal(rBoundOnWhoami.json.reason, "token-bound-protocol-only");

    const rA2aBoundOnWhoami = await bearer(h, a2aBound.json.token, "/api/v1/whoami", "GET");
    assert.equal(rA2aBoundOnWhoami.status, 403);
    assert.equal(rA2aBoundOnWhoami.json.reason, "token-bound-protocol-only");

    // Unbound personal token continues to work on general API routes
    const rUnboundWhoami = await bearer(h, unbound.json.token, "/api/v1/whoami", "GET");
    assert.equal(rUnboundWhoami.status, 200);
  } finally {
    await h.close();
  }
});
