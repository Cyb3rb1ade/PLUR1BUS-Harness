import { test } from "node:test";
import assert from "node:assert/strict";
import { validateChannelManifest } from "../../src/channels/index.ts";

const ok = { name: "loopback", version: "0.1.0", kind: "channel", apiVersion: "1" };

test("a minimal manifest validates and gets fail-closed defaults", () => {
  const r = validateChannelManifest(ok);
  assert.ok(r.ok);
  if (r.ok) {
    assert.deepEqual(r.manifest.chatKinds, ["direct"]);
    assert.equal(r.manifest.startDelayMs, 0);
    assert.equal(r.manifest.maxRestarts, 8);
  }
});

test("the input object is not mutated", () => {
  const input = { ...ok };
  validateChannelManifest(input);
  assert.deepEqual(input, ok);
});

for (const [label, patch] of [
  ["unknown property", { extra: 1 }],
  ["wrong kind", { kind: "module" }],
  ["bad name", { name: "Bad Name" }],
  ["reserved-looking name with path chars", { name: "../x" }],
  ["bad version", { version: "one" }],
  ["unsupported apiVersion", { apiVersion: "7" }],
  ["empty chatKinds", { chatKinds: [] }],
  ["unknown chat kind", { chatKinds: ["room"] }],
  ["duplicate chat kinds", { chatKinds: ["direct", "direct"] }],
  ["negative delay", { startDelayMs: -1 }],
  ["delay too large", { startDelayMs: 600_001 }],
  ["fractional restarts", { maxRestarts: 1.5 }],
] as const) {
  test(`rejects ${label}`, () => {
    const r = validateChannelManifest({ ...ok, ...patch });
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.errors.length > 0);
  });
}

test("rejects missing required fields and non-objects", () => {
  assert.equal(validateChannelManifest({ name: "x1" }).ok, false);
  for (const v of [null, 1, "s", [], undefined]) assert.equal(validateChannelManifest(v).ok, false);
});

test("pairing cannot be switched off by a manifest", () => {
  assert.equal(validateChannelManifest({ ...ok, pairing: "off" }).ok, false);
});
