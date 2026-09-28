import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ERROR_CODES, METHODS, NOTIFICATIONS, RPC_VERSION, SCHEMA, buildCapabilities, loadFixtures, precompileMethods, validateErrorObject, validateNotification, validateParams, validateResult } from "../src/index.ts";

describe("rpc-schema", () => {
  const fx = loadFixtures();

  it("declares rpc 1.3.0 and the closed error enum", () => {
    assert.equal(RPC_VERSION, "1.3.0");
    assert.deepEqual([...ERROR_CODES], [
      "E_UNAUTHORIZED", "E_RPC_VERSION", "E_NOT_AVAILABLE", "E_CORE_UNAVAILABLE", "E_INVALID_PARAMS",
      "E_AGENT_UNKNOWN", "E_CONFIG_INVALID", "E_MODULE_UNKNOWN", "E_INTERNAL", "E_LOCKED",
      "E_NOT_FOUND", "E_DENIED", "E_APPROVAL_REQUIRED", "E_CONFLICT", "E_STORAGE",
    ]);
  });

  it("has one valid params/result fixture for every method", () => {
    for (const method of METHODS) {
      const f = fx.methods[method];
      assert.ok(f, `fixture missing for ${method}`);
      assert.deepEqual(validateParams(method, f.params), { ok: true }, `${method} params`);
      assert.deepEqual(validateResult(method, f.result), { ok: true }, `${method} result`);
    }
    assert.deepEqual(Object.keys(fx.methods).sort(), [...METHODS].sort(), "no fixture without a method");
  });

  it("has one fixture per error code and one per notification", () => {
    assert.deepEqual(Object.keys(fx.errors).sort(), [...ERROR_CODES].sort());
    for (const [code, f] of Object.entries(fx.errors)) {
      assert.deepEqual(validateErrorObject(f.error), { ok: true }, `errors/${code}`);
      assert.equal(f.error.data?.error, code, `errors/${code} carries its own code`);
    }
    for (const name of NOTIFICATIONS) {
      assert.ok(fx.notifications[name], `notification fixture missing for ${name}`);
      assert.deepEqual(validateNotification(name, fx.notifications[name]), { ok: true }, name);
    }
  });

  it("supervisor.auth capabilities list config.* and config.changed; core.auth lists neither", () => {
    const supervisor = buildCapabilities(["adoption", "lifelines"], "supervisor");
    const core = buildCapabilities([], "core");
    for (const m of ["config.get", "config.set", "config.watch"]) {
      assert.equal(supervisor.methods[m]?.stability, "experimental", m);
      assert.equal(supervisor.methods[m]?.since, "1.3.0", m);
      assert.equal(core.methods[m], undefined, m);
    }
    assert.deepEqual(supervisor.notifications["config.changed"], { stability: "experimental", since: "1.3.0" });
    assert.equal(core.notifications["config.changed"], undefined);
    assert.deepEqual(validateResult("supervisor.auth", { rpc: RPC_VERSION, instanceId: "s", pid: 1, capabilities: supervisor }), { ok: true });
  });

  it("supervisor.auth lists module.watch and module.state; ChildStatus carries its kind", () => {
    const supervisor = buildCapabilities(["adoption", "lifelines"], "supervisor");
    assert.deepEqual(supervisor.methods["module.watch"], { stability: "experimental", since: "1.3.0" });
    assert.deepEqual(supervisor.notifications["module.state"], { stability: "experimental", since: "1.3.0" });
    for (const server of ["core", "module"] as const) {
      const other = buildCapabilities([], server);
      assert.equal(other.methods["module.watch"], undefined, server);
      assert.equal(other.notifications["module.state"], undefined, server);
    }
    assert.equal(validateParams("module.watch", { names: ["fixture"] }).ok, false);
    const child = { role: "fixture", process: { state: "ready" }, pid: 1, instanceId: "i", adopted: false, restarts: 0, lastExit: null, nextRestartAt: null };
    const status = (c: object) => ({ supervisor: { process: { state: "ready" }, instanceId: "s", pid: 2, uptimeMs: 1 }, children: [c] });
    assert.deepEqual(validateResult("daemon.status", status(child)), { ok: true });
    assert.deepEqual(validateResult("daemon.status", status({ ...child, kind: "module" })), { ok: true });
    assert.equal(validateResult("daemon.status", status({ ...child, kind: "agent" })).ok, false);
  });

  it("module.list|start|stop|restart|graph|install|uninstall are supervisor methods with closed params (B13, B14)", () => {
    const supervisor = buildCapabilities([], "supervisor");
    const verbs = ["list", "start", "stop", "restart", "graph", "install", "uninstall"];
    for (const v of verbs) {
      assert.deepEqual(supervisor.methods[`module.${v}`], { stability: "experimental", since: "1.3.0" }, v);
      assert.equal(buildCapabilities([], "module").methods[`module.${v}`], undefined, v);
    }
    assert.equal(validateParams("module.list", { all: true }).ok, false);
    assert.equal(validateParams("module.start", {}).ok, false);
    assert.equal(validateParams("module.stop", { name: "fixture", force: true }).ok, false);
    assert.equal(validateParams("module.restart", { name: "fixture", budgetMs: 120001 }).ok, false);
    assert.equal(validateParams("module.install", { path: "" }).ok, false);
    assert.equal(validateParams("module.uninstall", { name: "fixture", yes: true }).ok, false);
    const entry = (fx.methods["module.list"]!.result as { modules: Record<string, unknown>[] }).modules[1];
    assert.equal(validateResult("module.list", { modules: [{ ...entry, extra: 1 }] }).ok, false);
    assert.deepEqual(validateResult("module.list", { modules: [{ ...entry, child: null, detail: null }] }), { ok: true });
    assert.equal(validateResult("module.graph", { nodes: [], edges: [{ from: "a", to: "b", kind: "provides" }], cycles: [], unresolved: [] }).ok, false);
    assert.equal(validateResult("module.uninstall", { name: "fixture", removed: false }).ok, false);
  });

  it("admin.* are core methods with closed params (B15)", () => {
    const core = buildCapabilities([], "core");
    const admin = ["admin.obsidian.detect", "admin.obsidian.prepare", "admin.obsidian.confirm", "admin.migrate", "admin.embedding.probe", "admin.embedding.serve"];
    for (const m of admin) {
      assert.deepEqual(core.methods[m], { stability: "experimental", since: "1.3.0" }, m);
      assert.equal(buildCapabilities([], "supervisor").methods[m], undefined, m);
    }
    const caller = { channel: "cli", accountId: "a", userId: "u" };
    assert.equal(validateParams("admin.obsidian.detect", { caller, agentId: "bernd", candidates: Array(21).fill("/v") }).ok, false);
    assert.deepEqual(validateParams("admin.obsidian.detect", { caller, agentId: "bernd", candidates: Array(20).fill("/v") }), { ok: true });
    assert.equal(validateParams("admin.obsidian.prepare", { caller, agentId: "bernd" }).ok, false);
    assert.equal(validateParams("admin.obsidian.confirm", { caller, agentId: "bernd", nonce: "n", force: true }).ok, false);
    assert.equal(validateParams("admin.migrate", { from: 0, to: "1" }).ok, false);
    assert.equal(validateParams("admin.migrate", { from: "-1", to: "1" }).ok, false);
    assert.equal(validateParams("admin.embedding.probe", { refresh: "yes" }).ok, false);
    assert.deepEqual(validateParams("admin.embedding.serve", {}), { ok: true });
    assert.deepEqual(validateParams("admin.embedding.serve", { address: null }), { ok: true });
    assert.equal(validateParams("admin.embedding.serve", { address: { kind: "tcp", address: "x" } }).ok, false);
    assert.deepEqual(validateResult("admin.embedding.serve", { address: null, tokenPath: null, identity: null }), { ok: true });
    assert.equal(validateResult("admin.obsidian.confirm", { confirmed: false, vaultPath: "/v", vaultDigest: "d", alreadyConfirmed: false }).ok, false);
  });

  it("module.auth capabilities list only module-served methods", () => {
    const module = buildCapabilities(["adoption", "lifelines"], "module");
    assert.deepEqual(Object.keys(module.methods).sort(), ["module.adopt", "module.auth", "module.shutdown", "module.status"]);
    assert.deepEqual(module.notifications, {});
    for (const [m, e] of Object.entries(module.methods)) assert.deepEqual(e, { stability: "experimental", since: "1.3.0" }, m);
    for (const server of ["core", "supervisor"] as const) {
      const other = buildCapabilities([], server);
      for (const m of Object.keys(module.methods)) assert.equal(other.methods[m], undefined, `${server} does not list ${m}`);
    }
    assert.deepEqual(validateResult("module.auth", { rpc: RPC_VERSION, instanceId: "m", pid: 3, module: { name: "fixture", version: "0.1.0", apiVersion: "1" }, capabilities: module }), { ok: true });
    assert.equal(validateParams("module.shutdown", { budgetMs: 120001 }).ok, false);
    assert.equal(validateParams("module.status", { verbose: true }).ok, false);
  });

  it("config.set refuses an empty or oversized change list and an unknown change field", () => {
    const change = { key: "core.logLevel", value: "debug" };
    assert.deepEqual(validateParams("config.set", { changes: [change] }), { ok: true });
    assert.equal(validateParams("config.set", { changes: [] }).ok, false);
    assert.equal(validateParams("config.set", { changes: Array.from({ length: 65 }, () => change) }).ok, false);
    assert.equal(validateParams("config.set", { changes: [{ ...change, op: "set" }] }).ok, false);
    assert.equal(validateParams("config.set", { changes: [{ key: "core.logLevel" }] }).ok, false);
  });

  it("config.get takes a key or a tier, never both", () => {
    assert.deepEqual(validateParams("config.get", { key: "core.logLevel" }), { ok: true });
    assert.deepEqual(validateParams("config.get", { tier: "basic" }), { ok: true });
    assert.equal(validateParams("config.get", { key: "core.logLevel", tier: "basic" }).ok, false);
  });

  it("precompileMethods compiles known methods' validators and refuses an unknown method", () => {
    precompileMethods(["memory.recall", "memory.capture"]);
    assert.equal(validateParams("memory.recall", {}).ok, false, "the precompiled validator still validates");
    assert.throws(() => precompileMethods(["memory.nope"]), /unknown method memory\.nope/);
  });

  it("rejects a recall without a query and a caller without a channel", () => {
    const r = validateParams("memory.recall", { caller: { channel: "cli", accountId: "h", userId: "u" }, agentId: "a" });
    assert.equal(r.ok, false);
    const c = validateParams("memory.recall", { caller: { accountId: "h", userId: "u" }, agentId: "a", query: "x" });
    assert.equal(c.ok, false);
  });

  it("rejects an origin supplied by a client", () => {
    const r = validateParams("memory.capture", { ...(fx.methods["memory.capture"]!.params as object), origin: "cron" });
    assert.equal(r.ok, false, "additionalProperties must be false on params");
  });

  describe("memory ops", () => {
    const caller = { channel: "cli", accountId: "macbooker", userId: "cyberblade" };
    const base = { caller, agentId: "bernd" };

    it("memory.list rejects an unknown param", () => {
      assert.deepEqual(validateParams("memory.list", { ...base, since: 0 }), { ok: true });
      assert.equal(validateParams("memory.list", { ...base, since: 0, scope: "user" }).ok, false);
    });

    it("memory.correct rejects text over 8000", () => {
      assert.deepEqual(validateParams("memory.correct", { ...base, id: "m-1", text: "x".repeat(8000) }), { ok: true });
      assert.equal(validateParams("memory.correct", { ...base, id: "m-1", text: "x".repeat(8001) }).ok, false);
    });

    it("memory.share rejects target \"public\"", () => {
      assert.deepEqual(validateParams("memory.share", { ...base, id: "m-1", target: "workspace" }), { ok: true });
      assert.equal(validateParams("memory.share", { ...base, id: "m-1", target: "public" }).ok, false);
    });

    it("memory.propose rejects a note over 500", () => {
      assert.deepEqual(validateParams("memory.propose", { ...base, sharedId: "m-copy", text: "fixed", note: "n".repeat(500) }), { ok: true });
      assert.equal(validateParams("memory.propose", { ...base, sharedId: "m-copy", text: "fixed", note: "n".repeat(501) }).ok, false);
    });

    it("every memory op requires caller and agentId", () => {
      for (const m of ["memory.list", "memory.show", "memory.forget", "memory.correct", "memory.share", "memory.state", "memory.propose", "memory.proposals.list", "memory.proposals.accept", "memory.proposals.reject"]) {
        assert.ok(METHODS.includes(m), `${m} is a method`);
        const params = fx.methods[m]!.params as Record<string, unknown>;
        const { caller: _c, ...noCaller } = params;
        const { agentId: _a, ...noAgent } = params;
        assert.equal(validateParams(m, noCaller).ok, false, `${m} without caller`);
        assert.equal(validateParams(m, noAgent).ok, false, `${m} without agentId`);
      }
    });
  });

  it("an error object with ids validates and one with a numeric id value does not", () => {
    const ok = { code: -32000, message: "storage", data: { error: "E_STORAGE", reason: "storage", ids: { sourceId: "m-src", sharedId: "m-copy" } } };
    assert.deepEqual(validateErrorObject(ok), { ok: true });
    assert.equal(validateErrorObject({ ...ok, data: { ...ok.data, ids: { sourceId: 7 } } }).ok, false);
  });

  it("no method result declares a top-level schema property", () => {
    // The CLI's `--json` document builder (ADR-016 §8) owns the top-level `schema` key; an RPC
    // result that already had one would collide when the CLI inserts it (see plur1bus/src/output.rs).
    const methods = (SCHEMA as any).$defs.methods as Record<string, { result?: { properties?: Record<string, unknown> } }>;
    for (const [name, def] of Object.entries(methods)) {
      const props = def.result?.properties ?? {};
      assert.ok(!("schema" in props), `${name}'s result must not declare a top-level "schema" property`);
    }
  });
});
