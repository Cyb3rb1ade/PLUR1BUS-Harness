// Shared, hand-authored projection contract; credentials are materialized only while each test runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import vectors from "./fixtures/disclosure-projection.json" with { type: "json" };
import { CONFIG_SCHEMA, redactConfig, configTextSecretEntries } from "../src/index.ts";
import type { ConfigSchemaNode } from "../src/sensitive.ts";

for (const row of vectors.cases) {
  test(`B1 projection: ${row.name}`, () => {
    const canary = randomBytes(32).toString("hex");
    const expand = (value: unknown): unknown => {
      if (typeof value === "string") return value.replaceAll("$CANARY", canary);
      if (Array.isArray(value)) return value.map(expand);
      return value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, expand(child)])) : value;
    };
    const schema = (row.schema === "harness" ? CONFIG_SCHEMA : row.schema) as ConfigSchemaNode;
    const input = expand(row.value), before = JSON.stringify(input);
    assert.deepEqual(redactConfig(input, { schema }), expand(row.expectedDisplay));
    assert.equal(JSON.stringify(input), before, "projection never changes the live values");
  });
  test(`text registration: ${row.name}`, () => {
    const canary = randomBytes(32).toString("hex");
    const input = JSON.parse(JSON.stringify(row.value).replaceAll("$CANARY", canary));
    const schema = (row.schema === "harness" ? CONFIG_SCHEMA : row.schema) as ConfigSchemaNode;
    const values = new Set(configTextSecretEntries(input, schema).map(entry => entry.value));
    for (const value of row.registered) assert.ok(values.has(value.replaceAll("$CANARY", canary)), "secret part registered");
    for (const value of row.notRegistered) assert.ok(!values.has(value.replaceAll("$CANARY", canary)), "public value registered");
  });
}
