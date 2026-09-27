import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  REAL, alive, cli, coreChild, corePid, home, killPid, reapHome, restartSupervisor, sleep, startDaemon, supervisorPid, waitFor,
} from "./helpers.ts";

const configPath = (h: string) => join(h, "config.json");
const revision = (h: string): string => cli(h, ["config", "get"]).revision;
const readyChild = (h: string, what: string, pred: (c: any) => boolean = () => true, timeoutMs = 30_000) =>
  waitFor(what, () => { const c = coreChild(h); return c?.process?.state === "ready" && pred(c) && c; }, timeoutMs);

// Criterion 4 without its module part (2a-H3b-a Task 5): a live key applies without a restart, a core key restarts
// the core exactly once, a dry run and an invalid value change nothing, and a core key edited while no supervisor
// ran is applied after the next supervisor adopts the core (B7). SIGKILL of the supervisor: POSIX only.
describe("M1b-2a-H3b acceptance 4 — configuration changes reach the running core", { skip: (process.platform === "win32" && "POSIX signals") || (REAL && "flat embedder only") }, () => {
  let h = "";
  before(() => {
    h = home();
    cli(h, ["agent", "create", "bernd"]);
    cli(h, ["config", "set", "supervisor.graceMs", "15000", "--yes"]);
    startDaemon(h);
  });
  after(async () => {
    try { cli(h, ["daemon", "stop"], { allowFail: true }); } catch { /* best effort */ }
    await reapHome(h);
    rmSync(h, { recursive: true, force: true });
  });

  it("live key: core.logLevel debug applies without a restart", async () => {
    const before = await readyChild(h, "a ready core");
    const r = cli(h, ["config", "set", "core.logLevel", "debug", "--yes"]);
    assert.equal(r.applied, true, JSON.stringify(r));
    assert.deepEqual(r.restart.live, ["core.logLevel"]);
    assert.equal(r.restart.core, false);
    assert.deepEqual(r.restarted, []);
    await waitFor("debug lines in core.log", () => readFileSync(join(h, "logs", "core.log"), "utf8").split("\n").some((l) => l.includes('"level":"debug"')), 10_000);
    const now = coreChild(h);
    assert.equal(now.pid, before.pid, "the same core process");
    assert.equal(now.restarts, before.restarts);
  });

  it("core key: engine.duplicateThreshold restarts the core exactly once", async (t) => {
    const before = await readyChild(h, "a ready core");
    const r = cli(h, ["config", "set", "engine.duplicateThreshold", "1.01", "--yes"]);
    assert.equal(r.restart.core, true, JSON.stringify(r));
    assert.deepEqual(r.restarted, ["core"]);
    assert.equal(typeof r.estimates.core, "number");
    const after = await readyChild(h, "the restarted core", (c) => c.pid !== before.pid);
    assert.equal(after.restarts, before.restarts + 1, JSON.stringify(after));
    assert.equal(after.lastExit.reason, "none", JSON.stringify(after));
    await sleep(6000); // more than one health interval: a second restart would show by now
    const later = coreChild(h);
    assert.equal(later.pid, after.pid, "exactly one new core pid");
    assert.equal(later.restarts, after.restarts);
    t.diagnostic(`core ${before.pid} → ${after.pid} in ${r.durationMs} ms (estimate ${r.estimates.core} ms)`);
  });

  it("dry run changes nothing", async () => {
    const before = await readyChild(h, "a ready core");
    const bytes = readFileSync(configPath(h)); const rev = revision(h);
    const r = cli(h, ["config", "set", "engine.duplicateThreshold", "1.02", "--dry-run"]);
    assert.equal(r.applied, false, JSON.stringify(r)); assert.equal(r.dryRun, true);
    assert.equal(r.restart.core, true, "the plan is still reported");
    assert.deepEqual(r.restarted, []);
    await sleep(1000);
    assert.deepEqual(readFileSync(configPath(h)), bytes, "config.json unchanged");
    assert.equal(revision(h), rev);
    assert.equal(coreChild(h).pid, before.pid);
  });

  it("invalid value rejected", async () => {
    const before = await readyChild(h, "a ready core");
    const bytes = readFileSync(configPath(h)); const rev = revision(h);
    const r = cli(h, ["config", "set", "core.logLevel", "loud", "--yes"], { allowFail: true });
    assert.equal(r.exit, 1, JSON.stringify(r));
    assert.match(`${r.stdout}${r.stderr}`, /E_CONFIG_INVALID/);
    assert.deepEqual(readFileSync(configPath(h)), bytes, "config.json unchanged");
    assert.equal(revision(h), rev);
    assert.equal(coreChild(h).pid, before.pid);
  });

  it("a core key edited while the supervisor is dead is applied after adoption", async (t) => {
    const before = await readyChild(h, "a ready core");
    await killPid(supervisorPid(h)!, "SIGKILL");
    assert.ok(alive(before.pid), "the orphaned core runs on inside its grace");
    const cfg = JSON.parse(readFileSync(configPath(h), "utf8"));
    cfg.engine.duplicateThreshold = 1.03;
    writeFileSync(configPath(h), `${JSON.stringify(cfg, null, 2)}\n`);
    await restartSupervisor(h);
    // The new supervisor adopts the running core; the core re-watches, sees the core-class difference and reports
    // restartPending; the supervisor restarts it once.
    const restarted = await readyChild(h, "the restarted core", (c) => c.pid !== before.pid, 45_000);
    assert.equal(restarted.adopted, false, JSON.stringify(restarted));
    assert.equal(restarted.lastExit.reason, "none", JSON.stringify(restarted));
    assert.equal(alive(before.pid), false, "the adopted core was stopped");
    const log = readFileSync(join(h, "logs", "supervisor.log"), "utf8");
    assert.ok(log.includes('"msg":"core adopted"'), "the core was adopted first");
    assert.equal(log.split("\n").filter((l) => l.includes("core reports a pending core-class config change")).length, 1);
    await sleep(6000);
    assert.equal(corePid(h), restarted.pid, "exactly one restart");
    t.diagnostic(`adopted core ${before.pid} restarted as ${restarted.pid}`);
  });
});
