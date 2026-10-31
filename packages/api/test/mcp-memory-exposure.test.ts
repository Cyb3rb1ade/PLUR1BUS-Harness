// MCP tools exercise the guarded Core memory boundary against an engine ACL fixture.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { defaults } from "@plur1bus/config-schema";
import { bindApiPrincipal, type ApiPrincipal } from "@plur1bus/module-api";
import type { MemoryRecallResult } from "@plur1bus/rpc-schema";
import { guardMethods } from "../../core/src/rbac/guard.ts";
import { buildMethods, type MethodDeps } from "../../core/src/rpc/methods.ts";
import { MemorySensitivityService } from "../../core/src/memory-sensitivity/service.ts";
import { MemorySensitivityStore } from "../../core/src/memory-sensitivity/store.ts";
import { deriveUserPrincipal } from "../../core/src/identity/principals.ts";
import { MemoryToolGroup } from "../src/mcp/tools/memory.ts";
import { McpServerCore } from "../src/mcp/server.ts";

type Engine = MethodDeps["engine"];
type EnginePrincipal = Parameters<Engine["recall"]>[0]["principal"];

function fixture(t: TestContext, options: { memoryText?: string; onRecall?: () => void } = {}) {
  const home = mkdtempSync(join(tmpdir(), "mcp-exposure-"));
  const config = defaults();
  config.agents.alpha = {};
  const sensitivity = new MemorySensitivityService({ store: new MemorySensitivityStore({ path: ":memory:" }) });
  t.after(() => { sensitivity.close(); rmSync(home, { recursive: true, force: true }); });
  const recalls: EnginePrincipal[] = [];
  const captures: EnginePrincipal[] = [];
  const principal: ApiPrincipal = {
    kind: "agent", role: "owner", userId: "alice", tokenId: "tok-personal",
    tokenScopes: ["memory.workspace.read", "memory.agent-private.read", "memory.workspace.write"],
    binding: { audience: "mcp", agentId: "alpha" },
  };
  const engine = {
    recall: async ({ principal }: Parameters<Engine["recall"]>[0]) => {
      recalls.push(principal);
      options.onRecall?.();
      const blocks = [
        { name: "identity", text: "MARK-PRIVATE", droppable: false, chars: 12, tokensEstimate: 3 },
        { name: "memories", text: options.memoryText ?? "MARK-HEALTH diabetes", droppable: true, chars: 20 },
        ...(principal.user ? [{ name: "user", text: "MARK-USER", droppable: true, chars: 9 }] : []),
      ];
      return {
        blocks, capChars: 4096, degraded: null, timing: { totalMs: 7, phases: { completed: ["entry"] } },
        deferrals: [], trace: { preview: "MARK-HEALTH diabetes" },
      };
    },
    capture: ({ principal }: Parameters<Engine["capture"]>[0]) => {
      captures.push(principal);
      return { id: "capture", acceptedAt: 100, done: Promise.resolve({ stored: 1, skipped: 0 }) };
    },
  } as unknown as Engine;
  const noop = () => {};
  let effectivePrincipal = principal;
  const methods = guardMethods(buildMethods({
    engine, config: () => config,
    agents: { workspaceOf: () => home, has: () => true, list: () => ["alpha"], scaffold: noop },
    activity: { set: noop, idle: noop } as unknown as MethodDeps["activity"],
    logger: { info: noop, warn: noop, error: noop, debug: noop } as unknown as MethodDeps["logger"],
    status: () => ({} as ReturnType<MethodDeps["status"]>), shutdown: noop, journalBacklog: () => 0,
    clock: () => 100, captureSignal: new AbortController().signal, isStopping: () => false,
    adopt: () => ({} as ReturnType<MethodDeps["adopt"]>), onMigrated: noop,
    // The production getter is live; this test enables it after building the handlers.
    memorySensitivity: () => activeSensitivity,
  }), { resolve: () => effectivePrincipal, now: () => 100 });
  let activeSensitivity: MemorySensitivityService | null = null;
  const call = async (method: string, params: unknown) => {
    const ctx = { requestId: "mcp", connectionId: "api", signal: new AbortController().signal };
    bindApiPrincipal(ctx, principal);
    return methods[method]!(params, ctx);
  };
  const recall = async (): Promise<MemoryRecallResult> => {
    const ctx = { agentId: "alpha", rbac: principal, core: { call } };
    const server = new McpServerCore({ ...ctx, tools: new MemoryToolGroup().buildTools(ctx) });
    const result = await server.executeTool("memory_recall", { query: "facts" });
    assert.equal(result.isError, undefined, result.content[0]?.text);
    return JSON.parse(result.content[0]!.text) as MemoryRecallResult;
  };
  const store = async () => {
    const ctx = { agentId: "alpha", rbac: principal, core: { call } };
    const server = new McpServerCore({ ...ctx, tools: new MemoryToolGroup().buildTools(ctx) });
    return server.executeTool("memory_store", { text: "fact" });
  };
  const capture = () => call("memory.capture", {
    agentId: "alpha", caller: { channel: "cli", accountId: "spoofed", userId: "mallory" },
    messages: [{ role: "user", content: "fact" }], wait: true,
  });
  return { config, principal, recalls, captures, recall, capture, store, call, sensitivity,
    setEffectivePrincipal: (current: ApiPrincipal) => { effectivePrincipal = current; },
    enableSensitivity: () => { activeSensitivity = sensitivity; } };
}

test("MCP tools/call refuses disabled channel scopes before engine access", async t => {
  const f = fixture(t);
  f.config.agents.alpha = { memoryExposure: { mcp: { recall: { workspace: false } } } };
  const result = await f.recall();
  assert.equal(f.recalls.length, 0, "disabled workspace must never query the full engine principal");
  assert.deepEqual(result.blocks, []);
  assert.equal(result.degraded?.reason, "scope-not-enforceable");
});

test("MCP tools/call refuses a workspace-only token before agent-private engine access", async t => {
  const f = fixture(t);
  f.principal.tokenScopes = ["memory.workspace.read"];
  const result = await f.recall();
  assert.equal(f.recalls.length, 0);
  assert.deepEqual(result.blocks, []);
});

test("MCP tools/call with use rights cannot read agent-private memory", async t => {
  const f = fixture(t);
  f.principal.role = "member";
  f.principal.agentRights = { alpha: "use" };
  const result = await f.recall();
  assert.equal(f.recalls.length, 0);
  assert.deepEqual(result.blocks, []);
});

test("MCP owner recall preserves raw metadata and excludes user memory outside token scopes", async t => {
  const f = fixture(t);
  const result = await f.recall();
  assert.equal(f.recalls.length, 1);
  assert.equal(f.recalls[0]!.user, undefined);
  assert.deepEqual(result.blocks.map(b => b.text), ["MARK-PRIVATE", "MARK-HEALTH diabetes"]);
  assert.deepEqual(result.timing, { totalMs: 7, phases: { completed: ["entry"] } });
  assert.deepEqual(result.trace, { preview: "MARK-HEALTH diabetes" });
  assert.deepEqual(result.deferrals, []);
  assert.equal(result.capChars, 4096);
  assert.equal(result.blocks[0]!.tokensEstimate, 3);
});

test("MCP sensitivity filters apply to blocks, joined text and trace using the live service", async t => {
  const f = fixture(t);
  f.principal.binding = { ...f.principal.binding!, memory: { filter: ["health"] } };
  f.enableSensitivity();
  const result = await f.recall();
  assert.equal(f.recalls.length, 1);
  assert.deepEqual(result.blocks.map(b => b.text), ["MARK-PRIVATE"]);
  assert.doesNotMatch(JSON.stringify(result), /MARK-HEALTH|diabetes/);
  assert.match(result.joined!.text, /MARK-PRIVATE/);
  assert.equal(result.timing.totalMs, 7);
});

test("MCP sensitivity filtering fails closed when the sensitivity service is unavailable", async t => {
  const f = fixture(t);
  f.principal.binding = { ...f.principal.binding!, memory: { filter: ["health"] } };
  const result = await f.recall();
  assert.equal(f.recalls.length, 0);
  assert.deepEqual(result.blocks, []);
});

test("Core enforces token recall and disclosure overrides despite a forged CLI caller", async t => {
  const f = fixture(t);
  for (const memory of [{ recall: { agentPrivate: false } }, { disclose: "never" as const }]) {
    f.principal.binding = { ...f.principal.binding!, memory };
    const result = await f.call("memory.recall", {
      caller: { channel: "cli", accountId: "local", userId: "mallory" }, agentId: "alpha", query: "facts",
    }) as MemoryRecallResult;
    assert.deepEqual(result.blocks, []);
  }
  assert.equal(f.recalls.length, 0);
});

test("Core capture respects channel and token capture restrictions before engine access", async t => {
  const f = fixture(t);
  f.principal.kind = "person";
  f.config.agents.alpha = { memoryExposure: { mcp: { capture: false } } };
  await assert.rejects(f.capture, /capture/i);
  f.config.agents.alpha = {};
  f.principal.binding = { ...f.principal.binding!, memory: { capture: false } };
  await assert.rejects(f.capture, /capture/i);
  assert.equal(f.captures.length, 0);
});

test("Core permits personal token capture with authenticated identity and refuses a true agent capture", async t => {
  const f = fixture(t);
  await f.capture();
  assert.equal(f.captures[0]!.user, deriveUserPrincipal("alice"));
  delete f.principal.tokenId;
  await assert.rejects(f.capture, /capture/i);
  assert.equal(f.captures.length, 1);
});


test("A personal bound token recalls only its authenticated person's user memory when authorized", async t => {
  const f = fixture(t);
  f.principal.tokenScopes = ["memory.*"];
  await f.recall();
  assert.equal(f.recalls[0]!.user, deriveUserPrincipal("alice"));
  assert.equal(f.principal.kind, "agent", "memory attribution must not grant human-only privileges");
});

test("A personal member token may capture with explicit workspace write authorization", async t => {
  const f = fixture(t);
  f.principal.role = "member";
  f.principal.agentRights = { alpha: "use" };
  f.principal.tokenScopes = ["memory.workspace.write"];
  await f.capture();
  assert.equal(f.captures.length, 1);
  assert.equal(f.captures[0]!.user, deriveUserPrincipal("alice"));
});


test("Core uses current resolved rights even when the delegated snapshot still has owner rights", async t => {
  const f = fixture(t);
  f.setEffectivePrincipal({ ...f.principal, role: "member", agentRights: { alpha: "use" } });
  const result = await f.recall();
  assert.deepEqual(result.blocks, []);
  assert.equal(f.recalls.length, 0);
});

test("A true agent never receives user memory even with a memory.user.read action scope", async t => {
  const f = fixture(t);
  delete f.principal.tokenId;
  f.principal.tokenScopes = ["memory.*"];
  const result = await f.recall();
  assert.equal(f.recalls[0]!.user, undefined);
  assert.doesNotMatch(JSON.stringify(result), /MARK-USER/);
});

test("The token user-recall override removes user scope without refusing authorized agent scopes", async t => {
  const f = fixture(t);
  f.principal.tokenScopes = ["memory.*"];
  f.principal.binding = { ...f.principal.binding!, memory: { recall: { user: false } } };
  const result = await f.recall();
  assert.equal(f.recalls.length, 1);
  assert.equal(f.recalls[0]!.user, undefined);
  assert.match(result.joined!.text, /MARK-PRIVATE/);
  assert.doesNotMatch(JSON.stringify(result), /MARK-USER/);
});

test("Core selects exposure from verified audience even when the caller claims another channel", async t => {
  const f = fixture(t);
  f.principal.binding = { ...f.principal.binding!, audience: "a2a" };
  f.config.agents.alpha = { memoryExposure: { a2a: { recall: { agentPrivate: false } } } };
  const result = await f.call("memory.recall", {
    caller: { channel: "mcp", accountId: "local", userId: "mallory" }, agentId: "alpha", query: "facts",
  }) as MemoryRecallResult;
  assert.deepEqual(result.blocks, []);
  assert.equal(f.recalls.length, 0);
});

test("Core refuses recall and capture when the token excludes the memory tool group", async t => {
  const f = fixture(t);
  f.principal.binding = { ...f.principal.binding!, groups: ["agent"] };
  const result = await f.call("memory.recall", {
    caller: { channel: "cli", accountId: "local", userId: "mallory" }, agentId: "alpha", query: "facts",
  }) as MemoryRecallResult;
  assert.deepEqual(result.blocks, []);
  await assert.rejects(f.capture, /capture/i);
  assert.equal(f.recalls.length, 0);
  assert.equal(f.captures.length, 0);
});

test("MCP memory_store refuses a disabled capture channel and permits an authorized personal token", async t => {
  const f = fixture(t);
  f.config.agents.alpha = { memoryExposure: { mcp: { capture: false } } };
  const denied = await f.store();
  assert.equal(denied.isError, true);
  assert.equal(f.captures.length, 0);
  f.config.agents.alpha = {};
  const allowed = await f.store();
  assert.equal(allowed.isError, undefined);
  assert.equal(f.captures.length, 1);
  assert.equal(f.captures[0]!.user, deriveUserPrincipal("alice"));
});


test("A token sensitivity filter cannot release an opaque manually labelled card inside an aggregate block", async t => {
  const f = fixture(t, { memoryText: "MARK-OPAQUE-LABEL" });
  f.sensitivity.setSensitivity("card-sensitive-42", ["health"]);
  f.principal.binding = { ...f.principal.binding!, memory: { filter: ["health"] } };
  f.enableSensitivity();
  const result = await f.recall();
  assert.doesNotMatch(JSON.stringify(result), /MARK-OPAQUE-LABEL/);
  assert.equal(result.degraded?.reason, "sensitivity-not-enforceable");
  assert.equal(f.recalls.length, 0);
});


test("An unrelated manual category does not suppress rule-filtered recall", async t => {
  const f = fixture(t, { memoryText: "MARK-UNCLASSIFIED" });
  f.sensitivity.setSensitivity("other-card", ["financial"]);
  f.principal.binding = { ...f.principal.binding!, memory: { filter: ["health"] } };
  f.enableSensitivity();
  const result = await f.recall();
  assert.match(result.joined!.text, /MARK-UNCLASSIFIED/);
  assert.equal(result.degraded, null);
});

test("Clearing a matching manual label restores unmarked aggregate recall", async t => {
  const f = fixture(t, { memoryText: "MARK-UNCLASSIFIED" });
  f.sensitivity.setSensitivity("opaque-card", ["health"]);
  f.principal.binding = { ...f.principal.binding!, memory: { filter: ["health"] } };
  f.enableSensitivity();
  assert.deepEqual((await f.recall()).blocks, []);
  f.sensitivity.clearSensitivity("opaque-card", "health");
  assert.match((await f.recall()).joined!.text, /MARK-UNCLASSIFIED/);
});

test("Aggregate classification never treats a block name as an unrelated manual card id", async t => {
  const f = fixture(t);
  f.sensitivity.setSensitivity("memories", ["financial"]);
  f.principal.binding = { ...f.principal.binding!, memory: { filter: ["health"] } };
  f.enableSensitivity();
  const result = await f.recall();
  assert.doesNotMatch(JSON.stringify(result), /MARK-HEALTH|diabetes/);
});


test("A manual label added while recall is in flight prevents release of the returned aggregate", async t => {
  let mark: (() => void) | undefined;
  const f = fixture(t, { memoryText: "MARK-INFLIGHT", onRecall: () => mark?.() });
  mark = () => { f.sensitivity.setSensitivity("inflight-card", ["health"]); };
  f.principal.binding = { ...f.principal.binding!, memory: { filter: ["health"] } };
  f.enableSensitivity();
  const result = await f.recall();
  assert.equal(f.recalls.length, 1);
  assert.deepEqual(result.blocks, []);
  assert.equal(result.degraded?.reason, "sensitivity-not-enforceable");
  assert.doesNotMatch(JSON.stringify(result), /MARK-INFLIGHT|MARK-HEALTH|diabetes/);
});
