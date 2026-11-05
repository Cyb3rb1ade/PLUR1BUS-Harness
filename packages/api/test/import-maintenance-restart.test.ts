import assert from "node:assert/strict";
import test from "node:test";
import { assertCoreRestarted } from "./fixtures/core-restart.ts";

test("maintenance recognizes a new Core instance even if Windows reuses its PID", () => {
  const before = { pid: 5964, instanceId: "old-core" };
  assertCoreRestarted(before, { pid: before.pid, instanceId: "new-core" });
});

test("maintenance requires two identified instances and valid process IDs", () => {
  const before = { pid: 5964, instanceId: "old-core" };
  assert.throws(() => assertCoreRestarted(before, { pid: 7012, instanceId: before.instanceId }));
  assert.throws(() => assertCoreRestarted(before, { pid: 7012, instanceId: "" }));
  assert.throws(() => assertCoreRestarted({ ...before, instanceId: "" }, { pid: 7012, instanceId: "new-core" }));
  assert.throws(() => assertCoreRestarted(before, { pid: 0, instanceId: "new-core" }));
});
