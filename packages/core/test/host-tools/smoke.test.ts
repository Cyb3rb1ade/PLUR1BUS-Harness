import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createNodeHostContext, runHostTool } from "../../src/host-tools/index.ts";

const plat = process.platform === "darwin" || process.platform === "win32" || process.platform === "linux"
  ? process.platform
  : null;

describe("host-tools smoke (real OS, read-only)", { skip: plat === null } , () => {
  it("sys.info matches the host platform and does not throw", async () => {
    const ctx = createNodeHostContext();
    const r = await runHostTool("sys.info", {}, ctx);
    assert.equal(r.isError, false, r.isError ? JSON.stringify(r.error) : "");
    if (!r.isError) {
      const v = r.value as { os: string; arch: string; ramBytes: number; uptimeSeconds: number };
      assert.equal(v.os, process.platform);
      assert.equal(v.arch, process.arch);
      assert.ok(v.ramBytes > 0);
      assert.ok(v.uptimeSeconds >= 0);
    }
  });

  it("proc.list includes this process", async () => {
    const ctx = createNodeHostContext();
    const r = await runHostTool("proc.list", {}, ctx);
    assert.equal(r.isError, false, r.isError ? JSON.stringify(r.error) : "");
    if (!r.isError) {
      const v = r.value as { processes: Array<{ pid: number }> };
      assert.ok(v.processes.some((p) => p.pid === process.pid), "own pid missing from proc.list");
    }
  });
});
