import { test } from "node:test";
import assert from "node:assert/strict";
import { validateParams, validateResult } from "@plur1bus/rpc-schema";
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

test("real pinned Core transport proves the controller-pin gap explicitly, then exercises real curation when 1.17.0 is installed", { timeout: 60_000 }, async () => {
  const { defaults } = await import("@plur1bus/config-schema");
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { AdminStore } = await import("../src/identity/admin-store.ts");
  const { createCore } = await import("../src/core.ts");
  const { layout } = await import("../src/paths.ts");
  const { connect } = await import("./helpers/connect.ts");
  const { flatTestInternals } = await import("./helpers/flat-embedder.ts");
  const home = tempDir("a4-real-contract-");
  const cfg = defaults(); cfg.agents.anna = {}; cfg.agents.bernd = {};
  cfg.engine = { neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false }, merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false }, reranker: { enabled: false }, temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false } };
  writeFileSync(layout(home).configPath, JSON.stringify(cfg));
  mkdirSync(layout(home).state, { recursive: true });
  const seed = new AdminStore({ path: join(layout(home).state, "admin.sqlite"), ownerId: "local-owner" });
  seed.setRole("alice", "member", () => {}); seed.setRight("anna", "alice", "manage"); seed.close();
  let who: Principal = { userId: "alice", role: "owner", kind: "person" };
  const core = createCore({ home, testInternals: flatTestInternals(), rbac: { resolve: () => who } });
  await core.start();
  const client = await connect({ address: core.address, token: core.token });
  try {
    const status = await client.call<any>("core.status");
    const [major, minor] = String(status.contract).split(".").map(Number);
    const ready = major! > 1 || (major === 1 && minor! >= 17);
    who = { userId: "alice", role: "member", kind: "person", agentRights: { anna: "manage" } };
    if (ready) {
      assert.deepEqual(await client.call("memory.curation.list", { agentId: "anna" }), { agentId: "anna", items: [], truncated: false });
      await assert.rejects(client.call("memory.curation.resolve", { agentId: "anna", id: "mem_0123456789abcdefabcd", action: "keep" }), (e: any) => e.error === "E_NOT_FOUND");
    } else {
      // Executable KNOWN GAP until the Controller's Engine pin; no fake acceptance.
      for (const method of ["memory.curation.list", "memory.curation.resolve"]) await assert.rejects(client.call(method, { agentId: "anna", ...(method.endsWith("resolve") ? { id: "mem_0123456789abcdefabcd", action: "keep" } : {}) }), (e: any) => e.error === "E_NOT_AVAILABLE" && e.reason === "engine-contract-unavailable");
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
