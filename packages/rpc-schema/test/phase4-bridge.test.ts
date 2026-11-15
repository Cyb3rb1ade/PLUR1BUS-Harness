/** Phase 4, P4-10: the bridge server role and the front door's link credential (schema first, plan §2.4 and §4.5). */
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { METHODS_BY_SERVER, SCHEMA, buildCapabilities, validateParams, validateResult } from "../src/index.ts";

const schema = SCHEMA as { $defs: Record<string, any> };
const hex64 = () => randomBytes(32).toString("hex");

describe("Phase 4 bridge (P4-10)", () => {
  it("bridge.hello is experimental, since 1.25.0, served by the bridge and deprecated from the start", () => {
    const def = schema.$defs.methods["bridge.hello"];
    assert.equal(def["x-server"], "bridge");
    assert.equal(def["x-stability"], "experimental");
    assert.equal(def["x-since"], "1.25.0");
    assert.equal(def["x-deprecated"].since, "1.25.0");
    assert.match(def["x-deprecated"].removeAfter, /0\.1 cut/);
    assert.equal(def.params.additionalProperties, false);
    assert.deepEqual(METHODS_BY_SERVER.bridge, ["bridge.hello", "legacy.account.changed"]);
  });

  it("the bridge is methods only and never shows in another server's capabilities", () => {
    for (const def of Object.values(schema.$defs.notifications)) assert.notEqual((def as any)["x-server"], "bridge");
    for (const role of ["core", "supervisor", "module", "engine", "tools"] as const) {
      for (const method of METHODS_BY_SERVER.bridge) assert.equal(buildCapabilities([], role).methods[method], undefined, `${role} ${method}`);
    }
    assert.deepEqual(Object.keys(buildCapabilities([], "bridge").methods), ["bridge.hello", "legacy.account.changed"]);
    for (const method of METHODS_BY_SERVER.bridge) assert.ok(buildCapabilities([], "bridge").methods[method]!.deprecated, method);
  });

  it("bridge.hello takes no params and returns the front door's identity", () => {
    assert.deepEqual(validateParams("bridge.hello", {}), { ok: true });
    assert.equal(validateParams("bridge.hello", { token: hex64() }).ok, false);
    assert.deepEqual(validateResult("bridge.hello", { rpc: "1.25.0", instanceId: "i", pid: 1 }), { ok: true });
    assert.equal(validateResult("bridge.hello", { rpc: "1.25.0", instanceId: "i" }).ok, false);
  });

  it("core.auth accepts an optional, closed frontDoor link and nothing else new", () => {
    const token = hex64();
    assert.deepEqual(validateParams("core.auth", { token }), { ok: true });
    for (const caller of ["owner", "api", "engine", "client", "front-door"]) {
      assert.deepEqual(validateParams("core.auth", { token, frontDoor: { token: hex64(), caller } }), { ok: true }, caller);
    }
    for (const frontDoor of [{ token: hex64() }, { caller: "owner" }, { token: hex64(), caller: "legacy-core" },
      { token: hex64().toUpperCase(), caller: "owner" }, { token: "x".repeat(64), caller: "owner" },
      { token: hex64(), caller: "owner", principal: { userId: "a" } }]) {
      assert.equal(validateParams("core.auth", { token, frontDoor }).ok, false, JSON.stringify(frontDoor));
    }
    assert.equal(schema.$defs.FrontDoorLink.additionalProperties, false);
    assert.equal(schema.$defs.methods["core.auth"]["x-stability"], "stable", "an optional param is additive (ADR-016 §2)");
    assert.ok(!schema.$defs.methods["core.auth"].params.required.includes("frontDoor"));
  });

  it("every bridge method is bridge.* (served by the front door) or legacy.* (served by the legacy core), experimental and deprecated from the start", () => {
    for (const method of METHODS_BY_SERVER.bridge) {
      const def = schema.$defs.methods[method];
      assert.match(method, /^(bridge|legacy)\./, method);
      assert.equal(def["x-stability"], "experimental", method);
      assert.match(def["x-deprecated"].removeAfter, /0\.1 cut/, method);
      assert.equal(def.params.additionalProperties, false, method);
      assert.equal(def.result.additionalProperties, false, method);
    }
  });

  it("legacy.account.changed (flip A2) names the person and both follow-ups, and returns nothing", () => {
    const def = schema.$defs.methods["legacy.account.changed"];
    assert.equal(def["x-since"], "1.27.0");
    assert.deepEqual(def.params.required, ["userId", "rights", "learning"]);
    assert.deepEqual(validateParams("legacy.account.changed", { userId: "u", rights: true, learning: false }), { ok: true });
    for (const params of [{}, { userId: "u" }, { userId: "u", rights: true }, { userId: "", rights: true, learning: true },
      { userId: "u".repeat(257), rights: true, learning: true }, { userId: "u", rights: 1, learning: true },
      { userId: "u", rights: true, learning: true, role: "owner" }]) {
      assert.equal(validateParams("legacy.account.changed", params).ok, false, JSON.stringify(params));
    }
    assert.deepEqual(validateResult("legacy.account.changed", {}), { ok: true });
    assert.equal(validateResult("legacy.account.changed", { ok: true }).ok, false);
  });
});
