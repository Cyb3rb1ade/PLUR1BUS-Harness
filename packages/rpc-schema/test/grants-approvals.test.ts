// D109 (spec 2026-09-28 §4): the grant and approval methods. Shape guarantees that keep a client or an agent from
// influencing what only the core may decide (surface level, nonce) and keep the error enum closed (ADR-016).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ERROR_CODES, METHODS, NOTIFICATIONS, SCHEMA, validateParams, validateResult } from "../src/index.ts";

const defs = (SCHEMA as any).$defs;
const methods = defs.methods as Record<string, any>;
const notifications = defs.notifications as Record<string, any>;

const METHOD_NAMES = ["grant.list", "grant.create", "grant.revoke", "approval.list", "approval.get", "approval.decide", "approval.cancel", "approval.verify"];
const NOTIFICATION_NAMES = ["approval.requested", "approval.resolved", "grant.changed"];
const APR = "apr_0123456789abcdef01234567";

describe("grant.* and approval.* (D109)", () => {
  it("are core, experimental, since 1.5.0 and have closed params", () => {
    for (const name of METHOD_NAMES) {
      const def = methods[name];
      assert.ok(def, `${name} exists`);
      assert.equal(def["x-server"], "core", name);
      assert.equal(def["x-stability"], "experimental", name);
      assert.equal(def["x-since"], "1.5.0", name);
      assert.equal(def.params.additionalProperties, false, `${name} params closed`);
    }
    for (const name of NOTIFICATION_NAMES) {
      assert.equal(notifications[name]["x-server"], "core", name);
      assert.equal(notifications[name]["x-stability"], "experimental", name);
      assert.equal(notifications[name].additionalProperties, false, name);
    }
  });

  it("are exactly these methods and notifications; the pending queue is approval.list status=pending", () => {
    assert.deepEqual(METHODS.filter((m) => /^(grant|approval)\./.test(m)).sort(), [...METHOD_NAMES].sort());
    assert.deepEqual(NOTIFICATIONS.filter((m) => /^(grant|approval)\./.test(m)).sort(), [...NOTIFICATION_NAMES].sort());
    assert.equal(METHODS.includes("approval.pending"), false);
    assert.deepEqual(validateParams("approval.list", { status: "pending" }), { ok: true });
  });

  it("take no surface, principal or person from the client: the core derives them", () => {
    for (const name of ["grant.create", "approval.decide", "approval.cancel", "grant.revoke"]) {
      for (const key of ["surface", "surfaceLevel", "trust", "principal", "person", "caller", "createdBy"]) {
        assert.equal(Object.hasOwn(methods[name].params.properties, key), false, `${name} must not accept ${key}`);
      }
    }
    assert.equal(validateParams("approval.decide", { id: APR, decision: "approve", surface: 3 }).ok, false);
    assert.equal(validateParams("grant.create", { capability: "fs.write", agent: "bernd", scope: "always", surface: 3 }).ok, false);
  });

  it("grant.create cannot create a once grant (only approval.decide does)", () => {
    assert.equal(validateParams("grant.create", { capability: "fs.write", agent: "bernd", scope: "once" }).ok, false);
    assert.deepEqual(validateParams("grant.create", { capability: "fs.write", agent: "bernd", scope: "task" }), { ok: true });
  });

  it("records never carry the nonce, and approval.decide accepts it as input only", () => {
    assert.equal(Object.hasOwn(defs.ApprovalRecord.properties, "nonce"), false);
    assert.equal(Object.hasOwn(methods["approval.decide"].params.properties, "nonce"), true);
    assert.equal(defs.ApprovalRecord.additionalProperties, false);
    assert.equal(defs.GrantRecord.additionalProperties, false);
  });

  it("approval.decide takes an approve/deny decision and nothing else", () => {
    assert.equal(validateParams("approval.decide", { id: APR, decision: "maybe" }).ok, false);
    assert.equal(validateParams("approval.decide", { id: APR }).ok, false);
    assert.equal(validateParams("approval.decide", { id: "../x", decision: "deny" }).ok, false);
  });

  it("approval.verify reports a broken chain as a finding, not an error", () => {
    const h = "b".repeat(64);
    assert.deepEqual(validateResult("approval.verify", { ok: true, entries: 0, head: null }), { ok: true });
    assert.deepEqual(validateResult("approval.verify", { ok: false, entries: 3, head: { seq: 3, mac: h }, brokenAt: 2, reason: "prev-mismatch" }), { ok: true });
    assert.equal(validateResult("approval.verify", { ok: false, entries: 3, head: null, brokenAt: 2, reason: "because" }).ok, false);
  });

  it("the closed error enum includes media and project WIP codes (reasons are additive text, ADR-016)", () => {
    assert.deepEqual([...ERROR_CODES], [
      "E_UNAUTHORIZED", "E_RPC_VERSION", "E_NOT_AVAILABLE", "E_CORE_UNAVAILABLE", "E_INVALID_PARAMS", "E_AGENT_UNKNOWN", "E_CONFIG_INVALID",
      "E_MODULE_UNKNOWN", "E_INTERNAL", "E_LOCKED", "E_NOT_FOUND", "E_DENIED", "E_APPROVAL_REQUIRED", "E_CONFLICT", "E_STORAGE",
      "E_MEDIA_CAPABILITY", "E_MEDIA_LICENSE", "E_MEDIA_PRIVACY", "E_MEDIA_UNAVAILABLE", "E_MEDIA_DIMENSION", "E_MEDIA_UNSUPPORTED_KIND", "E_PROJECT_WIP_LIMIT",
    ]);
    const text = [methods["approval.decide"].description, methods["grant.create"].description].join(" ");
    for (const reason of ["policy-never", "surface-untrusted", "approval-expired", "approval-mismatch", "approval-used"]) assert.ok(text.includes(reason), reason);
  });
});
