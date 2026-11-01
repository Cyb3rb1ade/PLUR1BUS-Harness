// Backup-only reference metadata preserves references without making them public or changing validation.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import schema from "../schema/config.schema.json" with { type: "json" };
import { defaults, secretReferenceOf, sensitiveOf, validate } from "../src/index.ts";
import type { ConfigSchemaNode } from "../src/index.ts";

interface Node {
  [name: string]: unknown;
  properties?: Record<string, Node>;
  "x-value-schema"?: Node;
  "x-secret-reference"?: { $ref: string };
}
const root = schema as unknown as Node;
const engine = createRequire(new URL("../../core/package.json", import.meta.url))(
  "@cyb3rb1ade/plur1bus-memory/engine/config/engine-config.schema.json",
);

function referenceValidator(path: string): (value: unknown) => boolean {
  let node = root;
  for (const key of path.split(".")) node = (node["x-value-schema"] ?? node).properties?.[key] ?? {};
  const ref = node["x-secret-reference"]?.$ref;
  assert.ok(ref, `${path} needs explicit reference metadata`);
  assert.ok(ref.startsWith("#/$defs/"));
  return (value) => secretReferenceOf(path, value);
}

test("backup reference metadata accepts only reference forms from the pinned Engine contract", () => {
  const accepts = referenceValidator("engine.embedding.apiKey");
  const engineAccepts = new Ajv2020({ strict: false }).compile(engine.$defs.secretInput);
  for (const source of ["env", "store", "file", "exec"]) {
    const reference = { source, provider: "fixture", id: source === "env" ? "FIXTURE_REFERENCE_NAME" : randomUUID() };
    assert.equal(engineAccepts(reference), true);
    assert.equal(accepts(reference), true);
  }
  for (const value of [
    randomUUID(),
    { source: "unknown", provider: "fixture", id: randomUUID() },
    { source: "store", id: randomUUID() },
    { source: "store", provider: "fixture", id: "" },
    { source: "store", provider: "fixture", id: randomUUID(), literal: randomUUID() },
    "${ARBITRARY_ENV}",
  ]) assert.equal(accepts(value), false, "a literal or malformed reference must remain redacted");
  for (const value of ["${COHERE_API_KEY}", "${OPENAI_API_KEY}", "${PLUR1BUS_OPENAI_COMPATIBLE_API_KEY}"])
    assert.equal(accepts(value), true, "the pinned resolver supports these legacy environment references");
});

test("reference-only config members retain sensitivity and do not classify a malformed non-string as a reference", () => {
  for (const path of [
    "channels.telegram.tokenSecret",
    "channels.email.imap.passwordSecret",
    "voice.providers.elevenlabs.apiKeyRef",
    "engine.embedding.apiKeyRef",
    "engine.embedding.apiKeyEnv",
  ]) {
    const accepts = referenceValidator(path);
    assert.equal(accepts(path.endsWith("apiKeyEnv") ? "FIXTURE_REFERENCE_NAME" : randomUUID()), true, path);
    assert.equal(accepts(42), false, path);
    assert.equal(accepts({ literal: randomUUID() }), false, path);
    assert.equal(sensitiveOf(path), true, "literal values in reference-capable fields must remain sensitive");
  }
  const cfg = defaults();
  cfg.engine = { implementation: "node", embedding: { apiKey: { unexpected: 42 }, apiKeyRef: false } };
  const result = validate(cfg);
  assert.ok(result.ok, "backup metadata must not tighten opaque Engine validation");
  assert.deepEqual(result.config.engine, cfg.engine);
});

test("reference classification follows explicit metadata on unrelated keys and refuses malformed metadata", () => {
  const value = randomUUID();
  const custom: ConfigSchemaNode = {
    $defs: { name: { type: "string" } },
    properties: { ordinary: { "x-sensitive": true, "x-secret-reference": { $ref: "#/$defs/name" } } },
  };
  assert.equal(secretReferenceOf("ordinary", value, custom), true);
  assert.equal(secretReferenceOf("passwordRef", value, custom), false);
  assert.equal(secretReferenceOf("ordinary", 42, custom), false);
  const marked = { properties: { ordinary: { type: "string", "x-secret-reference": true } } } as ConfigSchemaNode;
  assert.equal(secretReferenceOf("ordinary", value, marked), true, "a directly marked reference subschema is supported");
  for (const metadata of [1, { $ref: "#/$defs/missing" }, { $ref: "https://example.test/policy" }]) {
    const invalid = { properties: { ordinary: { "x-secret-reference": metadata } } } as unknown as ConfigSchemaNode;
    assert.throws(() => secretReferenceOf("ordinary", value, invalid), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes("secret-reference metadata"));
      assert.ok(!error.message.includes(value));
      return true;
    });
  }
});

test("characterization: the pinned Engine resolves its declared legacy environment forms and keeps ordinary strings inline", async () => {
  const packageRequire = createRequire(new URL("../../core/package.json", import.meta.url));
  const schemaPath = packageRequire.resolve("@cyb3rb1ade/plur1bus-memory/engine/config/engine-config.schema.json");
  const module = await import(new URL("../../lib/providers/secret-input.js", pathToFileURL(schemaPath)).href);
  const value = randomUUID();
  const names = [
    "COHERE_API_KEY", "OPENAI_API_KEY", "OPENAI_API_KEY_FALLBACK", "OPENAI_COMPATIBLE_API_KEY",
    "PLUR1BUS_COHERE_API_KEY", "PLUR1BUS_OPENAI_API_KEY", "PLUR1BUS_OPENAI_COMPATIBLE_API_KEY",
  ];
  const resolve = module.createConfiguredSecretInputResolver({ env: Object.fromEntries(names.map((name) => [name, value])) });
  for (const name of names) {
    const reference = `\${${name}}`;
    assert.equal(secretReferenceOf("engine.embedding.apiKey", reference), true);
    assert.equal(await resolve({ value: reference, path: "embedding.apiKey" }), value);
  }
  assert.equal(secretReferenceOf("engine.embedding.apiKey", value), false);
  assert.equal(await resolve({ value, path: "embedding.apiKey" }), value);
  await assert.rejects(resolve({ value: "${ARBITRARY_ENV}", path: "embedding.apiKey" }));
});
