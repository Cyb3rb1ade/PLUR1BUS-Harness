import test from "node:test";
import assert from "node:assert/strict";
import { buildArgs, countTests, guard } from "./run-ts-tests.mjs";

test("buildArgs has no shell-quoted element", () => {
  for (const a of buildArgs()) assert.ok(!/['"]/.test(a), a);
  assert.ok(buildArgs().includes("--filter=!@plur1bus/desktop-ui"));
});

test("countTests sums spec and TAP summaries", () => {
  assert.equal(countTests("ℹ tests 12\nℹ pass 12\n"), 12);
  assert.equal(countTests("ℹ tests 3\n...\n# tests 4\n"), 7);
  assert.equal(countTests("ℹ tests_x 3\n"), 0);
});

test("guard trips on 'No projects matched' even with exit 0", () => {
  assert.match(guard("No projects matched the filters in x", 0), /no projects/);
});

test("guard trips on zero tests, passes otherwise", () => {
  assert.match(guard("nothing\n", 0), /no tests ran/);
  assert.equal(guard("ℹ tests 5\n", 0), null);
});
