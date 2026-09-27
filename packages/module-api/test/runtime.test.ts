// runModule (B9) end to end: the built fixture module runs as a real process against a temp home, with the fake
// supervisor serving config.watch (supervisor.graceMs 1000) and owning run/supervisor.token, the adoption nonce.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { defaults } from "@plur1bus/config-schema";
import { validateResult } from "@plur1bus/rpc-schema";
import { RpcCallError } from "../src/client.ts";
import { moduleRunFiles } from "../src/paths.ts";
import { startFakeSupervisor, type FakeSupervisor } from "./helpers/fake-supervisor.ts";
import { buildFixture, connectModule, exitWithin, installFixture, killLeftovers, spawnModule, waitStatus } from "./helpers/module-process.ts";
import { tempDir } from "./helpers/temp-dir.ts";

const GRACE_MS = 1000;

async function home(): Promise<{ home: string; sup: FakeSupervisor }> {
  const h = tempDir("p1b-mod-");
  installFixture(h);
  const config = { ...defaults(), supervisor: { ...defaults().supervisor, graceMs: GRACE_MS } } as unknown as Record<string, unknown>;
  const sup = await startFakeSupervisor({ home: h, config });
  opened.push(sup);
  return { home: h, sup };
}
const opened: FakeSupervisor[] = [];

describe("module runtime (runModule)", () => {
  before(() => { buildFixture(); });
  after(async () => { killLeftovers(); for (const s of opened.splice(0)) await s.close(); });

  it("a second instance exits 3 while the lock is held", async () => {
    const { home: h } = await home();
    const first = spawnModule(h);
    const c = await connectModule(h);
    const s = await c.call("module.status", {});
    assert.deepEqual(validateResult("module.status", s), { ok: true });
    assert.equal((s as any).instanceId, first.instanceId);
    assert.equal((s as any).core, "reconnecting", "the manifest needs the core, and none runs");
    const second = spawnModule(h);
    assert.equal(await exitWithin(second, 15_000), 3, second.stderr());
    assert.match(second.stderr(), /holds/);
    await c.call("module.shutdown", {});
    assert.equal(await exitWithin(first, 15_000), 0);
  });

  it("stdin EOF orphans and grace expiry exits 0 and removes the run files", async () => {
    const { home: h } = await home();
    const p = spawnModule(h);
    const c = await connectModule(h);
    await waitStatus(c, (s) => s.process.state === "ready");
    const t0 = performance.now();
    p.child.stdin.end();
    await waitStatus(c, (s) => s.process.state === "orphaned");
    assert.equal(await exitWithin(p, 15_000), 0, p.stderr());
    assert.ok(performance.now() - t0 >= GRACE_MS * 0.9, "the module outlived its lifeline for the grace period");
    const files = moduleRunFiles(h, "fixture");
    assert.equal(existsSync(files.token), false, "token removed");
    assert.equal(existsSync(files.pid), false, "pid file removed");
  });

  it("module.adopt with the supervisor token re-attaches and cancels the grace", async () => {
    const { home: h, sup } = await home();
    const p = spawnModule(h);
    const c = await connectModule(h);
    p.child.stdin.end();
    await waitStatus(c, (s) => s.process.state === "orphaned");
    const r = await c.call<{ status: any }>("module.adopt", { nonce: sup.token });
    assert.deepEqual(validateResult("module.adopt", r), { ok: true });
    assert.equal(r.status.process.state, "ready");
    await new Promise((res) => setTimeout(res, GRACE_MS * 2));
    assert.equal(p.child.exitCode, null, "still running after twice the grace");
    assert.equal((await c.call<any>("module.status", {})).process.state, "ready");
    await c.call("module.shutdown", { budgetMs: 2000 });
    assert.equal(await exitWithin(p, 15_000), 0);
  });

  it("a wrong nonce is E_UNAUTHORIZED adopt-nonce", async () => {
    const { home: h } = await home();
    const p = spawnModule(h);
    const c = await connectModule(h);
    await assert.rejects(c.call("module.adopt", { nonce: "f".repeat(64) }), (e: unknown) => e instanceof RpcCallError && e.error === "E_UNAUTHORIZED" && e.reason === "adopt-nonce");
    await c.call("module.shutdown", {});
    assert.equal(await exitWithin(p, 15_000), 0);
  });

  it("module.shutdown exits 0", async () => {
    const { home: h } = await home();
    const p = spawnModule(h);
    const c = await connectModule(h);
    const r = await c.call("module.shutdown", { budgetMs: 5000 });
    assert.deepEqual(r, { accepted: true });
    assert.equal(await exitWithin(p, 15_000), 0, p.stderr());
    const files = moduleRunFiles(h, "fixture");
    assert.equal(existsSync(files.token) || existsSync(files.pid), false, "run files removed");
  });

  it("a manifest with a different name exits 2", async () => {
    const h = tempDir("p1b-mod-");
    installFixture(h, { manifest: { name: "other" } });
    const p = spawnModule(h, { lifeline: false });
    assert.equal(await exitWithin(p, 15_000), 2);
    assert.match(p.stderr(), /manifest name "other" is not the module "fixture"/);
  });
});
