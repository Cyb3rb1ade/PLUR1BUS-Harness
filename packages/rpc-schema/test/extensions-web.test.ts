import test from "node:test";
import assert from "node:assert/strict";
import { validateParams, METHODS_BY_SERVER } from "../src/index.ts";

test("web inspection uses a closed opaque upload source while local path inspection stays additive", () => {
  assert.equal(validateParams("ext.inspect", { source: { upload: "A".repeat(43) } }).ok, true);
  assert.equal(validateParams("ext.inspect", { source: { path: "/local/package.p1x" } }).ok, true);
  for (const source of [{}, { upload: "../outside" }, { upload: "A".repeat(43), path: "/private" }, { upload: "A".repeat(43), userId: "owner" }]) assert.equal(validateParams("ext.inspect", { source }).ok, false);
  assert.equal(validateParams("ext.inspection.get", { inspectionId: "inspection" }).ok, true);
  assert.equal(validateParams("ext.inspection.get", { inspectionId: "inspection", userId: "owner" }).ok, false);
  assert.equal(METHODS_BY_SERVER.supervisor.includes("ext.inspection.get"), true);
});
test("desktop extension permission is an explicit optional issuance flag, never an arbitrary scope list", () => {
  assert.equal(validateParams("device.pair", { kind: "desktop" }).ok, true);
  assert.equal(validateParams("device.pair", { kind: "desktop", extensions: true }).ok, true);
  assert.equal(validateParams("device.pair", { kind: "desktop", imports: true }).ok, true);
  assert.equal(validateParams("device.pair", { kind: "desktop", extensions: "yes" }).ok, false);
  assert.equal(validateParams("device.pair", { kind: "desktop", scopes: ["*"] }).ok, false);
});
