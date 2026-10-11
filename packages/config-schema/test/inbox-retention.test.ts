import { test } from "node:test";
import assert from "node:assert/strict";
import { defaults, validate, restartClassOf, tierOf } from "../src/index.ts";

test("inbox retention defaults, bounds and restart metadata", () => {
  assert.deepEqual(defaults().inbox, { retention: { days: 90, maxEntries: 1000 } });
  for (const [key, min, max] of [["days", 1, 3650], ["maxEntries", 10, 100000]] as const) {
    const check = (value: unknown) => validate({ schemaVersion: 1, inbox: { retention: { [key]: value } } }).ok;
    for (const value of [min, max]) assert.equal(check(value), true, `${key}=${value}`);
    for (const value of [min - 1, max + 1, 1.5, "90", null]) assert.equal(check(value), false, `${key}=${value}`);
    assert.equal(restartClassOf(`inbox.retention.${key}`), "core");
    assert.equal(tierOf(`inbox.retention.${key}`), "advanced");
  }
  assert.equal(validate({ schemaVersion: 1, inbox: { retention: { bogus: 1 } } }).ok, false);
});
