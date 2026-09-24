import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ERROR_CODES, METHODS, NOTIFICATIONS, RPC_VERSION, loadFixtures, validateNotification, validateParams, validateResult } from "../src/index.ts";

describe("rpc-schema", () => {
  const fx = loadFixtures();

  it("declares rpc 1.0.0 and the closed error enum", () => {
    assert.equal(RPC_VERSION, "1.0.0");
    assert.deepEqual([...ERROR_CODES], [
      "E_UNAUTHORIZED", "E_RPC_VERSION", "E_NOT_AVAILABLE", "E_CORE_UNAVAILABLE", "E_INVALID_PARAMS",
      "E_AGENT_UNKNOWN", "E_CONFIG_INVALID", "E_MODULE_UNKNOWN", "E_INTERNAL", "E_LOCKED",
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
});
