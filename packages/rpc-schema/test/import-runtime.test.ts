/** Internal post-restart controls bind an immutable run; discovery returns safe source descriptors. */
import test from "node:test";
import assert from "node:assert/strict";
import { validateParams, validateResult, loadFixtures } from "../src/index.ts";

const id = "00000000-0000-4000-8000-000000000001";
const control = { runId: id, planId: id, planSha256: "a".repeat(64) };

test("private model completion and configuration controls admit no caller-supplied identity or arbitrary path", () => {
  for (const action of ["complete", "status", "release"]) {
    const method = `admin.import.runtime.${action}`;
    assert.equal(validateParams(method, control).ok, true);
    assert.equal(validateParams(method, { ...control, ownerId: "owner" }).ok, false);
  }
  const params = { ...control, changes: [{ key: "agents.fixture.memory.model", value: "fixture" }] };
  assert.equal(validateParams("admin.import.runtime.config.set", params).ok, true);
  assert.equal(validateParams("admin.import.runtime.config.set", { ...params, path: "/arbitrary" }).ok, false);
});

test("discovery is additive to ordinary source inspection and cannot expose source contents", () => {
  const source = { kind: "auto", family: "fixture" };
  assert.equal(validateParams("admin.import.detect", { source, discover: true }).ok, true);
  const result = { discovery: true, candidates: [{ id, source, displayName: "Fixture source" }], warnings: [] };
  assert.equal(validateResult("admin.import.detect", result).ok, true);
  assert.equal(validateResult("admin.import.detect", {
    ...result, candidates: [{ ...result.candidates[0], config: { token: "synthetic" } }],
  }).ok, false);
  assert.equal(validateResult("admin.import.detect", loadFixtures().methods["admin.import.detect"]!.result).ok, true);
});

test("bundle enable can bind an installed consent revision independently of its archive digest", () => {
  const params = { name: "fixture", expectedConsentSha256: "b".repeat(64) };
  assert.equal(validateParams("ext.enable", params).ok, true);
  assert.equal(validateParams("ext.enable", { ...params, expectedConsentSha256: "bad" }).ok, false);
});
