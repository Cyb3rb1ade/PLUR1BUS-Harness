import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CI_RECALL_HARD_MS, ENGINE_IMPL, REAL, alive, cli, coreChild, corePid, engineBin, home, killPid, reapHome, restartSupervisor, sleep, startCore, startDaemon, stopCore, stopDaemon,
  supervisorPid, waitFor, waitJournalDrained,
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
      // H3-R26: on a shared CI runner the first recall of a fresh core may need more than the default 600 ms hard budget.
      if (CI_RECALL_HARD_MS !== null) cli(h, ["config", "set", "core.recall.hardBudgetMs", String(CI_RECALL_HARD_MS), "--yes"]);
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

describe("RY-B — Rust engine startup", { skip: ENGINE_IMPL !== "rust" || REAL || process.platform === "win32" }, () => {
  it("opens the same store and Core connection through a symlinked home", async () => {
    const h = home();
    const alias = h + "-link";
    try {
      symlinkSync(h, alias, "dir");
      cli(alias, ["agent", "create", "bernd"]);
      const core = await startCore(alias);
      try {
        await waitFor("the Rust engine to answer memory recall", () => {
          const result = cli(alias, ["memory", "recall", "--agent", "bernd", "boiler service"]);
          return result.degraded === null;
        }, 10_000);
        const add = cli(alias, ["memory", "add", "--agent", "bernd", "--session", "linked", FACT]);
        assert.equal(add.stored, 1, JSON.stringify(add));
        recallsFact(alias);
        recallsFact(h);
      } finally {
        await stopCore(core);
      }
    } finally {
      await reapHome(h);
      rmSync(alias, { force: true });
      rmSync(h, { recursive: true, force: true });
    }
  });

  it("journals during engine startup and replays after the engine connects", async () => {
    const h = home();
    const ready = join(h, "release-engine");
    const wrapper = join(h, "hold-engine");
    writeFileSync(wrapper, '#!/bin/sh\nwhile [ ! -f "$RY_TEST_RELEASE_ENGINE" ]; do sleep 0.05; done\nexec "$RY_TEST_REAL_ENGINE" "$@"\n', { mode: 0o700 });
    try {
      cli(h, ["agent", "create", "bernd"]);
      const core = await startCore(h, {
        PLUR1BUS_ENGINE_BIN: wrapper, RY_TEST_REAL_ENGINE: engineBin(), RY_TEST_RELEASE_ENGINE: ready,
      });
      try {
        const add = cli(h, ["memory", "add", "--agent", "bernd", "--session", "starting", FACT]);
        assert.equal(add.journaled, true, JSON.stringify(add));
        assert.equal(add.degraded?.reason, "core-unavailable");
        const recall = cli(h, ["memory", "recall", "--agent", "bernd", "boiler service"]);
        assert.equal(recall.degraded?.reason, "core-unavailable", JSON.stringify(recall));
        writeFileSync(ready, "");
        await waitJournalDrained(h, 10_000);
        const cards = cli(h, ["memory", "list", "--agent", "bernd", "--since", "0", "--limit", "100"]);
        assert.equal(cards.items.filter((card: { text: string }) => card.text.includes(FACT)).length, 1);
      } finally {
        await stopCore(core);
      }
    } finally {
      await reapHome(h);
      rmSync(h, { recursive: true, force: true });
    }
  });
});
