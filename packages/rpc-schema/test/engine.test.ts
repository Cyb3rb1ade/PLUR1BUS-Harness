import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { engineRpcSurface, syncEngineSchema } from "../src/engine-contract.mjs";
import { SCHEMA, buildCapabilities, validateNotification, validateParams } from "../src/index.ts";

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
      Object.entries(schema.$defs).filter(([name]) => name.startsWith("EngineContract") || name === "EngineTransportEvent"),
    );
    assert.deepEqual(imported, surface.definitions);

    for (const [name, value] of Object.entries(surface.methods))
      assert.deepEqual(schema.$defs.methods[name], value, name);
    assert.deepEqual(schema.$defs.notifications["engine.event"]["x-engine-notification"], surface.engineEvent);
  });
  it("adds engine methods with closed params and 1.7.0 experimental annotations", () => {
    assert.equal(schema["x-rpc-version"], "1.12.0");
    for (const name of [
      "engine.auth",
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
      assert.equal(value["x-since"], "1.7.0", name);
      assert.equal(value.params.additionalProperties, false, name);
      assert.equal(validateParams(name, { unexpected: true }).ok, false, name);
    }
  });
  it("lists engine methods and notifications only in engine capabilities", () => {
    const caps = buildCapabilities([], "engine" as any);
    assert.ok(caps.methods["engine.auth"]);
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
