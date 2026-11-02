/** Optional file checkpoints need a live, audited Owner/Admin opt-in and bounded retention. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CONFIG_SCHEMA, defaults, restartClassOf, validate } from "../src/index.ts";

test("file checkpoint policy defaults off and both settings are live Owner/Admin writes", () => {
  assert.deepEqual(defaults().session.rewind.fileProjects, []);
  assert.equal(defaults().session.rewind.checkpointRetentionTurns, 50);
  const properties = CONFIG_SCHEMA.properties.session.properties.rewind.properties;
  for (const key of ["fileProjects", "checkpointRetentionTurns"]) {
    assert.equal(restartClassOf(`session.rewind.${key}`), "live");
    assert.deepEqual(properties[key]["x-write-roles"], ["owner", "admin"]);
    assert.equal(properties[key]["x-audit"], true);
  }
});

test("checkpoint policy accepts explicit projects and rejects duplicates or unbounded retention", () => {
  const config = defaults();
  config.session.rewind.fileProjects = ["project"];
  assert.equal(validate(config).ok, true);
  config.session.rewind.fileProjects = ["project", "project"];
  assert.equal(validate(config).ok, false);
  config.session.rewind.fileProjects = [];
  for (const turns of [0, 501, 1.5]) {
    config.session.rewind.checkpointRetentionTurns = turns;
    assert.equal(validate(config).ok, false);
  }
});
