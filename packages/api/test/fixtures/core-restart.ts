import assert from "node:assert/strict";
import type { CoreStatus } from "../../../rpc-schema/generated/types.ts";

type Identity = Pick<CoreStatus, "pid" | "instanceId">;

export function assertCoreRestarted(before: Identity, after: Identity): void {
  for (const status of [before, after]) {
    assert.ok(Number.isInteger(status.pid) && status.pid > 0, "Core reported a positive process ID");
    assert.ok(typeof status.instanceId === "string" && status.instanceId.length > 0, "Core reported its instance ID");
  }
  // Windows can assign the previous process ID to the replacement Core.
  assert.notEqual(after.instanceId, before.instanceId, "maintenance started a new Core instance");
}
