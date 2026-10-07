// The fixture module's own behaviour (its README): detail.greeting from modules.fixture.greeting, and crashAfterMs.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaults } from "@plur1bus/config-schema";
// module-api's test helpers, by relative path: test-only, and in the package dependency direction (this package
// depends on module-api). They are not part of module-api's published surface.
import { startFakeSupervisor, type FakeSupervisor } from "../../module-api/test/helpers/fake-supervisor.ts";
import { buildFixture, connectModule, exitWithin, installFixture, killLeftovers, spawnModule, waitStatus } from "../../module-api/test/helpers/module-process.ts";
import { tempDir } from "../../module-api/test/helpers/temp-dir.ts";

const withModules = (modules: Record<string, unknown>) => ({ ...defaults(), modules }) as unknown as Record<string, unknown>;

describe("fixture module", () => {
  const sups: FakeSupervisor[] = [];
  before(() => { buildFixture(); });
  after(async () => { killLeftovers(); for (const s of sups.splice(0)) await s.close(); });

  it("status.detail reports the configured greeting", async () => {
    const home = tempDir("p1b-fix-");
    installFixture(home);
    const sup = await startFakeSupervisor({ home, config: withModules({ fixture: { greeting: "hello from the test" } }) });
    sups.push(sup);
    const p = spawnModule(home);
    const c = await connectModule(home);
    assert.deepEqual((await c.call<any>("module.status", {})).detail, { greeting: "hello from the test" });
    sup.push(withModules({ fixture: { greeting: "changed" } }), { changed: ["modules.fixture.greeting"], restart: { live: [], core: false, modules: ["fixture"] } });
    await waitStatus(c, (s) => s.detail?.greeting === "changed");
    await c.call("module.shutdown", {});
    assert.equal(await exitWithin(p, 15_000), 0, p.stderr());
  });

  it("runs from a home path containing spaces and Unicode", async () => {
    const home = tempDir("p1b fixture λ-");
    installFixture(home);
    const sup = await startFakeSupervisor({ home, config: withModules({ fixture: { greeting: "path works" } }) });
    sups.push(sup);
    const p = spawnModule(home);
    const c = await connectModule(home);
    assert.equal((await c.call<any>("module.status", {})).name, "fixture");
    await c.call("module.shutdown", {});
    assert.equal(await exitWithin(p, 15_000), 0, p.stderr());
  });

  it("installing the fixture twice preserves one identical module", () => {
    const home = tempDir("p1b-fix-");
    const dir = installFixture(home);
    const snapshot = () => readdirSync(dir).sort().map((name) => [name, readFileSync(join(dir, name))]);
    const first = snapshot();
    installFixture(home);
    assert.deepEqual(snapshot(), first);
    assert.deepEqual(readdirSync(join(home, "modules")), ["fixture"]);
  });

  it("starts when its optional memory capability is unavailable", async () => {
    const home = tempDir("p1b-fix-");
    installFixture(home, { manifest: { needs: [] } });
    const p = spawnModule(home, { lifeline: false });
    const c = await connectModule(home);
    const status = await c.call<any>("module.status", {});
    assert.equal(status.core, "not-needed");
    assert.deepEqual(JSON.parse(readFileSync(join(home, "modules", "fixture", "module.json"), "utf8")).consumes, ["memory"]);
    await c.call("module.shutdown", {});
    assert.equal(await exitWithin(p, 15_000), 0, p.stderr());
  });

  it("reports a corrupt manifest clearly and exits with the manifest error code", async () => {
    const home = tempDir("p1b-fix-");
    installFixture(home);
    const manifest = join(home, "modules", "fixture", "module.json");
    writeFileSync(manifest, '{"name":');
    const p = spawnModule(home, { lifeline: false });
    assert.equal(await exitWithin(p, 15_000), 2, p.stderr());
    assert.ok(p.stderr().includes("manifest unreadable"), p.stderr());
    assert.ok(p.stderr().includes(manifest), p.stderr());
  });

  it("the build marks index.js as an ES module (H3B-R23)", () => {
    const dist = buildFixture();
    assert.deepEqual(JSON.parse(readFileSync(join(dist, "package.json"), "utf8")), { type: "module" });
  });

  it("crashAfterMs exits 1", async () => {
    const home = tempDir("p1b-fix-");
    installFixture(home);
    writeFileSync(join(home, "config.json"), JSON.stringify(withModules({ fixture: { crashAfterMs: 200 } })));
    const t0 = performance.now();
    const p = spawnModule(home, { lifeline: false }); // no supervisor: the module reads config.json itself
    assert.equal(await exitWithin(p, 15_000), 1, p.stderr());
    assert.ok(performance.now() - t0 >= 200, "not before crashAfterMs");
  });
});
