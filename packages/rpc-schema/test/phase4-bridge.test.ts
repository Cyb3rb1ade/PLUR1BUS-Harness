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
    assert.deepEqual(METHODS_BY_SERVER.bridge, ["bridge.hello", "bridge.secret.preload", "bridge.secret.status", "bridge.secret.list", "bridge.secret.set", "bridge.secret.describe", "bridge.secret.meta", "bridge.secret.reveal", "bridge.secret.delete", "bridge.secret.lease", "legacy.account.changed", "legacy.redaction.changes", "legacy.secret.changed"]);
  });

  it("the bridge is methods only and never shows in another server's capabilities", () => {
    for (const def of Object.values(schema.$defs.notifications)) assert.notEqual((def as any)["x-server"], "bridge");
    for (const role of ["core", "supervisor", "module", "engine", "tools"] as const) {
      for (const method of METHODS_BY_SERVER.bridge) assert.equal(buildCapabilities([], role).methods[method], undefined, `${role} ${method}`);
    }
    assert.deepEqual(Object.keys(buildCapabilities([], "bridge").methods), ["bridge.hello", "bridge.secret.preload", "bridge.secret.status", "bridge.secret.list", "bridge.secret.set", "bridge.secret.describe", "bridge.secret.meta", "bridge.secret.reveal", "bridge.secret.delete", "bridge.secret.lease", "legacy.account.changed", "legacy.redaction.changes", "legacy.secret.changed"]);
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

  it("bridge.secret.* (P4-20 flip B1) carries the store's calls with the principal as data and the effects in every answer", () => {
    const ops = ["preload", "status", "list", "set", "describe", "meta", "reveal", "delete", "lease"];
    const effects = { startup: { state: "ready", safeToFlush: true }, revoked: { all: false, names: [] } };
    for (const op of ops) {
      const def = schema.$defs.methods[`bridge.secret.${op}`];
      assert.equal(def["x-server"], "bridge", op);
      assert.equal(def["x-stability"], "experimental", op);
      assert.match(def["x-deprecated"].removeAfter, /0\.1 cut/, op);
      assert.equal(def.params.additionalProperties, false, op);
      assert.ok(def.result.required.includes("effects"), op);
      // Every call but the preload names who asks; none takes a member the store does not know.
      if (op !== "preload") {
        assert.ok(def.params.required.includes("principal"), op);
        assert.equal(validateParams(`bridge.secret.${op}`, { name: "a", purpose: "p", profileId: "p", value: "v", description: "d" }).ok, false, op);
      }
      assert.equal(validateParams(`bridge.secret.${op}`, { principal: { kind: "core" }, service: "s", name: "a", value: "v", description: "d", purpose: "p", profileId: "p", extra: 1 }).ok, false, op);
    }
    // The principal: the three kinds of the store, an owner with or without an id and a surface, nothing else.
    for (const principal of [{ kind: "core" }, { kind: "owner" }, { kind: "owner", id: "u", surface: 0 }, { kind: "owner", surface: 3 }, { kind: "agent" }, { kind: "agent", agentId: "a" }]) {
      assert.deepEqual(validateParams("bridge.secret.status", { principal }), { ok: true }, JSON.stringify(principal));
    }
    for (const principal of [{}, { kind: "admin" }, { kind: "owner", surface: 4 }, { kind: "owner", surface: 1.5 }, { kind: "owner", role: "owner" }, "core", null]) {
      assert.equal(validateParams("bridge.secret.status", { principal }).ok, false, JSON.stringify(principal));
    }
    // The bridge does not judge a name, a value or a lifetime: the store does, and its answer is the one a caller knows.
    assert.deepEqual(validateParams("bridge.secret.set", { principal: { kind: "owner" }, name: "", value: "" }), { ok: true });
    assert.deepEqual(validateParams("bridge.secret.lease", { principal: { kind: "core" }, name: "not a name", purpose: "", profileId: "", ttlMs: -1.5 }), { ok: true });
    assert.equal(validateParams("bridge.secret.lease", { principal: { kind: "core" }, name: "a", purpose: "p" }).ok, false);
    // The effects: the start-up state and what was revoked always, the snapshot when a preload finished.
    assert.deepEqual(validateResult("bridge.secret.delete", { removed: true, effects }), { ok: true });
    assert.deepEqual(validateResult("bridge.secret.preload", { effects: { ...effects, preloaded: [] } }), { ok: true });
    assert.deepEqual(validateResult("bridge.secret.preload", { effects: { startup: { state: "unavailable", reason: "no-backend", safeToFlush: true }, revoked: { all: true, names: ["a"] } } }), { ok: true });
    for (const bad of [{ removed: false, effects }, { removed: true }, { removed: true, effects: { startup: effects.startup } }, { removed: true, effects: { ...effects, startup: { state: "gone", safeToFlush: true } } },
      { removed: true, effects: { ...effects, startup: { state: "unavailable", reason: "tired", safeToFlush: false } } }, { removed: true, effects: { ...effects, values: [] } }]) {
      assert.equal(validateResult("bridge.secret.delete", bad).ok, false, JSON.stringify(bad));
    }
    const lease = { leaseId: "lse_example-lease-id", name: "a", value: "a value in plain words", expiresAt: 1, purpose: "p", profileId: "p" };
    assert.deepEqual(validateResult("bridge.secret.lease", { lease, effects }), { ok: true });
    for (const member of Object.keys(lease)) {
      const partial: Record<string, unknown> = { ...lease }; delete partial[member];
      assert.equal(validateResult("bridge.secret.lease", { lease: partial, effects }).ok, false, member);
    }
  });

  it("legacy.secret.changed (P4-20 flip B2) names what changed, carries the value under `secret`, and returns nothing", () => {
    const def = schema.$defs.methods["legacy.secret.changed"];
    assert.equal(def["x-server"], "bridge");
    assert.equal(def.params.additionalProperties, false);
    // A set, a delete, and "fetch what the store left": all three are calls.
    assert.deepEqual(validateParams("legacy.secret.changed", { name: "api.key", secret: "a value in plain words" }), { ok: true });
    assert.deepEqual(validateParams("legacy.secret.changed", { name: "ext:mail:Token" }), { ok: true });
    assert.deepEqual(validateParams("legacy.secret.changed", {}), { ok: true });
    // A name that is none, a value under another key, an empty value.
    for (const params of [{ name: "not a name" }, { name: "api.key", value: "a value in plain words" }, { name: "api.key", secret: "" }, { name: 7 }]) {
      assert.equal(validateParams("legacy.secret.changed", params).ok, false, JSON.stringify(params));
    }
    assert.deepEqual(validateResult("legacy.secret.changed", {}), { ok: true });
    assert.equal(validateResult("legacy.secret.changed", { ok: true }).ok, false);
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
