import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validate } from "../src/index.ts";

it("fixtures/format-cases.json matches ajv-formats (run pnpm gen after a schema change); crates/plur1bus-config runs the same cases", () => {
  const cases = JSON.parse(readFileSync(new URL("../fixtures/format-cases.json", import.meta.url), "utf8"));
  assert.ok(cases.some((c: any) => c.valid) && cases.some((c: any) => !c.valid), "both valid and invalid cases");
  for (const { name, config, valid } of cases) assert.equal(validate(config).ok, valid, name);
  assert.ok(cases.some((c: any) => c.name === 'agents.bernd.createdAt = "yesterday"' && c.valid === false));
});
