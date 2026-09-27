import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { BIN, REAL, cli, coreEnv, home, reapHome, sleep, startDaemon, waitFor } from "./helpers.ts";

const FIXTURE = resolve(process.env.PLUR1BUS_FIXTURE_MODULE ?? "packages/module-fixture/dist");
const child = (h: string, role: string): any => cli(h, ["daemon", "status"]).children?.find((c: any) => c.role === role) ?? null;
const ready = (h: string, role: string, pred: (c: any) => boolean = () => true, timeoutMs = 30_000) =>
  waitFor(`${role} ready`, () => { const c = child(h, role); return c?.process?.state === "ready" && pred(c) && c; }, timeoutMs);

/** `memory recall` started now, answered later (the CLI's exit code and its JSON document). */
function recallAsync(h: string, query: string): Promise<{ exit: number; doc: any; ms: number }> {
  const t0 = performance.now();
  return new Promise((done) => {
    execFile(BIN, ["--json", "--home", h, "memory", "recall", "--agent", "bernd", query], { encoding: "utf8", timeout: 30_000 }, (err, stdout) => {
      let doc: any = null;
      try { doc = JSON.parse(stdout); } catch { /* reported by the assertion */ }
      done({ exit: err ? (typeof err.code === "number" ? err.code : 1) : 0, doc, ms: performance.now() - t0 });
    });
  });
}

// The real core with the fixture module (2a-H3b-a Task 10): criterion 5 (a module restart never touches the core,
// and a recall in flight answers) and criterion 4's module part (a module key restarts that module only; live and
// core keys leave it alone). The flat embedder is cold (the first two query embeddings of the core take 350 ms), so
// the first recall is still running when the module restarts.
describe("M1b-2a-H3b acceptance 4 and 5 — modules beside the real core", { skip: process.platform === "win32" && "POSIX system job" }, () => {
  let h = "";
  before(async () => {
    h = home();
    cli(h, ["agent", "create", "bernd"]);
    cli(h, ["config", "set", "supervisor.graceMs", "15000", "--yes"]);
    const installed = cli(h, ["module", "install", FIXTURE]);
    assert.deepEqual(installed, { schema: "module.install/1", name: "fixture", version: "0.1.0", replaced: false });
    startDaemon(h, REAL ? {} : { PLUR1BUS_TEST_INTERNALS: "flat-embedder-cold" });
    await ready(h, "core");
    await ready(h, "fixture");
  });
  after(async () => {
    try { cli(h, ["daemon", "stop"], { allowFail: true }); } catch { /* best effort */ }
    await reapHome(h);
    rmSync(h, { recursive: true, force: true });
  });

  it("module restart while a recall is in flight", async (t) => {
    const core = await ready(h, "core");
    const fixture = await ready(h, "fixture");
    const recall = recallAsync(h, "what did we plan for the boiler");
    await sleep(50);
    const r = cli(h, ["module", "restart", "fixture"]);
    assert.deepEqual(r, { schema: "module.restart/1", accepted: true, name: "fixture" });
    const answered = await recall;
    assert.equal(answered.exit, 0, JSON.stringify(answered));
    assert.equal(answered.doc?.schema, "memory.recall/1", JSON.stringify(answered));
    const restarted = await ready(h, "fixture", (c) => c.pid !== fixture.pid);
    const coreNow = child(h, "core");
    assert.equal(coreNow.pid, core.pid, "the core was not touched");
    assert.equal(coreNow.restarts, core.restarts);
    t.diagnostic(`fixture ${fixture.pid} → ${restarted.pid}; the recall answered in ${Math.round(answered.ms)} ms`);
  });

  it("config restart classes with a real module", async () => {
    const core = await ready(h, "core");
    const fixture = await ready(h, "fixture");
    // A live key: nothing restarts.
    const live = cli(h, ["config", "set", "core.logLevel", "debug", "--yes"]);
    assert.deepEqual(live.restart, { live: ["core.logLevel"], core: false, modules: [] });
    // A module key: that module only.
    const m = cli(h, ["config", "set", "modules.fixture.greeting", "\"hi\"", "--yes"]);
    assert.deepEqual(m.restart.modules, ["fixture"], JSON.stringify(m));
    assert.equal(m.restart.core, false);
    assert.deepEqual(m.restarted, ["fixture"], JSON.stringify(m));
    const fixture2 = await ready(h, "fixture", (c) => c.pid !== fixture.pid);
    assert.equal(child(h, "core").pid, core.pid, "a module key does not restart the core");
    const list = cli(h, ["module", "list"]);
    const entry = list.modules.find((e: any) => e.name === "fixture");
    assert.equal(entry.detail?.greeting, "hi", JSON.stringify(entry));
    // A core key: the core restarts, the module keeps running (its core link reconnects).
    const c = cli(h, ["config", "set", "engine.duplicateThreshold", "1.01", "--yes"]);
    assert.equal(c.restart.core, true, JSON.stringify(c));
    assert.deepEqual(c.restarted, ["core"], JSON.stringify(c));
    await ready(h, "core", (x) => x.pid !== core.pid);
    const fixture3 = await ready(h, "fixture");
    assert.equal(fixture3.pid, fixture2.pid, "a core key does not restart the module");
    await waitFor("the module's core link back", () => {
      const e = cli(h, ["module", "list"]).modules.find((x: any) => x.name === "fixture");
      return e?.child?.process?.state === "ready" && e;
    }, 30_000);
  });
});
