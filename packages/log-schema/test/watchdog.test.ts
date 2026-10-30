import assert from "node:assert/strict";
import { test } from "node:test";
import { lookupEvent, validateRecord } from "../src/index.ts";

test("the watchdog catalogue example permits only its static labels and bounded numeric detail", () => {
  const entry = lookupEvent("sandbox.watchdog.failure");
  assert.ok(entry);
  const example = entry.examples[0]!;
  const attrs = example.attrs as Record<string, unknown>;
  assert.deepEqual(validateRecord(example), { ok: true, entry });
  assert.deepEqual(entry.kinds, ["harness"]);
  assert.deepEqual(entry.levels, ["info"]);
  const valid = (changed: Record<string, unknown>) => validateRecord({ ...example, attrs: changed }).ok;
  for (const field of ["process", "cause", "operation", "phase"]) assert.equal(valid({ ...attrs, [field]: "PRIVATE-CONTENT" }), false, field);
  for (const field of ["argv", "command", "username", "path", "secret"]) assert.equal(valid({ ...attrs, [field]: "PRIVATE-CONTENT" }), false, field);
  for (const version of [0, 2, "1"]) assert.equal(valid({ ...attrs, version }), false);
  for (const field of ["sample", "elapsedMicros", "pid", "returned", "expected", "errno", "probeReturned", "probeErrno", "ppid", "pgid", "status", "startSeconds", "startMicros", "processRssBytes", "count", "rssBytes"]) {
    for (const value of ["PRIVATE-CONTENT", -2, 0.5, Number.MAX_SAFE_INTEGER + 1]) assert.equal(valid({ ...attrs, [field]: value }), false, field);
  }
  assert.equal(valid({ ...attrs, returned: -1, probeReturned: -1 }), true);
  assert.equal(valid({ ...attrs, phase: "attach", cause: "sample-deadline", operation: "group-list" }), true);
  for (const field of entry.requiredAttrs) {
    const incomplete = { ...attrs }; delete incomplete[field];
    assert.equal(valid(incomplete), false, `required ${field}`);
  }
});
