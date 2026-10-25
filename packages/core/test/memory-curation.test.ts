import { test } from "node:test";
import assert from "node:assert/strict";
import { validateParams, validateResult, type CoreStatusResult } from "@plur1bus/rpc-schema";
import { buildMemoryCurationMethods } from "../src/memory-curation.ts";
import { guardMethods } from "../src/rbac/guard.ts";
import type { Principal } from "../src/rbac/types.ts";
import { deriveUserPrincipal } from "../src/identity/principals.ts";
import { tempDir } from "./helpers/temp-dir.ts";

function fixture() {
  let who: Principal | null = { userId: "alice", role: "member", kind: "person", agentRights: { anna: "manage" } };
  const calls: unknown[][] = [];
  const workspace = tempDir("curation-bridge-");
  const engine = { memory: { curation: {
    async list(...args: unknown[]) { calls.push(args); return { agentId: "anna", items: [{ id: "mem_0123456789abcdefabcd", status: "conflict", text: "quoted evidence", category: null, hidden: "never on wire" }], truncated: false, hidden: "never on wire" }; },
    async resolve(...args: unknown[]) { calls.push(args); return { id: args[0], ok: true, status: args[1] === "keep" ? "promoted" : "demoted", hidden: true }; },
  } } };
  const raw = buildMemoryCurationMethods({ engine: engine as never, agents: { list: () => ["anna", "bernd"], has: () => true, scaffold() {}, workspaceOf: () => workspace }, logger: { debug() {}, info() {}, warn() {}, error() {} } as never, isStopping: () => false });
  const methods = guardMethods(raw, { resolve: () => who, now: () => 1 });
  const call = (method: string, params: object) => methods[method]!(params, { requestId: "x", connectionId: "x", signal: new AbortController().signal });
  return { engine, calls, call, who: (p: Principal | null) => { who = p; } };
}

test("curation uses authenticated self identity and exact manage grant; agent principals and foreign agents fail closed", async () => {
  const f = fixture();
  const result = await f.call("memory.curation.list", { agentId: "anna" });
  assert.ok(validateResult("memory.curation.list", result).ok);
  assert.ok(!JSON.stringify(result).includes("hidden"));
  assert.equal((f.calls[0]![1] as any).user, deriveUserPrincipal("alice"));
  await assert.rejects(f.call("memory.curation.list", { agentId: "bernd" }), (e: any) => e.error === "E_DENIED");
  f.who({ userId: "alice", role: "member", kind: "person" });
  await assert.rejects(f.call("memory.curation.list", { agentId: "anna" }), (e: any) => e.error === "E_DENIED");
  f.who({ userId: "model", role: "owner", kind: "agent", agentRights: { anna: "manage" } });
  await assert.rejects(f.call("memory.curation.resolve", { agentId: "anna", id: "mem_0123456789abcdefabcd", action: "keep" }), (e: any) => e.reason === "agent-principal");
  assert.equal(f.calls.length, 1);
});

test("curation keep/drop project successful receipts; missing Engine contract 1.17.0 is explicit unavailable", async () => {
  const f = fixture();
  f.who({ userId: "owner", role: "owner", kind: "person" });
  for (const action of ["keep", "drop"]) {
    const result = await f.call("memory.curation.resolve", { agentId: "anna", id: "mem_0123456789abcdefabcd", action });
    assert.ok(validateResult("memory.curation.resolve", result).ok);
    assert.equal((result as any).status, action === "keep" ? "promoted" : "demoted");
  }
  delete (f.engine.memory as any).curation;
  await assert.rejects(f.call("memory.curation.list", { agentId: "anna" }), (e: any) => e.error === "E_NOT_AVAILABLE" && e.reason === "engine-contract-unavailable");
});

test("curation schema accepts real Neo IDs and rejects caller spoofing, unknown keys and invalid action", () => {
  assert.ok(validateParams("memory.curation.resolve", { agentId: "anna", id: "mem_0123456789abcdefabcd", action: "keep" }).ok);
  assert.equal(validateParams("memory.curation.list", { agentId: "anna", caller: { userId: "victim" } }).ok, false);
  assert.equal(validateParams("memory.curation.resolve", { agentId: "anna", id: "x", action: "erase" }).ok, false);
  assert.equal(validateParams("memory.curation.resolve", { agentId: "anna", id: "x".repeat(201), action: "keep" }).ok, false);
});

test("curation is exposed only on the human web route and never as WebMCP, and unauthenticated access never reaches Engine", async () => {
  const { webEndpoint } = await import("../../api/src/rpc-route.ts");
  const { isForbiddenMethod } = await import("../../webmcp/src/provider.ts");
  const f = fixture(); f.who(null);
  for (const method of ["memory.curation.list", "memory.curation.resolve"]) {
    assert.equal(webEndpoint(method), "core");
    assert.ok(isForbiddenMethod(method));
    await assert.rejects(f.call(method, { agentId: "anna", id: "mem_0123456789abcdefabcd", action: "keep" }), (e: any) => e.error === "E_UNAUTHORIZED");
  }
  assert.equal(f.calls.length, 0);
});

test("real Core curation acceptance requires the curated-memory engine and persists Keep/Drop across restart", { timeout: 60_000 }, async () => {
  const { defaults } = await import("@plur1bus/config-schema");
  const { writeFileSync, mkdirSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { AdminStore } = await import("../src/identity/admin-store.ts");
  const { createCore } = await import("../src/core.ts");
  const { layout } = await import("../src/paths.ts");
  const { connect } = await import("./helpers/connect.ts");
  const { flatTestInternals } = await import("./helpers/flat-embedder.ts");
  const home = tempDir("a4-real-contract-");
  const neoRoot = join(home, "curation-neo-fixture");
  // Persisted Engine Neo format for explicit corpusDefaultWorkspaceKey=a4-curation.
  // The fixed canonical directory suffix is the format's hash, not a private Engine import.
  const queueDir = join(neoRoot, "workspaces", "a4-curation--758221ed203e8edc4023");
  const queuePath = join(queueDir, "memory-candidates.jsonl");
  const keepId = "mem_0123456789abcdefabcd";
  const dropId = "mem_1123456789abcdefabcd";
  const foreignId = "mem_2123456789abcdefabcd";
  const candidates = [
    { id: keepId, agentId: "anna", visibility: { scope: "agent_private" }, status: "conflict", statement: "Keep this genuine curation evidence.", createdAt: "2026-01-01T00:00:00.000Z" },
    { id: dropId, agentId: "anna", visibility: { scope: "agent_private" }, status: "candidate", statement: "Drop this superseded curation evidence.", createdAt: "2026-01-01T00:00:00.000Z" },
    { id: foreignId, agentId: "bernd", visibility: { scope: "agent_private" }, status: "conflict", statement: "Never reveal foreign evidence.", createdAt: "2026-01-01T00:00:00.000Z" },
  ];
  mkdirSync(queueDir, { recursive: true });
  writeFileSync(queuePath, candidates.map(row => JSON.stringify(row)).join("\n") + "\n");
  const cfg = defaults(); cfg.agents.anna = {}; cfg.agents.bernd = {};
  cfg.engine = { neo: { enabled: false, statePath: neoRoot, corpusDefaultWorkspaceKey: "a4-curation" }, gc: { enabled: false }, obsidianBridge: { enabled: false }, merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false }, reranker: { enabled: false }, temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false } };
  writeFileSync(layout(home).configPath, JSON.stringify(cfg));
  mkdirSync(layout(home).state, { recursive: true });
  const seed = new AdminStore({ path: join(layout(home).state, "admin.sqlite"), ownerId: "local-owner" });
  seed.setRole("alice", "member", () => {}); seed.setRight("anna", "alice", "manage"); seed.close();
  let who: Principal = { userId: "alice", role: "owner", kind: "person" };
  const openCore = () => createCore({ home, testInternals: flatTestInternals(), rbac: { resolve: () => who } });
  let core = openCore();
  await core.start();
  let client = await connect({ address: core.address, token: core.token });
  const isNotFound = (e: unknown) => e !== null && typeof e === "object" && "error" in e && e.error === "E_NOT_FOUND";
  const assertPersisted = () => {
    const latest = new Map<string, unknown>();
    for (const line of readFileSync(queuePath, "utf8").trim().split("\n")) {
      const row: unknown = JSON.parse(line);
      assert.ok(row !== null && typeof row === "object" && "id" in row && typeof row.id === "string" && "status" in row);
      latest.set(row.id, row.status);
    }
    assert.equal(latest.get(keepId), "promoted");
    assert.equal(latest.get(dropId), "demoted");
    assert.equal(latest.get(foreignId), "conflict");
    const audit = readFileSync(join(layout(home).workspaceDir("anna"), ".adaptive-learning", "destructive-ops.jsonl"), "utf8").trim().split("\n").map(line => {
      const row: unknown = JSON.parse(line);
      assert.ok(row !== null && typeof row === "object" && "event" in row && "recordId" in row && "action" in row);
      return { event: row.event, recordId: row.recordId, action: row.action };
    });
    assert.deepEqual(audit, [
      { event: "curation.resolve", recordId: keepId, action: "keep" },
      { event: "curation.resolve", recordId: dropId, action: "drop" },
    ]);
  };
  try {
    const status = await client.call<CoreStatusResult>("core.status");
    who = { userId: "alice", role: "member", kind: "person", agentRights: { anna: "manage" } };
    // The engine's curated memory (A1) is feature-tested, as the Core does: a contract number alone does not say it is there
    // (1.17.0 is also the re-embedding validate contract).
    const unavailable = (e: any) => e?.error === "E_NOT_AVAILABLE" && e?.reason === "engine-contract-unavailable";
    const ready = await client.call("memory.curation.list", { agentId: "anna" }).then(() => true, (e) => { if (unavailable(e)) return false; throw e; });
    const required = process.env.PLUR1BUS_REQUIRE_CURATION_ACCEPTANCE === "1" || Boolean(process.env.PLUR1BUS_ENGINE_ACCEPTANCE_SOURCE);
    if (required) assert.ok(ready, `mandatory A4 curation acceptance requires the Engine's curated memory (A1); installed contract ${String(status.contract)} has no memory.curation. Run against the Controller pin, or load the requested Engine source explicitly.`);
    if (ready) {
      assert.deepEqual(await client.call("memory.curation.list", { agentId: "anna" }), {
        agentId: "anna", items: [
          { id: keepId, status: "conflict", text: "Keep this genuine curation evidence.", category: null },
          { id: dropId, status: "candidate", text: "Drop this superseded curation evidence.", category: null },
        ], truncated: false,
      });
      await assert.rejects(client.call("memory.curation.resolve", { agentId: "anna", id: foreignId, action: "keep" }), isNotFound);
      assert.deepEqual(await client.call("memory.curation.resolve", { agentId: "anna", id: keepId, action: "keep" }), { agentId: "anna", id: keepId, status: "promoted" });
      assert.deepEqual(await client.call("memory.curation.resolve", { agentId: "anna", id: dropId, action: "drop" }), { agentId: "anna", id: dropId, status: "demoted" });
      assert.deepEqual(await client.call("memory.curation.list", { agentId: "anna" }), { agentId: "anna", items: [], truncated: false });
      assertPersisted();
      await client.close(); await core.stop({ budgetMs: 5000 });
      core = openCore(); await core.start();
      client = await connect({ address: core.address, token: core.token });
      assert.deepEqual(await client.call("memory.curation.list", { agentId: "anna" }), { agentId: "anna", items: [], truncated: false });
      for (const id of [keepId, dropId]) await assert.rejects(client.call("memory.curation.resolve", { agentId: "anna", id, action: "keep" }), isNotFound);
      assertPersisted();
    } else {
      // Executable KNOWN GAP until the Controller's Engine pin; no fake acceptance.
      for (const method of ["memory.curation.list", "memory.curation.resolve"]) await assert.rejects(client.call(method, { agentId: "anna", ...(method.endsWith("resolve") ? { id: keepId, action: "keep" } : {}) }), (e: any) => e.error === "E_NOT_AVAILABLE" && e.reason === "engine-contract-unavailable");
    }
    await assert.rejects(client.call("memory.curation.list", { agentId: "bernd" }), (e: any) => e.error === "E_DENIED");
  } finally { await client.close(); await core.stop({ budgetMs: 5000 }); }
});

test("curation requires a receipt for the exact requested record and action", async () => {
  const f = fixture();
  for (const receipt of [{ id: "another-record", ok: true, status: "promoted" }, { id: "record", ok: true, status: "demoted" }, { id: "record", ok: false, status: "promoted" }]) {
    (f.engine.memory.curation as any).resolve = async () => receipt;
    await assert.rejects(f.call("memory.curation.resolve", { agentId: "anna", id: "record", action: "keep" }), (e: any) => e.error === "E_CONFLICT");
  }
});

test("curation refuses an Engine list for another agent before any evidence reaches the wire", async () => {
  const f = fixture();
  (f.engine.memory.curation as any).list = async () => ({ agentId: "bernd", items: [{ id: "foreign", text: "private foreign evidence", status: "conflict", category: null }], truncated: false });
  await assert.rejects(f.call("memory.curation.list", { agentId: "anna" }), (e: any) => e.error === "E_CONFLICT" && !e.message.includes("private foreign evidence"));
});
