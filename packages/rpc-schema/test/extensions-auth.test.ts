/** Human extension authentication uses bounded, closed requests and metadata-only results (M-A8). */
import { it } from "node:test";
import assert from "node:assert/strict";
import { buildCapabilities, validateParams, validateResult } from "../src/index.ts";

const attemptId = "00000000-0000-4000-8000-000000000001";
const target = { name: "weather", attemptId };

it("runtime reconciliation is a closed native supervisor control without caller-supplied authority", () => {
  assert.equal(validateParams("admin.extensions.runtime.reconcile", { name: "weather" }).ok, true);
  assert.equal(validateParams("admin.extensions.runtime.reconcile", { name: "weather", principal: "owner" }).ok, false);
  assert.equal(validateResult("admin.extensions.runtime.reconcile", { name: "weather", reconciled: true }).ok, true);
  assert.ok(buildCapabilities([], "supervisor").methods["admin.extensions.runtime.reconcile"]);
  assert.equal(buildCapabilities([], "core").methods["admin.extensions.runtime.reconcile"], undefined);
});

it("extension login starts with a server and accepts a complete registered-client pair", () => {
  const method = "admin.extensions.auth.start";
  assert.equal(validateParams(method, { name: "weather" }).ok, true);
  assert.equal(validateParams(method, { name: "weather", clientId: "registered-app" }).ok, false);
  assert.equal(validateParams(method, { name: "weather", redirectUri: "http://127.0.0.1:18761/callback" }).ok, false);
  assert.equal(validateParams(method, { name: "weather", clientId: "registered-app",
    redirectUri: "http://127.0.0.1:18761/callback", method: "paste_callback" }).ok, true);
  assert.equal(validateParams(method, { name: "weather", principal: "owner" }).ok, false);
  assert.equal(validateParams(method, { name: "weather", method: "silent" }).ok, false);
  assert.ok(buildCapabilities([], "core").methods[method]);
  assert.equal(buildCapabilities([], "supervisor").methods[method], undefined);
});

it("extension login status, callback and cancellation cannot supply authority or token fields", () => {
  for (const action of ["status", "cancel"] as const) {
    const method = `admin.extensions.auth.${action}`;
    assert.equal(validateParams(method, target).ok, true);
    assert.equal(validateParams(method, { ...target, token: "synthetic-value" }).ok, false);
    assert.equal(validateParams(method, { name: "weather" }).ok, false);
  }
  assert.equal(validateParams("admin.extensions.auth.submit", {
    ...target, callbackUrl: "http://127.0.0.1:18761/callback?code=synthetic&state=synthetic",
  }).ok, true);
  assert.equal(validateParams("admin.extensions.auth.submit", { ...target, callbackUrl: "x".repeat(8193) }).ok, false);
});

it("every extension login result admits only the human's interaction metadata", () => {
  const result = { ...target, status: "awaiting-device", expiresAt: 1893456000000,
    method: "device_code", device: { userCode: "SYNTHETIC", verificationUri: "https://issuer.invalid/device" } };
  for (const action of ["start", "status", "submit", "cancel"] as const) {
    const method = `admin.extensions.auth.${action}`;
    assert.equal(validateResult(method, result).ok, true);
    for (const field of ["token", "refreshToken", "verifier", "callbackCode"] as const) {
      assert.equal(validateResult(method, { ...result, [field]: "synthetic-value" }).ok, false);
    }
  }
});
