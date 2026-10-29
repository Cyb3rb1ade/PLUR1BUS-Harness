/** Native snapshot IPC crosses only opaque handles and bounded public metadata. */
import assert from "node:assert/strict";
import test from "node:test";
import { hostSnapshot, type HostInvoke } from "../src/pages/import/host.ts";

test("native source picker passes only an opaque selection handle and returns snapshot metadata", async () => {
  const calls: unknown[] = [];
  const invoke: HostInvoke = async (method, params) => {
    calls.push({ method, params });
    return method === "host_file_pick"
      ? { selectionId: "selection", label: "source" }
      : { snapshotId: "S".repeat(43), expiresAt: Date.now() + 600000, sha256: "a".repeat(64), fileCount: 2, bytes: 12 };
  };
  const result = await hostSnapshot("fixture", invoke);
  assert.deepEqual(calls, [
    { method: "host_file_pick", params: { request: {} } },
    { method: "host_import_snapshot", params: { request: { selectionId: "selection", sourceType: "fixture" } } },
  ]);
  assert.equal(result?.snapshotId, "S".repeat(43));
  assert.ok(!JSON.stringify(calls).includes("path"));
});
test("picker cancellation starts no snapshot; malformed native responses never become sources", async () => {
  let calls = 0;
  assert.equal(
    await hostSnapshot("fixture", async () => {
      calls++;
      return null;
    }),
    null,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    hostSnapshot("fixture", async (method) =>
      method === "host_file_pick"
        ? { selectionId: "selection", label: "source" }
        : { snapshotId: "bad", path: "/host/private" },
    ),
  );
});
