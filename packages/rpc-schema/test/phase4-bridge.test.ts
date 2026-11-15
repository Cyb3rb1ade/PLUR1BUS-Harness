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
    assert.deepEqual(METHODS_BY_SERVER.bridge, ["bridge.hello", "legacy.account.changed", "legacy.redaction.changes"]);
  });

  it("the bridge is methods only and never shows in another server's capabilities", () => {
    for (const def of Object.values(schema.$defs.notifications)) assert.notEqual((def as any)["x-server"], "bridge");
    for (const role of ["core", "supervisor", "module", "engine", "tools"] as const) {
      for (const method of METHODS_BY_SERVER.bridge) assert.equal(buildCapabilities([], role).methods[method], undefined, `${role} ${method}`);
    }
    assert.deepEqual(Object.keys(buildCapabilities([], "bridge").methods), ["bridge.hello", "legacy.account.changed", "legacy.redaction.changes"]);
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

  it("legacy.redaction.changes (P4-20 flip A) is a bounded long poll whose values sit under `secret`", () => {
    const def = schema.$defs.methods["legacy.redaction.changes"];
    assert.equal(def["x-since"], "1.27.0");
    assert.deepEqual(def.params.required, ["epoch", "after", "waitMs", "maxBytes"]);
    const ask = { epoch: "", after: 0, waitMs: 0, maxBytes: 1024 };
    assert.deepEqual(validateParams("legacy.redaction.changes", ask), { ok: true });
    assert.deepEqual(validateParams("legacy.redaction.changes", { epoch: "12", after: 7, waitMs: 25000, maxBytes: 2097152 }), { ok: true });
    for (const params of [{}, { ...ask, epoch: undefined }, { ...ask, epoch: 1 }, { ...ask, epoch: "e".repeat(65) }, { ...ask, after: -1 }, { ...ask, after: 1.5 },
      { ...ask, waitMs: 25001 }, { ...ask, waitMs: -1 }, { ...ask, maxBytes: 1023 }, { ...ask, maxBytes: 2097153 }, { ...ask, names: ["api"] }]) {
      assert.equal(validateParams("legacy.redaction.changes", params).ok, false, JSON.stringify(params));
    }
    const answer = { epoch: "1", next: 2, secrets: [{ secret: "a value in plain words", pinned: true }, { secret: "another one of them", pinned: false }], more: false };
    assert.deepEqual(validateResult("legacy.redaction.changes", answer), { ok: true });
    assert.deepEqual(validateResult("legacy.redaction.changes", { epoch: "1", next: 0, secrets: [], more: false }), { ok: true });
    for (const result of [{}, { ...answer, epoch: "" }, { ...answer, more: undefined }, { ...answer, secrets: [{ value: "a value in plain words", pinned: true }] },
      { ...answer, secrets: [{ secret: "", pinned: true }] }, { ...answer, secrets: [{ secret: "a value in plain words" }] },
      { ...answer, secrets: [{ secret: "a value in plain words", pinned: true, name: "api" }] }, { ...answer, names: [] }]) {
      assert.equal(validateResult("legacy.redaction.changes", result).ok, false, JSON.stringify(result));
    }
    // The key that carries a value is one a recording hides by its name (tests/core-parity, `PARITY_SECRET_KEY`).
    assert.deepEqual(Object.keys(def.result.properties.secrets.items.properties), ["secret", "pinned"]);
  });
});
