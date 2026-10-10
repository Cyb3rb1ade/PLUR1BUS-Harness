import { it } from "node:test";
import assert from "node:assert/strict";
import { SCHEMA } from "../src/index.ts";
it("D112 new flag is optional and boolean on a closed ModelEntry", () => {
  const entry = (SCHEMA as any).$defs.ModelEntry;
  assert.equal(entry.additionalProperties, false);
  assert.equal(entry.properties.new.type, "boolean");
  assert(!entry.required.includes("new"));
});
