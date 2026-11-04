// References remain metadata; a pasted credential must never acquire a reference exemption.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { configTextSecretEntries, configurationWarnings, redactConfig, secretReferenceOf } from "../src/index.ts";
import { createRedactor } from "../../core/src/logs/redact.ts";

test("safe names and supported source references remain visible in config views and log metadata", () => {
  const name = `fixture.reference.${randomUUID().slice(0, 8)}`;
  const literal = randomUUID();
  const config = { voice: { providers: { elevenlabs: { apiKeyRef: name } } }, engine: {
    embedding: { apiKey: { source: "store", provider: "fixture", id: name }, apiKeyEnv: "FIXTURE_REFERENCE_NAME" },
    merging: { headers: { ordinary: literal } },
  }, auth: { openai: { federated: { file: `/tmp/${"reference path/".repeat(10)}file` } } } };
  const projected = redactConfig(config) as typeof config;
  assert.equal(projected.voice.providers.elevenlabs.apiKeyRef, name);
  assert.deepEqual(projected.engine.embedding.apiKey, config.engine.embedding.apiKey);
  assert.equal(projected.engine.embedding.apiKeyEnv, "FIXTURE_REFERENCE_NAME");
  assert.equal(projected.auth.openai.federated.file, config.auth.openai.federated.file);
  assert.equal(projected.engine.merging.headers.ordinary, "••••");
  const values = configTextSecretEntries(config).map(entry => entry.value);
  assert.ok(!values.includes(name));
  const line = createRedactor({ secrets: values }).text(`using ${name}, diagnostic ${literal}`);
  assert.ok(line.includes(name), "a reference name in ordinary log metadata was hidden");
  assert.ok(!line.includes(literal), "a literal config value escaped text registration");
});

test("known prefixes, high entropy and large pasted reference values mask, register and warn without echoing them", () => {
  const entropy = [...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)),
    ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(97 + i)),
    ...Array.from({ length: 10 }, (_, i) => String(i))].join("");
  const values = [
    ...["sk-", "ghp_", "xoxb-"].map(prefix => prefix + randomUUID()), entropy,
    "reference".repeat(13), Array.from({ length: 4 }, () => randomUUID().replaceAll("-", "")).join(""),
  ];
  for (const value of values) {
    const config = { voice: { providers: { elevenlabs: { apiKeyRef: value } } } };
    assert.equal(secretReferenceOf("voice.providers.elevenlabs.apiKeyRef", value), false);
    assert.equal((redactConfig(config) as typeof config).voice.providers.elevenlabs.apiKeyRef, "••••");
    assert.ok(configTextSecretEntries(config).some(entry => entry.value === value));
    const warnings = configurationWarnings(config);
    assert.ok(warnings.some(warning => /looks like a pasted key/.test(warning.message)));
    assert.ok(!JSON.stringify(warnings).includes(value), "the warning echoed a pasted value");
    const file = { auth: { openai: { federated: { file: value } } } };
    assert.equal((redactConfig(file) as typeof file).auth.openai.federated.file, "••••",
      "a bare pasted token must not become public merely because a field supports file references");
    assert.ok(configTextSecretEntries(file).some(entry => entry.value === value));
  }
});

test("a marked reference-only subschema cannot launder a pasted key through a missing sensitivity flag", () => {
  const value = "sk-" + randomUUID();
  const schema = { properties: { handle: { type: "string", "x-secret-reference": true } } };
  assert.deepEqual(redactConfig({ handle: value }, { schema }), { handle: "••••" });
  assert.ok(configTextSecretEntries({ handle: value }, schema).some(entry => entry.value === value));
  assert.deepEqual(redactConfig({ handle: "openai-api-key" }, { schema }), { handle: "openai-api-key" });
});

test("reference metadata merges wrapper source kind and validation constraints", () => {
  const schema = { properties: {
    environment: { type: "string", "x-secret-reference-kind": "env-name",
      "x-value-schema": { "x-secret-reference": true } },
    constrained: { type: "string", enum: ["allowed.reference"],
      "x-value-schema": { "x-secret-reference": true } },
  } };
  const literal = `service.${randomUUID().slice(0, 8)}`;
  const value = { environment: "_FIXTURE_KEY", constrained: literal };
  assert.equal(secretReferenceOf("environment", value.environment, schema), true);
  assert.equal(secretReferenceOf("constrained", literal, schema), false);
  assert.deepEqual(redactConfig(value, { schema }), { environment: "_FIXTURE_KEY", constrained: "••••" });
  assert.deepEqual(configTextSecretEntries(value, schema).map(entry => entry.value), [literal]);
});
