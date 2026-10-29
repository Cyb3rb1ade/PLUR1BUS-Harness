// Tool-use configuration remains optional for legacy agents and live-configurable in advanced settings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { defaults, validate, restartClassOf, tierOf } from "../src/index.ts";

test("agents accept tool-use modes with prefer as their sparse object default", () => {
  const config = (toolUse: unknown) => ({ ...defaults(), agents: { a: { toolUse } } });
  const result = validate(config({}));
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.config.agents.a!.toolUse, { mode: "prefer" });
  for (const mode of ["auto", "prefer", "require-first"]) assert.equal(validate(config({ mode })).ok, true, mode);
  for (const toolUse of [{ mode: "always" }, { mode: 1 }, { extra: true }, "prefer", null]) {
    assert.equal(validate(config(toolUse)).ok, false, JSON.stringify(toolUse));
  }
  const old = validate({ ...defaults(), agents: { a: {} } });
  assert.equal(old.ok, true);
  if (old.ok) assert.equal(old.config.agents.a!.toolUse, undefined);
});

test("tool-use changes are live and advanced", () => {
  for (const path of ["agents.a.toolUse", "agents.a.toolUse.mode"]) {
    assert.equal(restartClassOf(path), "live");
    assert.equal(tierOf(path), "advanced");
  }
});
