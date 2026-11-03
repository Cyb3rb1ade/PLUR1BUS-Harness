/** CLI-1 coding is an explicit live agent setting, never a permission grant. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { defaults, restartClassOf, validate } from "../src/index.ts";

test("coding is a boolean live agent setting with an opt-in default", () => {
  const config = defaults();
  const enabled = { ...config, agents: { worker: { coding: true } } };
  assert.equal(validate(enabled).ok, true);
  assert.equal(validate({ ...enabled, agents: { worker: { coding: "true" } } }).ok, false);
  assert.equal(restartClassOf("agents.worker.coding"), "live");
});
