// runModule (B9) end to end: the built fixture module runs as a real process against a temp home, with the fake
// supervisor serving config.watch (supervisor.graceMs 1000) and owning run/supervisor.token, the adoption nonce.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { defaults } from "@plur1bus/config-schema";
import { RPC_VERSION, validateResult } from "@plur1bus/rpc-schema";
import { RpcCallError, connect } from "../src/client.ts";
import { encodeLine } from "../src/framing.ts";
import { silentLogger } from "../src/logger.ts";
import { createRpcServer } from "../src/rpc-server.ts";
import { coreAddress, coreTokenPath, moduleAddress, moduleRunFiles } from "../src/paths.ts";
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

  it("a broken lock file exits 1, not the retryable 3", async () => {
    const { home: h } = await home();
    writeFileSync(moduleRunFiles(h, "fixture").lock, "this is not a database, and it is long enough to have a header".repeat(20));
    const p = spawnModule(h);
    assert.equal(await exitWithin(p, 15_000), 1, p.stderr());
    assert.match(p.stderr(), /lock unavailable/);
  });

  it("after a SIGKILL the next instance takes the lock and replaces the stale run files", { skip: process.platform === "win32" }, async () => {
    const { home: h } = await home();
    const files = moduleRunFiles(h, "fixture");
    const first = spawnModule(h);
    const c1 = await connectModule(h);
    const staleToken = readFileSync(files.token, "utf8");
    first.child.kill("SIGKILL");
    await exitWithin(first, 15_000);
    await c1.close();
    assert.ok(existsSync(files.token) && existsSync(files.pid), "a SIGKILLed module leaves its run files");
    const second = spawnModule(h);
    const c2 = await connectModule(h); // authenticates with the token the new instance wrote
    assert.notEqual(readFileSync(files.token, "utf8"), staleToken);
    assert.match(readFileSync(files.pid, "utf8"), new RegExp(`^${second.child.pid} ${second.instanceId}\n$`));
    assert.equal((await c2.call<any>("module.status", {})).instanceId, second.instanceId);
    await c2.call("module.shutdown", {});
    assert.equal(await exitWithin(second, 15_000), 0, second.stderr());
  });

  it("SIGTERM stops the module, removes the run files and exits 0", { skip: process.platform === "win32" }, async () => {
    const { home: h } = await home();
    const p = spawnModule(h);
    await connectModule(h);
    p.child.kill("SIGTERM");
    assert.equal(await exitWithin(p, 15_000), 0, p.stderr());
    const files = moduleRunFiles(h, "fixture");
    assert.equal(existsSync(files.token) || existsSync(files.pid), false, "run files removed");
  });

  it("closing the adopting connection orphans the module again", async () => {
    const { home: h, sup } = await home();
    const p = spawnModule(h);
    const watcher = await connectModule(h);
    p.child.stdin.end();
    await waitStatus(watcher, (s) => s.process.state === "orphaned");
    const adopter = await connectModule(h);
    await adopter.call("module.adopt", { nonce: sup.token });
    await waitStatus(watcher, (s) => s.process.state === "ready");
    await adopter.close();
    await waitStatus(watcher, (s) => s.process.state === "orphaned");
    assert.equal(await exitWithin(p, 15_000), 0, p.stderr());
  });

  it("module.status.core is connected while a core serves and reconnecting after it goes", async () => {
    const { home: h } = await home();
    const token = "a".repeat(64);
    writeFileSync(coreTokenPath(h), token);
    const core = createRpcServer({ server: "core", address: coreAddress(h), token, logger: silentLogger(), methods: {}, hello: () => ({ contract: "1.9.0", rpc: RPC_VERSION, instanceId: "fake-core", pid: process.pid }) });
    await core.listen();
    const p = spawnModule(h);
    const c = await connectModule(h);
    await waitStatus(c, (s) => s.core === "connected");
    await core.close({ graceMs: 0 });
    await waitStatus(c, (s) => s.core === "reconnecting");
    await c.call("module.shutdown", {});
    assert.equal(await exitWithin(p, 15_000), 0, p.stderr());
  });

  it("the whole stop stays inside module.shutdown's budget, even with a peer that never closes", { skip: process.platform === "win32" }, async () => {
    const { home: h } = await home();
    const p = spawnModule(h);
    (await connectModule(h)).close();
    // A half-open peer: it authenticates and never ends its side, so a server close would wait out its grace for it.
    const peer = createConnection({ path: moduleAddress(h, "fixture"), allowHalfOpen: true });
    await new Promise<void>((r) => peer.once("connect", () => r()));
    peer.on("data", () => {}); peer.on("error", () => {});
    peer.write(encodeLine({ jsonrpc: "2.0", id: 1, method: "module.auth", params: { token: readFileSync(moduleRunFiles(h, "fixture").token, "utf8").trim() } }));
    const c = await connect({ address: moduleAddress(h, "fixture"), token: readFileSync(moduleRunFiles(h, "fixture").token, "utf8").trim(), endpoint: "module" });
    const t0 = performance.now();
    await c.call("module.shutdown", { budgetMs: 200 });
    assert.equal(await exitWithin(p, 15_000), 0, p.stderr());
    const took = performance.now() - t0;
    peer.destroy();
    // Before M3 the server close alone waited its full 1 s grace for the half-open peer (measured: ~1230 ms).
    assert.ok(took < 950, `exited ${Math.round(took)} ms after a 200 ms budget`);
  });
});
