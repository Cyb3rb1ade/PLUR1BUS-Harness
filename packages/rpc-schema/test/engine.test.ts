import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { engineRpcSurface, syncEngineSchema } from "../src/engine-contract.mjs";
import { RPC_VERSION, SCHEMA, buildCapabilities, loadFixtures, validateNotification, validateParams, validateResult } from "../src/index.ts";
import engineMethodVersions from "../fixtures/engine-method-versions.json" with { type: "json" };

const schema = SCHEMA as any;
describe("RE-08 engine RPC", () => {
  it("regenerates the committed wire schema without changing bytes", () => {
    syncEngineSchema(new URL("../schema/rpc.schema.json", import.meta.url), () => {
      assert.fail("engine wire schema is stale; run pnpm gen");
    });
  });
  it("keeps the imported RE-01 wire definitions and every operation signature free of drift", () => {
    const surface = engineRpcSurface();
    const imported = Object.fromEntries(
      Object.entries(schema.$defs).filter(([name]) => name.startsWith("EngineContract") || ["EngineTransportEvent", "EngineProcessStatus"].includes(name)),
    );
    assert.deepEqual(imported, surface.definitions);

    for (const [name, value] of Object.entries(surface.methods))
      assert.deepEqual(schema.$defs.methods[name], value, name);
    assert.deepEqual(schema.$defs.notifications["engine.event"]["x-engine-notification"], surface.engineEvent);
  });
  it("adds engine methods with closed params and preserves each method's experimental version", () => {
    assert.equal(schema["x-rpc-version"], RPC_VERSION);
    for (const [name, since] of Object.entries(engineMethodVersions))
      assert.equal(schema.$defs.methods[name]["x-since"], since, name);
    for (const name of [
      "engine.auth",
      "engine.adopt",
      "engine.recall",
      "engine.capture",
      "engine.capture.wait",
      "engine.capture.abort",
      "engine.jobs.run",
      "engine.memory.curation.keep",
      "engine.admin.reembedding.validate",
      "engine.models.status",
      "engine.stores.adopt",
    ])
      assert.ok(schema.$defs.methods[name], name);
    for (const [name, value] of Object.entries(schema.$defs.methods) as [string, any][]) {
      if (!name.startsWith("engine.")) continue;
      assert.equal(value["x-server"], "engine", name);
      assert.equal(value["x-stability"], "experimental", name);
      assert.equal(value.params.additionalProperties, false, name);
      assert.equal(validateParams(name, { unexpected: true }).ok, false, name);
    }
  });
  it("validates the supervisor nonce and returns the same status contract as engine.status", () => {
    assert.equal(validateParams("engine.adopt", { nonce: "a".repeat(64) }).ok, true);
    for (const params of [{}, { nonce: 64 }, { nonce: "a".repeat(63) }, { nonce: "a".repeat(65) }, { nonce: "a".repeat(64), extra: true }])
      assert.equal(validateParams("engine.adopt", params).ok, false);
    const status = loadFixtures().methods["engine.status"]!.result;
    assert.deepEqual(validateResult("engine.adopt", { status }), { ok: true });
    assert.equal(validateResult("engine.adopt", {}).ok, false);
    assert.equal(validateResult("engine.adopt", { status, extra: true }).ok, false);
    assert.deepEqual(schema.$defs.methods["engine.adopt"].result.properties.status, schema.$defs.methods["engine.status"].result);
  });
  it("adds optional process health and counters while preserving legacy engine status", () => {
    const status = loadFixtures().methods["engine.status"]!.result as Record<string, unknown>;
    const counters = { requests: 4, authFailures: 0, activeConnections: 1, capturesPending: 0, capturesCompleted: 2 };
    const operational = {
      ...status,
      rpc: RPC_VERSION,
      instanceId: "engine-process",
      pid: 42,
      process: { state: "ready", orphanedSince: null },
      counters,
      schedulerLagMs: 0,
    };
    for (const [method, wrap] of [
      ["engine.status", (value: unknown) => value],
      ["engine.adopt", (value: unknown) => ({ status: value })],
    ] as const) {
      assert.deepEqual(validateResult(method, wrap(status)), { ok: true }, `${method}: legacy status`);
      assert.deepEqual(validateResult(method, wrap(operational)), { ok: true }, `${method}: process status`);
      for (const acceptErrors of [0, 2])
        assert.deepEqual(validateResult(method, wrap({ ...operational, counters: { ...counters, acceptErrors } })), { ok: true });
      for (const acceptErrors of [-1, 1.5, "1", null])
        assert.equal(validateResult(method, wrap({ ...operational, counters: { ...counters, acceptErrors } })).ok, false);
      for (const process of [
        { state: "orphaned", orphanedSince: 123 },
        { state: "stopping", orphanedSince: null },
      ])
        assert.deepEqual(validateResult(method, wrap({ ...operational, process })), { ok: true });
      for (const field of ["rpc", "instanceId", "pid"])
        assert.equal(validateResult(method, wrap({ ...operational, [field]: null })).ok, false, field);
      assert.equal(validateResult(method, wrap({ ...operational, pid: 1.5 })).ok, false);
      assert.equal(validateResult(method, wrap({ ...operational, schedulerLagMs: -1 })).ok, false);
      for (const process of [
        { state: "unavailable", orphanedSince: null },
        { state: "ready" },
        { orphanedSince: null },
        { state: "ready", orphanedSince: null, extra: true },
      ])
        assert.equal(validateResult(method, wrap({ ...operational, process })).ok, false);
      for (const field of Object.keys(counters)) {
        for (const value of [-1, 1.5])
          assert.equal(validateResult(method, wrap({ ...operational, counters: { ...counters, [field]: value } })).ok, false, field);
        const missing: Record<string, number> = { ...counters };
        delete missing[field];
        assert.equal(validateResult(method, wrap({ ...operational, counters: missing })).ok, false, field);
      }
      assert.equal(validateResult(method, wrap({ ...operational, counters: { ...counters, extra: 0 } })).ok, false);
    }
    const processStatus = schema.$defs.EngineProcessStatus;
    const contractStatus = schema.$defs.EngineContractEngineStatusData;
    assert.equal(processStatus["x-since"], "1.17.0");
    assert.deepEqual(processStatus.required, contractStatus.required);
    for (const [name, value] of Object.entries(contractStatus.properties) as [string, Record<string, unknown>][]) {
      const { description: _processDescription, ...processProperty } = processStatus.properties[name];
      const { description: _contractDescription, ...contractProperty } = value;
      assert.deepEqual(processProperty, contractProperty, name);
    }
    assert.equal(Object.hasOwn(contractStatus.properties, "process"), false);
  });
  it("marks each process status addition with its introduction version", () => {
    for (const path of [
      "rpc", "instanceId", "pid", "process", "process.state", "process.orphanedSince", "counters",
      "counters.requests", "counters.authFailures", "counters.activeConnections", "counters.capturesPending",
      "counters.capturesCompleted", "counters.acceptErrors", "schedulerLagMs",
    ]) {
      let definition = schema.$defs.EngineProcessStatus;
      for (const part of path.split(".")) definition = definition.properties[part];
      assert.equal(definition?.["x-since"], "1.17.0", path);
    }
  });
  it("lists engine methods and notifications only in engine capabilities", () => {
    const caps = buildCapabilities([], "engine" as any);
    assert.ok(caps.methods["engine.auth"]);
    assert.deepEqual(caps.methods["engine.adopt"], { stability: "experimental", since: "1.17.0" });
    assert.deepEqual(Object.keys(caps.notifications).sort(), ["engine.capture.done", "engine.event"]);
    assert.ok(Object.keys(caps.methods).every((n) => n.startsWith("engine.")));
    assert.equal(buildCapabilities([]).methods["engine.auth"], undefined);
    assert.equal(caps.methods["engine.capture.done"], undefined);
  });
  it("retains the existing Core migration runtime arguments without changing RE-01", () => {
    assert.equal(
      validateParams("engine.admin.reembedding.plan", {
        request: { id: "migration", target: { fingerprint: { provider: "local", model: "model", dimensions: 384 } } },
      }).ok,
      true,
    );
    assert.equal(
      validateParams("engine.admin.reembedding.apply", { request: { id: "migration", token: "confirmation" } }).ok,
      true,
    );
    assert.equal(validateParams("engine.admin.reembedding.validate", { request: { id: "migration" } }).ok, true);
    assert.equal(validateParams("engine.admin.reembedding.status", { id: "migration" }).ok, true);
    assert.equal(
      validateParams("engine.admin.reembedding.apply", {
        request: { id: "migration", token: "confirmation", extra: true },
      }).ok,
      false,
    );
  });
  it("hides host methods from ordinary capabilities but retains dispatch schemas", () => {
    for (const name of [
      "host.llm.complete",
      "host.egress.decide",
      "host.secret.get",
      "host.workspaceDir",
      "host.event",
      "host.journalBacklog",
    ]) {
      assert.ok(schema.$defs.methods[name], name);
      assert.equal(schema.$defs.methods[name]["x-server"], "core");
      assert.equal(buildCapabilities([]).methods[name], undefined);
      assert.ok(buildCapabilities(["engine"]).methods[name]);
    }
  });
  it("adds outer LLM attribution without changing RE-01 params or rejecting older envelopes", () => {
    const params = { messages: [{ role: "user", content: "summarize" }] };
    assert.equal(validateParams("host.llm.complete", { agentId: "bernd", params }).ok, true);
    assert.equal(validateParams("host.llm.complete", { params }).ok, true, "wire omission stays additive; the handler denies it");
    for (const agentId of ["", "../bernd", 3, null])
      assert.equal(validateParams("host.llm.complete", { agentId, params }).ok, false);
    assert.equal(validateParams("host.llm.complete", { params: { ...params, agentId: "bernd" } }).ok, false);
    assert.deepEqual(schema.$defs.methods["host.llm.complete"].params.required, ["params"]);
    assert.equal(Object.hasOwn(schema.$defs.EngineContractLlmParamsData.properties, "agentId"), false);
  });
  it("preserves the deprecated core engine.event schema and has a separate engine emitter schema", () => {
    const core = schema.$defs.notifications["engine.event"];
    assert.equal(core["x-server"], "core");
    assert.equal(core["x-since"], "1.0.0");
    assert.ok(core["x-deprecated"]);
    assert.equal(validateNotification("engine.event", { name: "memory.proposal", payload: {} }).ok, false);
    assert.ok(core["x-engine-notification"]);
    assert.equal(validateNotification("engine.event", { name: "memory.proposal", payload: {} }, "engine").ok, true);
  });
});
