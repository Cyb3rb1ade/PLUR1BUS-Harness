import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { restartPlan } from "../src/index.ts";

it("fixtures/restart-plan-cases.json equals a fresh restartPlan computation (run pnpm gen after a schema change)", () => {
  const cases = JSON.parse(readFileSync(new URL("../fixtures/restart-plan-cases.json", import.meta.url), "utf8"));
  assert.ok(cases.length >= 7, "expected at least 7 restart-plan cases");
  for (const { name, before, after, expected } of cases) {
    assert.deepEqual(restartPlan(before, after), expected, name);
  }
});
