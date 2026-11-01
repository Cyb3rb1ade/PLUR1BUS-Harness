// The same value vectors drive server validators, generated browser matching and Native reference safety.
import assert from "node:assert/strict";
import { test } from "node:test";
import cases from "./fixtures/reference-values.json" with { type: "json" };
import { CONFIG_SCHEMA, configurationWarnings, secretReferenceOf, type ConfigSchemaNode } from "../src/index.ts";
import { matchesReference, type SecretReferencePolicy } from "../src/secret-reference.ts";

function render(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const item = value as Record<string, unknown>;
  if (item.kind === "alphabet") return [
    ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)),
    ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(97 + i)),
    ...Array.from({ length: 10 }, (_, i) => String(i)),
  ].join("");
  if (item.kind === "hex_alphabet")
    return Array.from({ length: 16 }, (_, i) => i < 10 ? String(i) : String.fromCharCode(87 + i))
      .join("").repeat(Number(item.count));
  if (typeof item.repeat === "string")
    return `${item.prefix ?? ""}${item.repeat.repeat(Number(item.count))}${item.suffix ?? ""}`;
  return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, render(child)]));
}

test("shared reference vectors agree between full server validation, browser subset and warning decisions", () => {
  for (const [index, vector] of cases.entries()) {
    const value = render(vector.value);
    const schema: ConfigSchemaNode = { $defs: CONFIG_SCHEMA.$defs, properties: {
      ordinary: { "x-sensitive": true, "x-secret-reference": { $ref: `#/$defs/${vector.definition}` } },
    } };
    assert.equal(secretReferenceOf("ordinary", value, schema), vector.reference, `server vector ${index}`);
    assert.equal(matchesReference(value, CONFIG_SCHEMA.$defs[vector.definition],
      CONFIG_SCHEMA["x-secret-reference-policy"] as SecretReferencePolicy), vector.reference, `browser vector ${index}`);
    const warnings = configurationWarnings({ ordinary: value }, schema);
    assert.equal(warnings.length > 0, vector.warning,
      `warning vector ${index}`);
  }
});

test("browser reference matching tolerates nonvalidating policy annotations", () => {
  const referenceSchema = { ...CONFIG_SCHEMA.$defs.backupSecretName,
    "x-write-roles": ["owner"], "x-audit": true };
  assert.equal(matchesReference("openai-api-key", referenceSchema,
    CONFIG_SCHEMA["x-secret-reference-policy"] as SecretReferencePolicy), true);
  assert.equal(matchesReference("openai-api-key", { ...referenceSchema, not: {} },
    CONFIG_SCHEMA["x-secret-reference-policy"] as SecretReferencePolicy), false);
});
