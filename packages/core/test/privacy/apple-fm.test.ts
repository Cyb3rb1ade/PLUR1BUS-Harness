/** Endpoint locality never grants locality to PCC or a custom provider using Apple's spelling. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { isLocalChatModel, isLocalModel } from "../../src/privacy/local-only.ts";

test("the fixed managed-model table contains only exact apple-fm/system", () => {
  assert.equal(isLocalModel("apple-fm", "system"), true);
  for (const model of ["pcc", "System", "system ", "custom"]) assert.equal(isLocalModel("apple-fm", model), false);
  assert.equal(isLocalModel("custom", "system"), false);
});

test("a local endpoint or owner allowlist cannot classify managed PCC as local", () => {
  assert.equal(isLocalChatModel("apple-fm", "system", "http://apple-fm.invalid/v1", {}), true);
  const cfg = { privacy: { localEndpoints: ["http://apple-fm.invalid"] } };
  assert.equal(isLocalChatModel("apple-fm", "pcc", "http://127.0.0.1:1234", cfg), false);
  assert.equal(isLocalChatModel("apple-fm", "pcc", "http://apple-fm.invalid/v1", cfg), false);
  assert.equal(isLocalChatModel("custom", "system", "https://unlisted.invalid", {}), false);
  assert.equal(isLocalChatModel("custom", "synthetic", "http://127.0.0.1:1234", {}), true);
});
