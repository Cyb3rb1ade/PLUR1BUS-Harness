// Schema-backed display policy replaces the former Settings metadata gap.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { redact } from "../src/pages/settings/config/model.ts";

test("Settings masks a declared ordinary header even though its name is not a credential heuristic", () => {
  const secret = randomUUID();
  const value = { engine: { merging: { headers: { ordinary: secret }, model: "public-model" } } };
  assert.deepEqual(redact(value), {
    engine: { merging: { headers: { ordinary: "••••" }, model: "public-model" } },
  });
  assert.equal(value.engine.merging.headers.ordinary, secret);
});

test("Settings keeps unmarked token limits and credential-looking public labels visible", () => {
  const value = { modelProfiles: { primary: { params: { maxTokens: 4096 } } }, unknown: { password: "public-label" } };
  assert.deepEqual(redact(value), value);
});
