import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ERROR_CODES, METHODS, NOTIFICATIONS, RPC_VERSION, loadFixtures, validateErrorObject, validateNotification, validateParams, validateResult } from "../src/index.ts";

describe("rpc-schema", () => {
  const fx = loadFixtures();

  it("declares rpc 1.1.0 and the closed error enum", () => {
    assert.equal(RPC_VERSION, "1.1.0");
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
});
