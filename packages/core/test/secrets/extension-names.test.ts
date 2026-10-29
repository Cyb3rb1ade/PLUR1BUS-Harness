/** M-A7: canonical extension slots fit the store and RPC without widening unrelated secret names. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { validateParams, validateResult } from "@plur1bus/rpc-schema";
import { createMemoryBackend } from "../../src/secrets/memory-backend.ts";
import { createMemoryAuditSink } from "../../src/secrets/audit.ts";
import { createSecretStore } from "../../src/secrets/store.ts";
import { isSecretName } from "../../src/secrets/types.ts";

it("maximal canonical extension slot names round-trip as metadata and retain distinct values", async () => {
  const name = `ext:${"a".repeat(64)}:${"b".repeat(64)}`;
  const other = `${name.slice(0, -1)}c`;
  assert.equal(name.length, 133);
  assert.equal(isSecretName(name), true);
  assert.equal(validateParams("secret.set", { name, value: "synthetic-extension-value" }).ok, true);
  const store = createSecretStore({
    keyring: createMemoryBackend(), file: createMemoryBackend({ available: false }),
    fileFallback: () => false, audit: createMemoryAuditSink(),
  });
  const meta = await store.set({ kind: "owner" }, name, "synthetic-extension-value");
  await store.set({ kind: "owner" }, other, "synthetic-other-value");
  assert.equal(meta.name, name);
  assert.equal(validateResult("secret.set", meta).ok, true);
  const lease = await store.lease({ kind: "core" }, name, { purpose: "mcp-env", profileId: "extension" });
  assert.equal(lease.value, "synthetic-extension-value");
  assert.equal(store.revokeLease({ kind: "core" }, lease.leaseId), true);
  assert.deepEqual((await store.status({ kind: "core" })).secrets?.map(secret => secret.name), [name, other]);
});

it("canonical exceptions do not admit arbitrary long names or malformed extension namespaces", () => {
  for (const name of ["a".repeat(129), `ext:${"a".repeat(65)}:${"b".repeat(64)}`,
    `ext:${"a".repeat(64)}:${"b".repeat(65)}`, `ext:${"a".repeat(64)}:../${"b".repeat(61)}`]) {
    assert.equal(isSecretName(name), false);
    assert.equal(validateParams("secret.set", { name, value: "synthetic-value" }).ok, false);
  }
  assert.equal(isSecretName("a".repeat(128)), true);
});

it("extension setup accepts only declared-field requests and never a value in its result", () => {
  assert.equal(validateParams("admin.extensions.setup.get", { name: "weather" }).ok, true);
  assert.equal(validateParams("admin.extensions.setup.get", { name: "weather", slot: "token" }).ok, false);
  assert.equal(validateParams("admin.extensions.setup.set", {
    name: "weather", slot: "token", value: "synthetic-value",
  }).ok, true);
  assert.equal(validateParams("admin.extensions.setup.set", {
    name: "weather", slot: "token", value: "synthetic-value", secret: "foreign:token",
  }).ok, false);
  const result = { name: "weather", slot: "token", stored: true };
  assert.equal(validateResult("admin.extensions.setup.set", result).ok, true);
  assert.equal(validateResult("admin.extensions.setup.set", { ...result, value: "synthetic-value" }).ok, false);
  const setup = { name: "weather", available: true, slots: [{
    slot: "token", secret: "ext:weather:token", required: true, present: false,
  }] };
  assert.equal(validateResult("admin.extensions.setup.get", setup).ok, true);
  assert.equal(validateResult("admin.extensions.setup.get", {
    ...setup, slots: [{ ...setup.slots[0], value: "synthetic-value" }],
  }).ok, false);
});

it("runtime transaction holds are closed metadata-only requests", () => {
  for (const method of ["hold", "release"] as const) {
    const rpc = `admin.extensions.runtime.${method}`;
    assert.equal(validateParams(rpc, { name: "weather" }).ok, true);
    assert.equal(validateParams(rpc, { name: "weather", principal: "owner" }).ok, false);
    const result = { name: "weather", [method === "hold" ? "held" : "released"]: true };
    assert.equal(validateResult(rpc, result).ok, true);
    assert.equal(validateResult(rpc, { ...result, token: "synthetic-value" }).ok, false);
  }
});
