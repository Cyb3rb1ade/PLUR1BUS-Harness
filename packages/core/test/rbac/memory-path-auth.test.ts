import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindApiPrincipal, bindClientContext, type ApiPrincipal } from "@plur1bus/module-api";
import { LOCAL_OWNER, RPC_RULES, guardMethods } from "../../src/rbac/guard.ts";
import type { Principal } from "../../src/rbac/types.ts";
import { buildMethods, type MethodDeps } from "../../src/rpc/methods.ts";
import { deriveUserPrincipal } from "../../src/identity/principals.ts";
import { userPrincipalHash } from "../../src/principal.ts";
import { RpcError } from "../../src/rpc/errors.ts";
import type { CallContext } from "../../src/rpc/server.ts";

function makeHarness() {
  const dir = mkdtempSync(join(tmpdir(), "m6a-a15-"));
  const wsAlpha = join(dir, "alpha");
  const wsBeta = join(dir, "beta");
  mkdirSync(wsAlpha, { recursive: true });
  mkdirSync(wsBeta, { recursive: true });

  const recalls: Array<{ query: string; principal: any }> = [];
  const captures: Array<{ agentId: string; principal: any }> = [];

  const deps: MethodDeps = {
    engine: {
      recall: async (req: any) => {
        recalls.push({ query: req.query, principal: req.principal });
        return {
          blocks: [{ name: "workspace", text: "fact", droppable: true, chars: 4 }],
          capChars: 1000,
          degraded: null,
          timing: { totalMs: 1 },
          deferrals: [],
        };
      },
      capture: (req: any) => {
        captures.push({ agentId: req.agentId, principal: req.principal });
        return {
          id: "cap_1",
          acceptedAt: 100,
          done: Promise.resolve({ stored: 1, skipped: 0 }),
        };
      },
      jobs: { list: () => [], run: async () => ({} as any) },
      checkpoint: async () => ({ agentId: "alpha", reason: "manual", digest: "d", written: 0 }),
      open: async () => ({ close: async () => {} }),
      memory: {} as any,
    } as any,
    config: () => ({
      core: {
        recall: { hardBudgetMs: 1000, softBudgetMs: 500, capChars: 4000 },
        capture: { waitMs: 1000 },
      },
    } as any),
    agents: {
      list: () => ["alpha", "beta"],
      has: (id: string) => id === "alpha" || id === "beta",
      scaffold: () => {},
      workspaceOf: (id: string) => (id === "alpha" ? wsAlpha : id === "beta" ? wsBeta : undefined),
    },
    activity: {
      set: () => {},
      idle: () => {},
      get: () => ({ state: "idle", since: 0 }),
      onChange: () => () => {},
    } as any,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
    status: () => ({} as any),
    shutdown: () => {},
    journalBacklog: () => 0,
    clock: () => 1000,
    captureSignal: new AbortController().signal,
    isStopping: () => false,
    adopt: () => ({} as any),
    onMigrated: () => {},
  };

  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return { deps, recalls, captures, cleanup };
}

function makeCtx(id = "req-1"): CallContext {
  return { requestId: id, connectionId: "conn-1", signal: new AbortController().signal };
}

describe("M6A-A1.5: secured memory.recall and memory.capture path", () => {
  it("registers RPC_RULES for memory.recall and memory.capture", () => {
    assert.ok(RPC_RULES["memory.recall"], "memory.recall must have an RPC_RULES entry");
    assert.ok(RPC_RULES["memory.capture"], "memory.capture must have an RPC_RULES entry");
  });

  it("enforces agent.use or memory.*.read for memory.recall and memory.*.write for memory.capture", async () => {
    const h = makeHarness();
    try {
      let currentPrincipal: Principal = LOCAL_OWNER;
      const guarded = guardMethods(buildMethods(h.deps), {
        resolve: () => currentPrincipal,
        now: () => 1000,
      });

      // Member without right on alpha is denied on both memory.recall and memory.capture
      currentPrincipal = { userId: "alice", role: "member", kind: "person" };
      await assert.rejects(
        () => guarded["memory.recall"]!({ caller: { channel: "cli", accountId: "a", userId: "alice" }, agentId: "alpha", query: "q" }, makeCtx()),
        (err: unknown) => err instanceof RpcError && err.error === "E_DENIED",
      );
      await assert.rejects(
        () => guarded["memory.capture"]!({ caller: { channel: "cli", accountId: "a", userId: "alice" }, agentId: "alpha", messages: [{ role: "user", content: "hi" }] }, makeCtx()),
        (err: unknown) => err instanceof RpcError && err.error === "E_DENIED",
      );

      // Agent token with memory.workspace.read + memory.user.read is allowed on memory.recall, but denied on memory.capture
      currentPrincipal = {
        userId: "alice",
        role: "member",
        kind: "agent",
        agentRights: { alpha: "use" },
        tokenScopes: ["memory.workspace.read", "memory.user.read"],
        binding: { audience: "mcp", agentId: "alpha" },
      };
      const recallCtx = makeCtx("recall-mcp");
      bindApiPrincipal(recallCtx, {
        userId: "alice",
        role: "member",
        kind: "agent",
        agentRights: { alpha: "use" },
        tokenScopes: ["memory.workspace.read", "memory.user.read"],
        binding: { audience: "mcp", agentId: "alpha" },
      });
      await guarded["memory.recall"]!({ caller: { channel: "cli", accountId: "mcp", userId: "spoofed" }, agentId: "alpha", query: "q" }, recallCtx);

      await assert.rejects(
        () => guarded["memory.capture"]!({ caller: { channel: "cli", accountId: "mcp", userId: "alice" }, agentId: "alpha", messages: [{ role: "user", content: "hi" }] }, recallCtx),
        (err: unknown) => err instanceof RpcError && err.error === "E_DENIED" && err.reason === "token-scope",
      );

      // Agent token with memory.workspace.write is allowed on memory.capture
      const writePrincipal: ApiPrincipal = {
        userId: "alice",
        role: "member",
        kind: "agent",
        agentRights: { alpha: "use" },
        tokenScopes: ["memory.workspace.write"],
        binding: { audience: "mcp", agentId: "alpha" },
      };
      currentPrincipal = writePrincipal;
      const captureCtx = makeCtx("capture-mcp");
      bindApiPrincipal(captureCtx, writePrincipal);
      await guarded["memory.capture"]!({ caller: { channel: "cli", accountId: "mcp", userId: "spoofed" }, agentId: "alpha", messages: [{ role: "user", content: "hi" }] }, captureCtx);
    } finally {
      h.cleanup();
    }
  });

  it("binds delegated ApiPrincipal to deriveUserPrincipal(person), ignores caller.userId, and enforces binding.agentId", async () => {
    const h = makeHarness();
    try {
      const delegated: ApiPrincipal = {
        userId: "alice",
        role: "member",
        kind: "agent",
        agentRights: { alpha: "use", beta: "use" },
        tokenScopes: ["memory.workspace.read", "memory.user.read", "memory.workspace.write"],
        binding: { audience: "mcp", agentId: "alpha" },
      };
      const guarded = guardMethods(buildMethods(h.deps), {
        resolve: () => delegated,
        now: () => 1000,
      });

      const ctx = makeCtx("delegated-1");
      bindApiPrincipal(ctx, delegated);

      // Spoofed caller.userId = "bob" must be ignored; engine receives deriveUserPrincipal("alice")
      await guarded["memory.recall"]!(
        { caller: { channel: "cli", accountId: "mcp", userId: "bob" }, agentId: "alpha", query: "hello" },
        ctx,
      );
      assert.equal(h.recalls.length, 1);
      assert.equal(h.recalls[0]!.principal.user, deriveUserPrincipal("alice"));

      await guarded["memory.capture"]!(
        { caller: { channel: "cli", accountId: "mcp", userId: "bob" }, agentId: "alpha", messages: [{ role: "user", content: "note" }] },
        ctx,
      );
      assert.equal(h.captures.length, 1);
      assert.equal(h.captures[0]!.principal.user, deriveUserPrincipal("alice"));

      // Calling for agent "beta" when token is bound to "alpha" must fail with E_DENIED (even though alice has use on beta)
      await assert.rejects(
        () => guarded["memory.recall"]!(
          { caller: { channel: "cli", accountId: "mcp", userId: "alice" }, agentId: "beta", query: "hello" },
          ctx,
        ),
        (err: unknown) => err instanceof RpcError && err.error === "E_DENIED" && err.reason === "agent-binding-mismatch",
      );
      await assert.rejects(
        () => guarded["memory.capture"]!(
          { caller: { channel: "cli", accountId: "mcp", userId: "alice" }, agentId: "beta", messages: [{ role: "user", content: "note" }] },
          ctx,
        ),
        (err: unknown) => err instanceof RpcError && err.error === "E_DENIED" && err.reason === "agent-binding-mismatch",
      );
    } finally {
      h.cleanup();
    }
  });

  it("preserves exact existing behaviour for local CLI and Hermes scoped clients (regression)", async () => {
    const h = makeHarness();
    try {
      // 1. Local CLI (no apiPrincipal, LOCAL_OWNER)
      const localGuarded = guardMethods(buildMethods(h.deps), {
        resolve: () => LOCAL_OWNER,
        now: () => 1000,
      });
      const localCaller = { channel: "cli" as const, accountId: "local-cli", userId: "os-user" };
      await localGuarded["memory.recall"]!({ caller: localCaller, agentId: "alpha", query: "local" }, makeCtx("local-1"));
      await localGuarded["memory.capture"]!(
        { caller: localCaller, agentId: "alpha", messages: [{ role: "user", content: "local capture" }] },
        makeCtx("local-2"),
      );
      assert.equal(h.recalls.at(-1)!.principal.user, userPrincipalHash(localCaller));
      assert.equal(h.captures.at(-1)!.principal.user, userPrincipalHash(localCaller));

      // 2. Hermes scoped client (bindApiPrincipal + bindClientContext with agent.use scope)
      const hermesPrincipal: ApiPrincipal = {
        userId: "local-owner",
        role: "owner",
        kind: "agent",
        tokenScopes: ["agent.read", "agent.use", "doctor.read"],
      };
      const hermesGuarded = guardMethods(buildMethods(h.deps), {
        resolve: () => hermesPrincipal,
        now: () => 1000,
      });
      const hermesCtx = makeCtx("hermes-1");
      bindApiPrincipal(hermesCtx, hermesPrincipal);
      bindClientContext(hermesCtx);
      const hermesCaller = { channel: "cli" as const, accountId: "hermes:cli", userId: "synthetic" };
      await hermesGuarded["memory.recall"]!({ caller: hermesCaller, agentId: "alpha", query: "hermes" }, hermesCtx);
      await hermesGuarded["memory.capture"]!(
        { caller: hermesCaller, agentId: "alpha", messages: [{ role: "user", content: "hermes capture" }] },
        hermesCtx,
      );
      assert.equal(h.recalls.at(-1)!.principal.user, userPrincipalHash(hermesCaller));
      assert.equal(h.captures.at(-1)!.principal.user, userPrincipalHash(hermesCaller));
    } finally {
      h.cleanup();
    }
  });
});
