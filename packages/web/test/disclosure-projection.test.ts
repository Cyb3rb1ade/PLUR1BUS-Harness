// Browser projections execute the same hand-authored disclosure contract as TS and Rust with runtime credentials.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import vectors from "../../config-schema/test/fixtures/disclosure-projection.json" with { type: "json" };
import type { ConfigSchemaNode } from "@plur1bus/config-schema/policy";
import { redactConfigView } from "../src/config-policy.ts";
import { redact } from "../src/pages/settings/config/model.ts";

for (const row of vectors.cases) {
  test(`browser projection: ${row.name}`, () => {
    const canary = randomBytes(32).toString("hex");
    const expand = (value: unknown): unknown => {
      if (typeof value === "string") return value.replaceAll("$CANARY", canary);
      if (Array.isArray(value)) return value.map(expand);
      return value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, expand(child)])) : value;
    };
    const input = expand(row.value);
    const before = JSON.stringify(input);
    const schema = (row.schema === "harness" ? undefined : row.schema) as ConfigSchemaNode | undefined;
    for (const project of [redactConfigView, redact]) {
      assert.deepEqual(project(input, [], schema), expand(row.expectedDisplay));
      assert.equal(JSON.stringify(input), before, "browser projection never changes live values");
    }
  });
}
