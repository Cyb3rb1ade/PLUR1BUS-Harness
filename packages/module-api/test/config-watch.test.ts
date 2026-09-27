import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchSupervisorConfig, type ConfigChanged } from "../src/config-watch.ts";
import { runDir, supervisorTokenPath } from "../src/paths.ts";
import { startFakeSupervisor, type FakeSupervisor } from "./helpers/fake-supervisor.ts";

const dirs: string[] = [];
const sups: FakeSupervisor[] = [];
after(async () => {
  for (const s of sups.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function home(): string { const d = mkdtempSync(join(tmpdir(), "p1b-watch-")); dirs.push(d); return d; }
const until = async (pred: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!pred()) { if (Date.now() > end) throw new Error("condition not met in time"); await new Promise((r) => setTimeout(r, 10)); } };

describe("watchSupervisorConfig", () => {
  it("resolves the watch snapshot", async () => {
    const h = home();
    const sup = await startFakeSupervisor({ home: h, config: { core: { logLevel: "info" } }, revision: "rev-a" }); sups.push(sup);
    const w = await watchSupervisorConfig({ home: h });
    assert.deepEqual(w.config, { core: { logLevel: "info" } });
    assert.equal(w.revision, "rev-a");
    assert.deepEqual(sup.watches, [sup.token]);
    assert.deepEqual(await w.set([{ key: "core.logLevel", value: "debug" }]), { applied: true, dryRun: false, changed: ["core.logLevel"], restart: { live: [], core: false, modules: [] }, revision: "rev-a", restarted: [], durationMs: 0 });
    assert.deepEqual(sup.sets, [{ changes: [{ key: "core.logLevel", value: "debug" }] }]);
    await w.close();
  });

  it("forwards config.changed to onChange", async () => {
    const h = home();
    const sup = await startFakeSupervisor({ home: h, config: { core: { logLevel: "info" } } }); sups.push(sup);
    const w = await watchSupervisorConfig({ home: h });
    const seen: ConfigChanged[] = []; const off = w.onChange((c) => seen.push(c));
    const sent = sup.push({ core: { logLevel: "debug" } }, { changed: ["core.logLevel"], restart: { live: ["core.logLevel"], core: false, modules: [] } });
    await until(() => seen.length === 1);
    assert.deepEqual(seen[0], sent);
    assert.deepEqual(w.config, { core: { logLevel: "debug" } });
    assert.equal(w.revision, sent.revision);
    off();
    sup.push({ core: { logLevel: "warn" } });
    await until(() => w.revision === sup.revision);
    assert.equal(seen.length, 1, "an unsubscribed listener hears nothing");
    await w.close();
  });

  it("a config.changed right behind the watch reply is not lost (I1)", async () => {
    const h = home();
    let sup: FakeSupervisor | null = null;
    // The push goes out in the same write as the reply: the peer reads both in one chunk.
    sup = await startFakeSupervisor({ home: h, config: { core: { logLevel: "info" } }, revision: "r1", onWatch: () => { sup!.push({ core: { logLevel: "debug" } }); } }); sups.push(sup);
    const w = await watchSupervisorConfig({ home: h });
    assert.equal(w.revision, sup.revision);
    assert.notEqual(w.revision, "r1");
    assert.deepEqual(w.config, { core: { logLevel: "debug" } });
    await w.close();
  });

  it("onClose fires when the supervisor goes away", async () => {
    const h = home();
    const sup = await startFakeSupervisor({ home: h, config: {} });
    const w = await watchSupervisorConfig({ home: h });
    let closed = 0; w.onClose(() => { closed++; });
    await sup.close();
    await until(() => closed === 1);
  });

  it("rejects after the given attempts when nothing listens", async () => {
    const h = home();
    mkdirSync(runDir(h), { recursive: true });
    writeFileSync(supervisorTokenPath(h), "c".repeat(64));
    const t0 = performance.now();
    await assert.rejects(watchSupervisorConfig({ home: h, attempts: 2, connectTimeoutMs: 150 }));
    const took = performance.now() - t0;
    // Two attempts, each spaced to its full window: at least one window in between, never much more than two.
    assert.ok(took >= 140 && took < 2000, `took ${took} ms`);
  });
});
