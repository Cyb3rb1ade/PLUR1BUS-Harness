/** AF2: a managed provider can only be enabled, never redirected or impersonated in configuration. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { defaults, validate } from "../src/index.ts";

test("Apple FM defaults off and exposes only its owner/admin live enabled switch", () => {
  assert.deepEqual(defaults().appleFm, { enabled: false });
  assert.equal(validate({ schemaVersion: 1, appleFm: { enabled: true } }).ok, true);
  for (const key of ["socket", "path", "program", "model", "license", "pcc"]) {
    assert.equal(validate({ schemaVersion: 1, appleFm: { enabled: true, [key]: "synthetic" } }).ok, false);
  }
});

test("the apple-fm provider id cannot be supplied by a configuration file", () => {
  const result = validate({ schemaVersion: 1, providers: { "apple-fm": { wireFormat: "chat_completions" } } });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.errors.join(" "), /reserved-provider-id/);
});

test("agent roles reject the known 4096 model directly or through a named profile", () => {
  for (const role of ["chat", "reasoning", "dream", "capture"]) {
    for (const reference of ["apple-fm/system", "short"]) {
      const result = validate({ schemaVersion: 1,
        modelProfiles: { short: { candidates: [{ model: "apple-fm/system" }] } },
        modelRoles: { [role]: reference },
      });
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.errors.join(" "), /context-too-small/);
    }
  }
  for (const role of ["decision", "summarize"]) {
    assert.equal(validate({ schemaVersion: 1, modelRoles: { [role]: "apple-fm/system" } }).ok, true);
  }
});

test("known catalog windows fence all agent assignments, including profile fallbacks", () => {
  const catalog = { models: [
    { provider: "fixture", id: "small", contextWindow: 8192 },
    { provider: "fixture", id: "large", contextWindow: 32768 },
  ] };
  for (const role of ["chat", "reasoning", "capture", "dream"]) {
    const result = validate({ schemaVersion: 1, modelRoles: { [role]: "mixed" },
      modelProfiles: { mixed: { candidates: [{ model: "fixture/large" }, { model: "fixture/small" }] } },
    }, { catalog });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.errors.join(" "), /8192.*16384/);
  }
  assert.equal(validate({ schemaVersion: 1, modelRoles: { decision: "fixture/small" } }, { catalog }).ok, true);
});

test("pcc and unknown Apple ids cannot enter roles or profiles", () => {
  for (const model of ["apple-fm/pcc", "apple-fm/unknown"]) {
    for (const config of [{ modelRoles: { decision: model } },
      { modelProfiles: { short: { candidates: [{ model }] } } }]) {
      assert.equal(validate({ schemaVersion: 1, ...config }).ok, false);
    }
  }
});

test("foreground task-class routing cannot assign a small role-only profile", () => {
  const result = validate({ schemaVersion: 1,
    modelProfiles: { short: { candidates: [{ model: "apple-fm/system" }] } },
    decision: { classProfiles: { small: "short" } },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.errors.join(" "), /context-too-small.*4096.*16384/);
});
