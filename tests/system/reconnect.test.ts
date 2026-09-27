import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  REAL, alive, cli, coreChild, corePid, home, killPid, reapHome, restartSupervisor, sleep, startCore, startDaemon, stopCore, stopDaemon,
  supervisorPid, waitFor,
} from "./helpers.ts";

const FACT = "Please remember that the boiler service is on Tuesday.";

/** `memory recall` for the fact: the core answered (degraded null) and the fact is in the memories block. */
function recallsFact(h: string): void {
  const r = cli(h, ["memory", "recall", "--agent", "bernd", "boiler service"]);
  assert.equal(r.degraded, null, JSON.stringify(r.degraded));
  const memories = r.blocks.find((b: any) => b.name === "memories")?.text ?? "";
  assert.ok(memories.includes(FACT), `the fact is recalled: ${memories}`);
}

// POSIX signals (SIGKILL of the supervisor); the system job is Linux/macOS only.
describe("M1b-2a-H3 acceptance 3 — the core survives a supervisor crash", { skip: (process.platform === "win32" && "POSIX signals") || (REAL && "flat embedder only") }, () => {
  it("criterion 3: reconnect not respawn", async (t) => {
    const h = home();
    try {
      cli(h, ["agent", "create", "bernd"]);
      cli(h, ["config", "set", "supervisor.graceMs", "3000", "--yes"]);
      startDaemon(h);
      const add = cli(h, ["memory", "add", "--agent", "bernd", "--session", "s1", FACT]);
      assert.equal(add.stored, 1, JSON.stringify(add));

      // (a) The supervisor dies and comes back within the grace: the running core is adopted, not respawned.
      const core1 = corePid(h);
      assert.ok(core1, "a core runs");
      await killPid(supervisorPid(h)!, "SIGKILL");
      await sleep(1000);
      assert.ok(alive(core1), "the orphaned core is still running inside its grace");
      await restartSupervisor(h);
      const adopted = await waitFor("the core to be adopted", () => { const c = coreChild(h); return c?.process?.state === "ready" && c; }, 10_000);
      assert.equal(adopted.adopted, true, JSON.stringify(adopted));
      assert.equal(adopted.pid, core1, "the same core pid");
      recallsFact(h);
      t.diagnostic(`(a) core ${core1} adopted after a 1 s supervisor outage`);

      // (b) The supervisor stays away past the grace: the core stops cleanly on its own (socket removed, lock
      // released), and the next supervisor spawns a new core that still has the fact.
      await killPid(supervisorPid(h)!, "SIGKILL");
      await sleep(5000);
      assert.equal(alive(core1), false, "the orphaned core exited after its 3 s grace");
      assert.equal(existsSync(join(h, "run", "core.sock")), false, "run/core.sock removed");
      assert.equal(existsSync(join(h, "run", "core.pid")), false, "run/core.pid removed");
      // The lock is free: a direct `core run` starts instead of exiting 3 (E_LOCKED).
      const direct = await startCore(h);
      await stopCore(direct);
      await restartSupervisor(h);
      const fresh = await waitFor("a new core to be ready", () => { const c = coreChild(h); return c?.process?.state === "ready" && c; }, 30_000);
      assert.equal(fresh.adopted, false, JSON.stringify(fresh));
      assert.notEqual(fresh.pid, core1, "a new core pid");
      recallsFact(h);
      t.diagnostic(`(b) core ${core1} exited after the grace; new core ${fresh.pid}`);

      stopDaemon(h);
    } finally {
      try { cli(h, ["daemon", "stop"], { allowFail: true }); } catch { /* best effort */ }
      await reapHome(h);
      rmSync(h, { recursive: true, force: true });
    }
  });
});
