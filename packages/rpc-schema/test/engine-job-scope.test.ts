import assert from "node:assert/strict";
import { test } from "node:test";
import scopes from "../fixtures/engine-job-scope.json" with { type: "json" };
import schema from "../../../crates/plur1bus-engine/schema/engine-contract.schema.json" with { type: "json" };
import { engineJobScope } from "../src/index.ts";

test("the engine scope fixture covers the whole job catalogue", () => {
  assert.deepEqual(Object.keys(scopes).sort(), [...schema.$defs.JobName.enum].sort());
  for (const [job, scope] of Object.entries(scopes)) {
    assert.ok(scope === "agent-owner" || scope === "each-person");
    assert.equal(engineJobScope(job), scope);
  }
  assert.equal(Object.values(scopes).filter(scope => scope === "each-person").length, 10);
  assert.equal(engineJobScope("uncatalogued"), "agent-owner");
});
