/** D120: the real tools binary is owned and reaped in standalone mode and remains optional to Core. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ToolsClient, toolsEnvironment } from "../../src/tools-service/client.ts";

test("tools children inherit OS basics without provider credentials or loader injection", () => {
  const canary = randomBytes(24).toString("hex");
  const environment = toolsEnvironment({ PATH: "/fixture", TMPDIR: "/fixture-temp",
    PROVIDER_CREDENTIAL: canary, DYLD_INSERT_LIBRARIES: "/foreign", NODE_OPTIONS: "--inspect" });
  assert.deepEqual(Object.keys(environment).sort(), ["PATH", "TMPDIR"]);
  assert.equal(Object.values(environment).includes(canary), false);
});

test("standalone Core spawns tools, exchanges a key, reconnects after a crash and reaps its child", async () => {
  const home = await mkdtemp(join(tmpdir(), "p1b-tools-client-"));
  const client = new ToolsClient({ home, supervised: false, pollIntervalMs: 50,
    binary: resolve(process.env.CARGO_TARGET_DIR ?? fileURLToPath(new URL("../../../../target", import.meta.url)), "debug", `plur1bus-tools${process.platform === "win32" ? ".exe" : ""}`) });
  let pid: number | null = null;
  try {
    const health = await client.health();
    assert.equal(health.process.state, "ready");
    pid = health.pid;
    assert.equal(client.snapshot().ready, true);
    process.kill(pid, "SIGKILL");
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        const next = await client.health();
        if (next.pid !== pid) {
          pid = next.pid;
          break;
        }
      } catch { /* The child waiter and reconnect backoff must observe the crashed generation. */ }
      assert.ok(Date.now() < deadline, "tools did not reconnect after its crash");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  } finally {
    await client.close();
    await rm(home, { recursive: true, force: true });
  }
  if (pid !== null) assert.throws(() => process.kill(pid!, 0));
});

test("an unavailable supervised service gives a typed refusal and leaves the caller usable", async () => {
  const home = await mkdtemp(join(tmpdir(), "p1b-tools-down-"));
  const client = new ToolsClient({ home, supervised: true, pollIntervalMs: 50 });
  try {
    await assert.rejects(client.health(), (error: unknown) => {
      return error !== null && typeof error === "object" && "reason" in error && error.reason === "tools-unavailable";
    });
    assert.equal(client.snapshot().ready, false);
  } finally {
    await client.close();
    await rm(home, { recursive: true, force: true });
  }
});
