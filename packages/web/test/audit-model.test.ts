import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHealth, parseVerification } from "../src/pages/logs/audit/model.ts";
import { auditFixture } from "./audit-fixtures.ts";

test("health keeps only published metadata, including null and Unicode actors", () => {
  const fx = auditFixture();
  const status = { audit: { ...fx.health, lastVerifiedAt: 0, pending: [{ at: null, actor: { user: "ü".repeat(128), host: "local", secret: "NOT_METADATA" }, action: "config.set", reason: null, detail: { secret: "NOT_METADATA" }, target: "NOT_METADATA" }] } };
  const health = parseHealth(status)!;
  assert.equal(health.lastVerifiedAt, 0);
  assert.deepEqual(health.pending[0], { at: null, actor: { user: "ü".repeat(128), host: "local" }, action: "config.set", reason: null });
  assert.ok(!JSON.stringify(health).includes("NOT_METADATA"));
});
test("missing, non-finite, fractional, negative and oversized metadata never produces a healthy view", () => {
  const { health } = auditFixture();
  for (const value of [null, [], {}, { audit: null }, { audit: { ...health, pendingLines: -1 } }, { audit: { ...health, pendingDropped: 1.5 } }, { audit: { ...health, lastSeq: NaN } }, { audit: { ...health, observedAt: Infinity } }, { audit: { ...health, lastVerifiedAt: 8.64e15 + 1 } }, { audit: { ...health, pending: [{ at: null, actor: null, action: "x".repeat(129), reason: null }] } }]) assert.equal(parseHealth(value), null);
});
test("a broken old era retains its verified prefix; absence differs from a reported empty era list", () => {
  const { verify } = auditFixture();
  const result = parseVerification(verify);
  assert.equal(result.ok, true, "an old break does not change the current chain result");
  assert.equal(result.previousChains?.[0]?.lastSeq, 41);
  assert.equal(result.previousChains?.[0]?.firstBreak?.seq, 42);
  assert.equal(parseVerification({ ...verify, reanchors: undefined, previousChains: undefined }).previousChains, null);
  assert.deepEqual(parseVerification({ ...verify, reanchors: [], previousChains: [] }).previousChains, []);
});
test("malformed verification results fail rather than claiming a successful verification", () => {
  const { verify } = auditFixture();
  for (const result of [null, { ok: true }, { ...verify, ok: "true" }, { ...verify, lastSeq: -1 }, { ...verify, findingsTotal: NaN }, { ...verify, anchor: { status: "anything", seq: 1 } }, { ...verify, reanchors: null }, { ...verify, previousChains: [{ ...verify.previousChains[0], suffix: "../../outside" }] }]) assert.throws(() => parseVerification(result));
});
