import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { connect, type CoreClient } from "@plur1bus/module-api";
import { defaults } from "@plur1bus/config-schema";
import { createCore, type Core } from "../src/core.ts";
import { acquireCoreLock } from "../src/lock.ts";
import { layout } from "../src/paths.ts";
import { flatTestInternals } from "./helpers/flat-embedder.ts";

const caller = { channel: "cli" as const, accountId: "macbooker", userId: "cyberblade" };
// The schema's minimum for supervisor.graceMs; every wait below is derived from it.
const GRACE_MS = 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), "p1b-sup-"));
  const cfg = defaults(); cfg.agents.bernd = {}; cfg.supervisor.graceMs = GRACE_MS;
  cfg.engine = { neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false }, merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false }, temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false }, reranker: { enabled: false } };
  writeFileSync(layout(home).configPath, JSON.stringify(cfg));
  return home;
}

/** Plays the supervisor: writes a fresh 64-hex token to run/supervisor.token (S3). */
function writeSupervisorToken(home: string): string {
  const t = randomBytes(32).toString("hex");
  writeFileSync(layout(home).supervisorToken, t, { mode: 0o600 });
  return t;
}

async function until(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!pred()) { if (Date.now() > end) throw new Error("condition not met in time"); await sleep(20); }
}

describe("core supervised mode", () => {
  let core: Core | null = null; const clients: CoreClient[] = [];
  afterEach(async () => { for (const c of clients.splice(0)) await c.close().catch(() => {}); await core?.stop({ budgetMs: 5000 }); core = null; });

  async function startSupervised(o: { lifeline?: boolean } = {}) {
    const home = newHome(); const lifeline = new PassThrough(); let expired = 0;
    core = createCore({ home, testInternals: flatTestInternals(), ...(o.lifeline === false ? {} : { lifeline }), onOrphanGraceExpired: () => { expired++; } });
    await core.start();
    const client = async () => { const c = await connect({ address: core!.address, token: core!.token }); clients.push(c); return c; };
    return { home, lifeline, core, client, expired: () => expired };
  }

  it("lifeline EOF orphans the core and it keeps serving memory.recall", async () => {
    const s = await startSupervised();
    assert.equal(s.core.status().process.state, "ready");
    s.lifeline.end();
    await until(() => s.core.status().process.state === "orphaned");
    assert.equal(typeof s.core.status().process.since, "number");
    const c = await s.client();
    const r = await c.call<any>("memory.recall", { caller, agentId: "bernd", query: "anything about lunch" });
    assert.equal(r.degraded, null);
    assert.equal((await c.call<any>("core.status")).process.state, "orphaned");
    assert.equal(s.core.status().engine.ready, true, "orphaned is a process state; the engine is still ready");
  });

  it("grace expiry calls onOrphanGraceExpired; stop leaves no lock, socket or run files", async () => {
    const s = await startSupervised(); const l = layout(s.home);
    s.lifeline.end();
    await until(() => s.core.status().process.state === "orphaned");
    await sleep(GRACE_MS / 2); assert.equal(s.expired(), 0);
    await until(() => s.expired() === 1, GRACE_MS * 3);
    await s.core.stop({ budgetMs: 5000 }); core = null;
    assert.equal(s.core.status().process.state, "stopped");
    for (const f of [l.coreToken, l.corePid]) assert.equal(existsSync(f), false, `${f} removed`);
    if (process.platform !== "win32") assert.equal(existsSync(l.coreSocket), false, "socket removed");
    acquireCoreLock(l.coreLock, "probe").release(); // throws E_LOCKED if the lock were still held
    await sleep(GRACE_MS); assert.equal(s.expired(), 1, "the grace callback fires once");
  });

  it("core.adopt with the supervisor token re-attaches and returns the full status", async () => {
    const s = await startSupervised(); const token = writeSupervisorToken(s.home);
    s.lifeline.end();
    await until(() => s.core.status().process.state === "orphaned");
    const c = await s.client();
    const r = await c.call<any>("core.adopt", { nonce: token });
    assert.equal(r.status.process.state, "ready");
    assert.equal(r.status.instanceId, s.core.status().instanceId);
    assert.equal(s.core.status().process.state, "ready");
    await sleep(GRACE_MS + 200);
    assert.equal(s.expired(), 0, "no grace callback after adoption");
  });

  it("core.adopt with a wrong or missing nonce is E_UNAUTHORIZED adopt-nonce and the core stays orphaned", async () => {
    const s = await startSupervised();
    s.lifeline.end();
    await until(() => s.core.status().process.state === "orphaned");
    const c = await s.client();
    const refused = (e: any) => e.error === "E_UNAUTHORIZED" && e.reason === "adopt-nonce" && e.message === "adoption refused";
    await assert.rejects(c.call("core.adopt", { nonce: "a".repeat(64) }), refused, "no token file");
    writeFileSync(layout(s.home).supervisorToken, "not hex at all", { mode: 0o600 });
    await assert.rejects(c.call("core.adopt", { nonce: "a".repeat(64) }), refused, "malformed token file");
    writeSupervisorToken(s.home);
    await assert.rejects(c.call("core.adopt", { nonce: "b".repeat(64) }), refused, "wrong nonce");
    assert.equal(s.core.status().process.state, "orphaned");
  });

  it("closing the adopting connection orphans the core again", async () => {
    const s = await startSupervised(); const token = writeSupervisorToken(s.home);
    const c = await s.client();
    await c.call("core.adopt", { nonce: token });
    s.lifeline.end(); await sleep(100);
    assert.equal(s.core.status().process.state, "ready", "the replaced stdin lifeline no longer counts");
    await c.close();
    await until(() => s.core.status().process.state === "orphaned");
    await until(() => s.expired() === 1, GRACE_MS * 3);
  });

  it("a second adopt on another connection replaces the lifeline; closing the first does nothing", async () => {
    const s = await startSupervised(); const token = writeSupervisorToken(s.home);
    const first = await s.client(); const second = await s.client();
    await first.call("core.adopt", { nonce: token });
    await second.call("core.adopt", { nonce: token });
    await first.close(); await sleep(200);
    assert.equal(s.core.status().process.state, "ready");
    await second.close();
    await until(() => s.core.status().process.state === "orphaned");
  });

  it("core.adopt gives an unsupervised core a lifeline (S19)", async () => {
    const s = await startSupervised({ lifeline: false }); const token = writeSupervisorToken(s.home);
    const c = await s.client();
    const r = await c.call<any>("core.adopt", { nonce: token });
    assert.equal(r.status.process.state, "ready");
    await c.close();
    await until(() => s.core.status().process.state === "orphaned");
  });

  it("core.pid carries pid and instance id", async () => {
    const s = await startSupervised();
    const pid = readFileSync(layout(s.home).corePid, "utf8");
    assert.match(pid, /^\d+ [0-9a-f-]{36}\n$/);
    assert.equal(pid, `${process.pid} ${s.core.status().instanceId}\n`);
  });
});
