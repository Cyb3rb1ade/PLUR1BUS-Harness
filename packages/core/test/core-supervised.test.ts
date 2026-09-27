import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { HostServices } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import { PassThrough } from "node:stream";
import { connect, type CoreClient } from "@plur1bus/module-api";
import { defaults, type HarnessConfig } from "@plur1bus/config-schema";
import { startFakeSupervisor, type FakeSupervisor } from "../../module-api/test/helpers/fake-supervisor.ts";
import { createCore, type Core } from "../src/core.ts";
import { appendJournalLine } from "../src/journal.ts";
import { acquireCoreLock } from "../src/lock.ts";
import { layout } from "../src/paths.ts";
import { flatTestInternals } from "./helpers/flat-embedder.ts";
import { tempDir } from "./helpers/temp-dir.ts";

const caller = { channel: "cli" as const, accountId: "macbooker", userId: "cyberblade" };
// The schema's minimum for supervisor.graceMs; every wait below is derived from it.
const GRACE_MS = 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function testConfig(): HarnessConfig {
  const cfg = defaults(); cfg.agents.bernd = {}; cfg.supervisor.graceMs = GRACE_MS;
  cfg.engine = { neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false }, merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false }, temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false }, reranker: { enabled: false } };
  return cfg;
}

function newHome(): string {
  const home = tempDir("p1b-sup-");
  writeFileSync(layout(home).configPath, JSON.stringify(testConfig()));
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

  async function startSupervised(o: { lifeline?: boolean; passageDelayMs?: number } = {}) {
    const home = newHome(); const lifeline = new PassThrough(); let expired = 0;
    core = createCore({ home, testInternals: flatTestInternals(o.passageDelayMs ? { passageDelayMs: () => o.passageDelayMs! } : {}), ...(o.lifeline === false ? {} : { lifeline }), onOrphanGraceExpired: () => { expired++; } });
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
    // About serving while orphaned, not latency: a generous budget so a slow CI runner does not abort the recall.
    const r = await c.call<any>("memory.recall", { caller, agentId: "bernd", query: "anything about lunch", budget: { softMs: 5000, hardMs: 10_000 } });
    assert.equal(r.degraded, null);
    assert.equal((await c.call<any>("core.status")).process.state, "orphaned");
    // The models warm in the background (S7): wait for them, then orphaned must not have taken engine.ready away.
    await until(() => s.core.status().engine.ready === true);
    assert.equal(s.core.status().process.state, "orphaned", "orphaned is a process state; the engine is still ready");
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

  it("core.adopt while stopping is E_NOT_AVAILABLE stopping", async () => {
    const s = await startSupervised({ passageDelayMs: 1000 }); const token = writeSupervisorToken(s.home);
    const c = await s.client();
    // A capture still embedding keeps the engine (and so the server) open while the core is stopping.
    await c.call("memory.capture", { caller, agentId: "bernd", wait: false, messages: [{ role: "user", content: "Please remember that the boiler service is on Tuesday." }, { role: "assistant", content: "Noted." }] });
    const stopped = s.core.stop({ budgetMs: 5000 }); core = null;
    await assert.rejects(c.call("core.adopt", { nonce: token }), (e: any) => e.error === "E_NOT_AVAILABLE" && e.reason === "stopping");
    await stopped;
  });
});

describe("core supervised mode during the journal replay (B2)", () => {
  const jline = (id: string) => ({ v: 1 as const, id, at: 1, agentId: "bernd", sessionKey: "s1", caller, messages: [{ role: "user" as const, content: "Please remember that the boiler service is on Tuesday." }, { role: "assistant" as const, content: "Noted." }] as [any, any] });

  /** A core whose journal replay embeds one line for `replayMs`; start() resolves ready before it is replayed. */
  function slowReplay(replayMs: number) {
    const home = newHome(); const l = layout(home); const lifeline = new PassThrough(); let expired = 0;
    appendJournalLine(l.journal, jline("11111111-1111-4111-8111-111111111111"));
    const core = createCore({ home, testInternals: flatTestInternals({ passageDelayMs: () => replayMs }), lifeline, onOrphanGraceExpired: () => { expired++; } });
    const replaying = () => core.status().journalReplay?.state === "replaying";
    return { home, core, lifeline, replaying, expired: () => expired };
  }

  it("a lifeline lost before ready orphans the core at ready, and an adoption during the replay re-attaches it", async () => {
    const s = slowReplay(GRACE_MS * 2);
    s.lifeline.end(); // supervisor A is gone before the core is ready
    let c: CoreClient | null = null;
    try {
      await s.core.start();
      const token = writeSupervisorToken(s.home);
      assert.equal(s.core.status().process.state, "orphaned", "the lifeline lost before ready is applied at ready");
      assert.ok(s.replaying(), "the replay still runs");
      c = await connect({ address: s.core.address, token: s.core.token });
      await c.call("core.adopt", { nonce: token }); // supervisor B adopts
      assert.equal(s.core.status().process.state, "ready", "B's connection is the lifeline, not A's dead stdin");
      await sleep(GRACE_MS + 200);
      assert.equal(s.core.status().process.state, "ready"); assert.equal(s.expired(), 0);
      await c.close(); c = null;
      await until(() => s.core.status().process.state === "orphaned");
    } finally { await c?.close(); await s.core.stop({ budgetMs: 5000 }); }
  });

  it("a lifeline lost before ready whose grace runs out during the replay stops the core once", async () => {
    const s = slowReplay(GRACE_MS * 3);
    s.lifeline.end();
    try {
      await s.core.start();
      assert.equal(s.core.status().process.state, "orphaned");
      assert.equal(s.expired(), 0);
      await until(() => s.expired() === 1, GRACE_MS * 2);
      assert.ok(s.replaying(), "the grace ran out while the journal replayed");
      await sleep(GRACE_MS + 200); assert.equal(s.expired(), 1, "once");
    } finally { await s.core.stop({ budgetMs: 5000 }); }
  });
});

describe("core supervised mode before ready (startDelayMs seam)", () => {
  const allow = process.env.PLUR1BUS_ALLOW_TEST_INTERNALS;
  before(() => { process.env.PLUR1BUS_ALLOW_TEST_INTERNALS = "1"; });
  after(() => { if (allow === undefined) delete process.env.PLUR1BUS_ALLOW_TEST_INTERNALS; else process.env.PLUR1BUS_ALLOW_TEST_INTERNALS = allow; });

  /** A core that listens but stays in `starting` for `delayMs` (the seam), as a slow start would. */
  function slowStart(delayMs: number) {
    const home = newHome(); const lifeline = new PassThrough(); let expired = 0;
    const core = createCore({ home, testInternals: { ...flatTestInternals(), startDelayMs: delayMs }, lifeline, onOrphanGraceExpired: () => { expired++; } });
    return { home, core, lifeline, expired: () => expired };
  }

  it("an adoption before ready survives ready", async () => {
    const s = slowStart(GRACE_MS * 2);
    s.lifeline.end(); // supervisor A is gone before the core is ready
    const started = s.core.start();
    let c: CoreClient | null = null;
    try {
      await until(() => existsSync(layout(s.home).coreToken), 10_000);
      const token = writeSupervisorToken(s.home);
      await sleep(GRACE_MS + 200); // A's grace runs out while starting
      assert.equal(s.core.status().process.state, "starting");
      c = await connect({ address: s.core.address, token: s.core.token });
      await c.call("core.adopt", { nonce: token }); // supervisor B adopts before ready: the expired grace is void
      await started;
      assert.equal(s.core.status().process.state, "ready", "B's connection is the lifeline, not A's dead stdin");
      await sleep(GRACE_MS + 200);
      assert.equal(s.core.status().process.state, "ready"); assert.equal(s.expired(), 0);
      await c.close(); c = null;
      await until(() => s.core.status().process.state === "orphaned");
    } finally { await c?.close(); await started.catch(() => {}); await s.core.stop({ budgetMs: 5000 }); }
  });

  it("a lifeline lost before ready whose grace runs out while starting stops the core at ready", async () => {
    const s = slowStart(GRACE_MS + 500);
    s.lifeline.end();
    try {
      await s.core.start();
      assert.equal(s.expired(), 1, "the expired grace is acted on at ready");
      assert.equal(s.core.status().process.state, "orphaned");
      await sleep(GRACE_MS + 200); assert.equal(s.expired(), 1, "once");
    } finally { await s.core.stop({ budgetMs: 5000 }); }
  });

  it("the seam is ignored without PLUR1BUS_ALLOW_TEST_INTERNALS=1", async () => {
    delete process.env.PLUR1BUS_ALLOW_TEST_INTERNALS;
    const s = slowStart(5000);
    try {
      const t0 = performance.now(); await s.core.start();
      assert.ok(performance.now() - t0 < 4000, "start was not delayed");
    } finally { process.env.PLUR1BUS_ALLOW_TEST_INTERNALS = "1"; await s.core.stop({ budgetMs: 5000 }); }
  });
});

describe("core on the supervisor's configuration (B7)", () => {
  let core: Core | null = null; const clients: CoreClient[] = []; const sups: FakeSupervisor[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {});
    await core?.stop({ budgetMs: 5000 }); core = null;
    for (const s of sups.splice(0)) await s.close();
  });

  /** A supervised core whose supervisor is the fake config service; config.json holds `testConfig()` untouched. */
  async function startOnSupervisor(o: { config?: HarnessConfig; queryDelayMs?: number } = {}) {
    const home = newHome(); const lifeline = new PassThrough(); let expired = 0; let host: HostServices | null = null;
    const config = o.config ?? testConfig();
    const sup = await startFakeSupervisor({ home, config: config as unknown as Record<string, unknown> }); sups.push(sup);
    core = createCore({
      home, lifeline, onOrphanGraceExpired: () => { expired++; },
      testInternals: flatTestInternals(o.queryDelayMs ? { queryDelayMs: () => o.queryDelayMs! } : {}),
      supervisorConfig: { attempts: 1, connectTimeoutMs: 1000 }, inspectHost: (h) => { host = h; },
    });
    await core.start();
    const client = async () => { const c = await connect({ address: core!.address, token: core!.token }); clients.push(c); return c; };
    /** Pushes `edit(config)` as the new running configuration and waits until the core runs it. */
    const push = async (edit: (c: HarnessConfig) => void) => {
      const next = structuredClone(sup.config) as unknown as HarnessConfig; edit(next);
      sup.push(next as unknown as Record<string, unknown>);
      await until(() => core!.status().config?.revision === sup.revision);
    };
    return { home, lifeline, sup, core, client, push, expired: () => expired, host: () => host };
  }
  const logRecords = (home: string) => readFileSync(layout(home).logFile("core"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

  it("core.logLevel change applies without restart", async () => {
    const s = await startOnSupervisor();
    assert.deepEqual(s.core.status().config, { revision: s.sup.revision, source: "supervisor", restartPending: false });
    assert.equal(logRecords(s.home).filter((r) => r.level === "debug").length, 0, "info level: no debug records yet");
    const pid = s.core.status().pid; const instanceId = s.core.status().instanceId;
    await s.push((c) => { c.core.logLevel = "debug"; });
    await until(() => logRecords(s.home).some((r) => r.level === "debug"));
    assert.equal(s.core.status().process.state, "ready");
    assert.equal(s.core.status().instanceId, instanceId); assert.equal(s.core.status().pid, pid);
    assert.equal(s.core.status().config?.restartPending, false);
  });

  it("hardBudgetMs change applies to the next recall", async () => {
    const config = testConfig(); config.core.recall.softBudgetMs = 4000; config.core.recall.hardBudgetMs = 5000;
    const s = await startOnSupervisor({ config, queryDelayMs: 400 });
    await until(() => s.core.status().engine.ready === true, 15_000);
    const c = await s.client();
    const before = await c.call<any>("memory.recall", { caller, agentId: "bernd", query: "anything about lunch" });
    assert.equal(before.degraded, null, "a 5 s hard budget covers a 400 ms embedding");
    await s.push((cfg) => { cfg.core.recall.softBudgetMs = 50; cfg.core.recall.hardBudgetMs = 100; });
    const after = await c.call<any>("memory.recall", { caller, agentId: "bernd", query: "anything about lunch" });
    assert.equal(after.degraded?.reason, "aborted");
  });

  it("supervisor.graceMs change applies to the next orphaning", async () => {
    const s = await startOnSupervisor();
    await s.push((c) => { c.supervisor.graceMs = GRACE_MS * 3; });
    s.lifeline.end();
    await until(() => s.core.status().process.state === "orphaned");
    await sleep(GRACE_MS * 2);
    assert.equal(s.expired(), 0, "the old 1 s grace no longer applies");
    await until(() => s.expired() === 1, GRACE_MS * 3);
  });

  it("agents added by config.changed are registered", async () => {
    const s = await startOnSupervisor();
    assert.deepEqual(s.core.status().agents.map((a) => a.agentId), ["bernd"]);
    await s.push((c) => { c.agents.anna = {}; });
    assert.deepEqual(s.core.status().agents.map((a) => a.agentId), ["anna", "bernd"]);
    assert.ok(existsSync(layout(s.home).workspaceDir("anna")), "the new agent is scaffolded");
    const c = await s.client();
    assert.deepEqual((await c.call<any>("agent.list")).agents.map((a: any) => a.agentId), ["anna", "bernd"]);
  });

  it("a core-class change sets status().config.restartPending", async () => {
    const s = await startOnSupervisor();
    await s.push((c) => { c.engine = { ...c.engine, duplicateThreshold: 1.01 }; });
    assert.deepEqual(s.core.status().config, { revision: s.sup.revision, source: "supervisor", restartPending: true });
    const c = await s.client();
    assert.equal((await c.call<any>("core.status")).config.restartPending, true);
  });

  it("a softBudgetMs change sets restartPending (HB3: construction-time in the engine)", async () => {
    const s = await startOnSupervisor();
    await s.push((c) => { c.core.recall.softBudgetMs = 250; });
    assert.equal(s.core.status().config?.restartPending, true);
  });

  it("mutateConfig sends a flattened config.set", async () => {
    const s = await startOnSupervisor();
    const host = s.host();
    assert.ok(host?.mutateConfig, "set under a supervisor");
    await host.mutateConfig({ recall: { maxItems: 7 }, tags: ["a", "b"] });
    assert.deepEqual(s.sup.sets, [{ changes: [{ key: "engine.recall.maxItems", value: 7 }, { key: "engine.tags", value: ["a", "b"] }] }]);
  });

  it("a core that fell back to the file takes the supervisor's agents and mutateConfig after a re-watch (M7)", async () => {
    const home = newHome(); const lifeline = new PassThrough(); let host: HostServices | null = null;
    core = createCore({
      home, lifeline, testInternals: flatTestInternals(),
      supervisorConfig: { attempts: 1, connectTimeoutMs: 100 }, inspectHost: (h) => { host = h; },
    });
    await core.start(); // no supervisor answers: config.json
    assert.equal(core.status().config?.source, "file");
    assert.equal(host!.mutateConfig, undefined);
    const next = testConfig(); next.agents.anna = {};
    const sup = await startFakeSupervisor({ home, config: next as unknown as Record<string, unknown> }); sups.push(sup);
    const c = await connect({ address: core.address, token: core.token }); clients.push(c);
    await c.call("core.adopt", { nonce: sup.token });
    await until(() => core!.status().config?.source === "supervisor");
    assert.deepEqual(core.status().agents.map((a) => a.agentId), ["anna", "bernd"], "the supervisor's agents, not config.json's");
    assert.equal(typeof host!.mutateConfig, "function");
    await host!.mutateConfig!({ x: 1 });
    assert.deepEqual(sup.sets, [{ changes: [{ key: "engine.x", value: 1 }] }]);
  });

  it("after core.adopt the core re-watches with the new token", async () => {
    const s = await startOnSupervisor();
    assert.deepEqual(s.sup.watches, [s.sup.token]);
    // Supervisor A dies; supervisor B (a new token, a hand-edited configuration) takes the home over.
    await s.sup.close(); s.lifeline.end();
    await until(() => s.core.status().process.state === "orphaned");
    const next = structuredClone(s.sup.config) as unknown as HarnessConfig; next.core.logLevel = "debug"; next.engine = { ...next.engine, duplicateThreshold: 1.01 };
    const b = await startFakeSupervisor({ home: s.home, config: next as unknown as Record<string, unknown>, revision: "rev-b" }); sups.push(b);
    assert.notEqual(b.token, s.sup.token);
    const c = await s.client();
    await c.call("core.adopt", { nonce: b.token });
    await until(() => b.watches.length === 1);
    assert.deepEqual(b.watches, [b.token]);
    await until(() => s.core.status().config?.revision === "rev-b");
    assert.deepEqual(s.core.status().config, { revision: "rev-b", source: "supervisor", restartPending: true }, "the difference is applied; the core-class part is pending");
    await until(() => logRecords(s.home).some((r) => r.level === "debug"));
  });
});
