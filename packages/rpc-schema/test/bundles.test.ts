/** Bundle approval binds disclosed child digests and a closed optional-member selection. */
import test from "node:test";
import assert from "node:assert/strict";
import { loadFixtures, validateParams, validateResult } from "../src/index.ts";

const child = { name: "fixture-member", kind: "mcp-server", version: "1.0.0", sha256: "a".repeat(64),
  optional: false, manifest: {}, trust: { tier: "unsigned" }, checks: [], capabilities: {}, scripts: [], requires: {} };

test("bundle inspection discloses child trust and exact digests without internal inspection paths", () => {
  const inspection = { ...loadFixtures().methods["ext.inspect"]!.result as object, members: [child] };
  assert.equal(validateResult("ext.inspect", inspection).ok, true);
  for (const member of [{ ...child, sha256: "bad" }, { ...child, kind: "provider" },
    { ...child, kind: "bundle" }, { ...child, inspectionId: "internal" }, { ...child, path: "/private" }]) {
    assert.equal(validateResult("ext.inspect", { ...inspection, members: [member] }).ok, false);
  }
});

test("bundle member selection is additive, bounded and cannot carry authority or duplicate names", () => {
  const params = { ...loadFixtures().methods["ext.install"]!.params as object, members: ["fixture-member"] };
  assert.equal(validateParams("ext.install", params).ok, true);
  assert.equal(validateParams("ext.install", { ...params, members: ["fixture-member", "fixture-member"] }).ok, false);
  assert.equal(validateParams("ext.install", { ...params, members: ["../outside"] }).ok, false);
  assert.equal(validateParams("ext.install", { ...params, members: [{ name: "fixture-member", trust: "first-party" }] }).ok, false);
});
