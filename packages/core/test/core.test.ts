import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type CoreClient } from "@plur1bus/module-api";
import { defaults } from "@plur1bus/config-schema";
import { CORE_FEATURES } from "../src/capabilities.ts";
import { createCore, type Core } from "../src/core.ts";
import { appendJournalLine } from "../src/journal.ts";
import { layout } from "../src/paths.ts";
import { flatEmbedder, flatTestInternals } from "./helpers/flat-embedder.ts";

const caller = { channel: "cli" as const, accountId: "macbooker", userId: "cyberblade" };

function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), "p1b-core-"));
  const cfg = defaults(); cfg.agents.bernd = {};
  cfg.engine = { neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false }, merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false }, temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false }, reranker: { enabled: false }, runtime: { recallTimeoutMs: 10_000 } };
  // The flat embedder gives every text the same vector, so the engine's capture dedup (cosine ≥ duplicateThreshold,
  // default 0.95; engine/capture/capture-turn.js) would skip every fact after the first. Above 1 it never matches.
  cfg.engine.duplicateThreshold = 1.01;
  writeFileSync(layout(home).configPath, JSON.stringify(cfg));
  return home;
}

/** Recall until the joined text matches (a pending capture finishes in the background). */
async function recallUntil(client: CoreClient, query: string, pattern: RegExp, timeoutMs = 8000): Promise<string> {
  const until = Date.now() + timeoutMs; let text = "";
  while (Date.now() < until) {
    const r = await client.call<any>("memory.recall", { caller, agentId: "bernd", query, joined: true });
    text = r.joined.text;
    if (pattern.test(text)) return text;
    await new Promise((res) => setTimeout(res, 100));
  }
  return text;
}

describe("core", () => {
  const home = newHome();
  const l = layout(home);
  let slowMs = 0; // passage-embedding delay for the capture-survival tests
  let core: Core; let c: CoreClient;
  before(async () => {
    core = createCore({ home, testInternals: flatTestInternals({ passageDelayMs: () => slowMs }) });
    await core.start();
    c = await connect({ address: core.address, token: core.token });
  });
  after(async () => { await c?.close(); await core?.stop({ budgetMs: 5000 }); });

  it("core.status is ready with the registered agent idle and the real contract", async () => {
    const s = await c.call<any>("core.status");
    assert.equal(s.process.state, "ready"); assert.equal(s.contract, "1.8.0"); assert.equal(s.rpc, "1.2.0");
    assert.deepEqual(s.agents.map((a: any) => [a.agentId, a.activity.state]), [["bernd", "idle"]]);
  });

  it("core.auth carries capabilities built from the schema", () => {
    assert.equal(c.hello.capabilities?.methods["memory.recall"]?.stability, "stable");
    assert.deepEqual(c.hello.capabilities?.features, [...CORE_FEATURES].sort());
  });

  it("core.auth advertises core methods only and core.adopt without a supervisor token is refused", async () => {
    assert.ok(c.hello.capabilities?.methods["core.adopt"]);
    assert.equal(c.hello.capabilities?.methods["daemon.status"], undefined);
    assert.equal(c.hello.capabilities?.methods["supervisor.auth"], undefined);
    await assert.rejects(c.call("core.adopt", { nonce: "f".repeat(64) }), (e: any) => e.error === "E_UNAUTHORIZED" && e.reason === "adopt-nonce");
  });

  it("core.auth features include events.harness", () => {
    assert.ok(c.hello.capabilities?.features.includes("events.harness"), c.hello.capabilities?.features.join(","));
  });

  // Must run before any other test in this file subscribes to `engine.event`, since `deprecationsUsed` is
  // per-process state for this core's whole lifetime (ADR-016 §5, S13).
  it("core.status lists deprecations used since start", async () => {
    const before = await c.call<any>("core.status");
    assert.deepEqual(before.deprecationsUsed, []);
    const s = await connect({ address: core.address, token: core.token });
    try {
      await s.call("events.subscribe", { names: ["engine.event"] });
      const after = await c.call<any>("core.status");
      assert.deepEqual(after.deprecationsUsed, ["notification:engine.event"]);
    } finally { await s.close(); }
  });

  it("a subscriber without names gets recall.completed and never engine.event", async () => {
    const s = await connect({ address: core.address, token: core.token });
    try {
      const got: Array<[string, any]> = []; s.onNotification((m, p) => got.push([m, p]));
      await s.call("events.subscribe", {});
      await c.call("memory.recall", { caller, agentId: "bernd", query: "anything about lunch" });
      await new Promise((r) => setTimeout(r, 200));
      const completed = got.filter(([m]) => m === "recall.completed");
      assert.equal(completed.length, 1, JSON.stringify(got));
      assert.equal(completed[0]![1].agentId, "bernd"); assert.equal(typeof completed[0]![1].totalMs, "number");
      assert.equal("timing" in completed[0]![1], false);
      assert.equal(got.some(([m]) => m === "engine.event"), false, JSON.stringify(got));
    } finally { await s.close(); }
  });

  it("a subscriber naming engine.event still gets it verbatim", async () => {
    const s = await connect({ address: core.address, token: core.token });
    try {
      const got: Array<[string, any]> = []; s.onNotification((m, p) => got.push([m, p]));
      await s.call("events.subscribe", { names: ["engine.event"] });
      await c.call("memory.recall", { caller, agentId: "bernd", query: "anything about lunch" });
      await new Promise((r) => setTimeout(r, 200));
      assert.ok(got.every(([m]) => m === "engine.event"), JSON.stringify(got));
      const ev = got.find(([, p]) => p.name === "recall.completed");
      assert.ok(ev, JSON.stringify(got));
      assert.equal(ev[1].agentId, "bernd");
      assert.equal(ev[1].payload.agentId, "bernd"); assert.equal(typeof ev[1].payload.timing.totalMs, "number");
    } finally { await s.close(); }
  });

  it("core.status reports the engine store schema", async () => {
    const s = await c.call<any>("core.status");
    assert.equal(typeof s.engine.storeSchema.expected, "string");
  });

  it("capture then recall in another session finds the fact; activity notifications fire", async () => {
    const seen: string[] = []; c.onNotification((m, p: any) => { if (m === "agent.activity") seen.push(p.activity.state); });
    await c.call("events.subscribe", { names: ["agent.activity"] });
    const cap = await c.call<any>("memory.capture", { caller, agentId: "bernd", sessionKey: "s1", messages: [{ role: "user", content: "Please remember that the roadmap review is on Thursday at ten." }, { role: "assistant", content: "Noted." }] });
    assert.ok(cap.stored >= 1, JSON.stringify(cap));
    const r = await c.call<any>("memory.recall", { caller, agentId: "bernd", sessionKey: "s2", query: "when is the roadmap review", joined: true, budget: { softMs: 2000, hardMs: 4000 } });
    assert.equal(r.degraded, null, JSON.stringify(r.degraded));
    assert.match(r.joined.text, /roadmap review/i);
    assert.ok(seen.includes("capturing") && seen.includes("recalling") && seen.at(-1) === "idle", seen.join(","));
  });

  it("a capture slower than waitMs answers pending and is still stored (R19)", async () => {
    slowMs = 800; // only passage embedding (capture) is slowed; recall embeds the query without delay
    try {
      const cap = await c.call<any>("memory.capture", { caller, agentId: "bernd", sessionKey: "s3", waitMs: 200, messages: [{ role: "user", content: "Please remember that the dentist appointment is on Monday at nine." }, { role: "assistant", content: "Noted." }] });
      assert.equal(cap.pending, true, JSON.stringify(cap)); assert.equal(cap.stored, undefined);
      assert.match(await recallUntil(c, "when is the dentist appointment", /dentist appointment/i), /dentist appointment/i);
    } finally { slowMs = 0; }
  });

  it("closing the client right after a wait:true capture does not abort it (R19)", async () => {
    slowMs = 500;
    try {
      const c2 = await connect({ address: core.address, token: core.token });
      const pending = c2.call("memory.capture", { caller, agentId: "bernd", sessionKey: "s4", messages: [{ role: "user", content: "Please remember that the plumber visit is on Friday at noon." }, { role: "assistant", content: "Noted." }] }).catch((e) => e);
      await c2.close(); // disconnects while the capture is still embedding
      await pending;
      const c3 = await connect({ address: core.address, token: core.token });
      try { assert.match(await recallUntil(c3, "when is the plumber visit", /plumber visit/i), /plumber visit/i); } finally { await c3.close(); }
    } finally { slowMs = 0; }
  });

  it("recall for an unregistered agent is E_AGENT_UNKNOWN and creates nothing", async () => {
    await assert.rejects(c.call("memory.recall", { caller, agentId: "ghost", query: "x" }), (e: any) => e.error === "E_AGENT_UNKNOWN");
    assert.equal(existsSync(l.agentDir("ghost")), false);
  });

  it("an invalid caller identity comes back degraded, not as an error (R18)", async () => {
    const long = await c.call<any>("memory.recall", { caller: { ...caller, userId: "u".repeat(129) }, agentId: "bernd", query: "anything" });
    assert.equal(long.degraded?.reason, "principal-invalid");
    const control = await c.call<any>("memory.recall", { caller: { ...caller, userId: "cyber\u0001blade" }, agentId: "bernd", query: "anything" });
    assert.equal(control.degraded?.reason, "principal-invalid");
  });

  it("jobs.list has 18 jobs; jobs.run of a skipped job returns a JobRun; history lists it", async () => {
    const { jobs } = await c.call<any>("jobs.list"); assert.equal(jobs.length, 18);
    const run = await c.call<any>("jobs.run", { agentId: "bernd", job: "gc-run" });
    assert.equal(run.job, "gc-run"); assert.ok(["completed", "skipped"].includes(run.outcome), run.outcome);
    const { runs } = await c.call<any>("jobs.history", { agentId: "bernd" }); assert.ok(runs.some((x: any) => x.runId === run.runId));
  });

  it("core.status.jobs lists last runs after a job run (E4)", async () => {
    await c.call<any>("jobs.run", { agentId: "bernd", job: "gc-run" });
    // core.status serves the engine's status stale-while-revalidate (STATUS_CACHE_MS): poll until the run shows.
    let s: any; const until = Date.now() + 5000;
    do { s = await c.call<any>("core.status"); if (s.jobs?.agents?.[0]?.lastRuns?.["gc-run"]) break; await new Promise((r) => setTimeout(r, 100)); } while (Date.now() < until);
    assert.equal(s.jobs.ledger, "ok", JSON.stringify(s.jobs));
    const a = s.jobs.agents.find((x: any) => x.agentId === "bernd");
    assert.ok(a, JSON.stringify(s.jobs));
    assert.ok(["completed", "skipped"].includes(a.lastRuns["gc-run"].outcome), JSON.stringify(a));
    assert.equal(typeof a.lastRuns["gc-run"].finishedAt, "number");
    assert.equal(a.breakerOpen, false); assert.equal(a.unreadableLines, 0); assert.ok(Array.isArray(a.running));
  });

  it("agent.status reports the workspace; checkpoint returns a digest", async () => {
    const s = await c.call<any>("agent.status", { agentId: "bernd" }); assert.equal(s.workspace, l.workspaceDir("bernd"));
    const cp = await c.call<any>("memory.checkpoint", { caller, agentId: "bernd", reason: "manual" }); assert.equal(typeof cp.digest, "string");
  });

  it("a second core on the same home is refused by the lock; the first keeps answering", async () => {
    const second = createCore({ home, testInternals: flatTestInternals() });
    await assert.rejects(second.start(), (e: any) => e.error === "E_LOCKED");
    const s = await c.call<any>("core.status"); assert.equal(s.process.state, "ready");
    assert.equal(existsSync(l.coreToken), true, "the refused core leaves the first core's token alone");
  });
});

describe("core stop", () => {
  it("completes when the engine's close rejects: lock released, run files removed, stays stopped", async () => {
    const home = newHome(); const l = layout(home);
    const core = createCore({ home, testInternals: flatTestInternals({ extra: { closeEngine: async () => { throw new Error("close boom"); } } }) });
    await core.start();
    assert.equal(existsSync(l.coreToken), true);
    const first = core.stop({ budgetMs: 1000 });
    await first;
    assert.equal(core.status().process.state, "stopped");
    assert.equal(existsSync(l.coreToken), false); assert.equal(existsSync(l.corePid), false);
    const again = core.stop();
    assert.equal(again, first, "a second stop() returns the same promise");
    await again; assert.equal(core.status().process.state, "stopped");
    const next = createCore({ home, testInternals: flatTestInternals() });
    await next.start();
    await next.stop({ budgetMs: 5000 });
  });
});

describe("core start journal replay (I2)", () => {
  it("a line journaled while start() is replaying is captured before ready and counted in journalBacklog", async () => {
    const home = newHome(); const l = layout(home);
    const jline = (id: string, content: string) => ({ v: 1 as const, id, at: 1, agentId: "bernd", sessionKey: "s1", caller, messages: [{ role: "user" as const, content }, { role: "assistant" as const, content: "Noted." }] as [any, any] });
    appendJournalLine(l.journal, jline("11111111-1111-4111-8111-111111111111", "Please remember that the boiler service is on Tuesday at eight."));
    const core = createCore({ home, testInternals: flatTestInternals({ passageDelayMs: () => 400 }) });
    const started = core.start();
    // Wait until replay has renamed bernd.jsonl away (the first capture is embedding), then journal as the CLI would.
    const until = Date.now() + 10_000;
    while (!readdirSync(l.journal).some((f) => f.startsWith("bernd.jsonl.replaying-")) && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
    assert.ok(Date.now() < until, "replay never started");
    appendJournalLine(l.journal, jline("22222222-2222-4222-8222-222222222222", "Please remember that the chimney sweep comes on Wednesday at noon."));
    await started;
    const c = await connect({ address: core.address, token: core.token });
    try {
      assert.equal((await c.call<any>("core.status")).journalBacklog, 0);
      assert.equal(existsSync(join(l.journal, "bernd.jsonl")), false, "nothing stranded in the journal");
      const r = await c.call<any>("memory.recall", { caller, agentId: "bernd", query: "chimney sweep", joined: true });
      assert.match(r.joined.text, /chimney sweep/i);
    } finally { await c.close(); await core.stop({ budgetMs: 5000 }); }
  });
});

describe("core journal backlog (Task 15, E4)", () => {
  const jline = (id: string, content: string, agentId = "bernd") => ({ v: 1 as const, id, at: 1000, agentId, sessionKey: "s1", caller, messages: [{ role: "user" as const, content }, { role: "assistant" as const, content: "Noted." }] as [any, any] });

  it("core.status journalBacklog comes from the engine's journal status", async () => {
    const home = newHome(); const l = layout(home);
    // An unregistered agent's lines are kept by the replay.
    appendJournalLine(l.journal, jline("11111111-1111-4111-8111-111111111111", "one", "ghost"));
    appendJournalLine(l.journal, jline("22222222-2222-4222-8222-222222222222", "two", "ghost"));
    const core = createCore({ home, testInternals: flatTestInternals() });
    await core.start();
    const c = await connect({ address: core.address, token: core.token });
    try {
      assert.equal((await c.call<any>("core.status")).journalBacklog, 2);
      // A line that arrives after the replay is not in the replay's count; the engine's capability sees it.
      appendJournalLine(l.journal, jline("33333333-3333-4333-8333-333333333333", "three", "ghost"));
      let n = 0; const until = Date.now() + 5000;
      while (Date.now() < until) { n = (await c.call<any>("core.status")).journalBacklog; if (n === 3) break; await new Promise((r) => setTimeout(r, 100)); }
      assert.equal(n, 3);
    } finally { await c.close(); await core.stop({ budgetMs: 5000 }); }
  });

  it("a line replayed again after a crash between append-back and delete is a duplicate-turn, stored once", async () => {
    const home = newHome(); const l = layout(home);
    const text = "Please remember that the gutter cleaning is on Friday at nine.";
    const once = jline("44444444-4444-4444-8444-444444444444", text);
    appendJournalLine(l.journal, once);
    const first = createCore({ home, testInternals: flatTestInternals() });
    await first.start(); await first.stop({ budgetMs: 5000 });
    // The previous replay died after capturing: its `.replaying-<pid>` file survived with the same line.
    writeFileSync(join(l.journal, "bernd.jsonl.replaying-4242"), `${JSON.stringify(once)}\n`);
    const core = createCore({ home, testInternals: flatTestInternals() });
    await core.start();
    const c = await connect({ address: core.address, token: core.token });
    try {
      assert.equal((await c.call<any>("core.status")).journalBacklog, 0);
      assert.deepEqual(readdirSync(l.journal), [], "the duplicate line left the journal");
      const { items } = await c.call<any>("memory.list", { caller, agentId: "bernd", since: 0, limit: 100 });
      assert.equal(items.filter((x: any) => /gutter cleaning/.test(x.text)).length, 1, JSON.stringify(items.map((x: any) => x.text)));
    } finally { await c.close(); await core.stop({ budgetMs: 5000 }); }
  });
});

describe("core run files (S11)", () => {
  it("start() secures run/ and the token and pid files, even when run/ already existed wider", { skip: process.platform === "win32" }, async () => {
    const home = newHome(); const l = layout(home);
    mkdirSync(l.run, { recursive: true }); chmodSync(l.run, 0o755);
    const core = createCore({ home, testInternals: flatTestInternals() });
    await core.start();
    try {
      assert.equal(statSync(l.run).mode & 0o777, 0o700);
      assert.equal(statSync(l.coreToken).mode & 0o777, 0o600);
      assert.equal(statSync(l.corePid).mode & 0o777, 0o600);
    } finally { await core.stop({ budgetMs: 5000 }); }
  });
});

describe("core model warm-up (E4, S7)", () => {
  it("engine is models-warming until warm completes, process stays ready", async () => {
    const home = newHome(); let first = true;
    // The first embedQuery is the warm-up's embedding probe: it takes 300 ms, as a model load would.
    const core = createCore({ home, testInternals: flatTestInternals({ queryDelayMs: () => { const d = first ? 300 : 0; first = false; return d; } }) });
    await core.start();
    const c = await connect({ address: core.address, token: core.token });
    try {
      const s0 = await c.call<any>("core.status");
      assert.equal(s0.process.state, "ready");
      assert.equal(s0.engine.ready, false);
      assert.equal(s0.engine.degraded?.reason, "models-warming", JSON.stringify(s0.engine));
      await new Promise((r) => setTimeout(r, 600));
      const s1 = await c.call<any>("core.status");
      assert.equal(s1.process.state, "ready");
      assert.equal(s1.engine.ready, true, JSON.stringify(s1.engine));
      assert.equal(s1.engine.degraded, null);
      assert.equal(s1.engine.models.embedder.state, "ready");
      assert.equal(s1.engine.models.embedder.warming, false);
      assert.equal(typeof s1.engine.models.embedder.checkedAt, "number");
      assert.equal(s1.engine.models.reranker.state, "disabled"); // the flat seam has no reranker
    } finally { await c.close(); await core.stop({ budgetMs: 5000 }); }
  });

  it("core.status carries engine.sharedMemory (E4)", async () => {
    const home = newHome();
    const core = createCore({ home, testInternals: flatTestInternals() });
    await core.start();
    const c = await connect({ address: core.address, token: core.token });
    try {
      const s = await c.call<any>("core.status"); // sharedMemory is part of the eng.status() cached at start()
      if (process.platform === "linux") {
        assert.deepEqual(s.engine.sharedMemory, { supported: true, mode: "fd-capability" }, JSON.stringify(s.engine));
      } else {
        assert.deepEqual(s.engine.sharedMemory, { supported: false, mode: "unavailable", reason: "platform" }, JSON.stringify(s.engine));
      }
    } finally { await c.close(); await core.stop({ budgetMs: 5000 }); }
  });

  it("a failed embedder probe is model-failed and memory.recall still answers", async () => {
    const home = newHome(); const flat = flatEmbedder(); let first = true;
    // The first embedQuery is the warm-up's probe; it fails once, as a broken model load would. Later calls work.
    const embeddings = { ...flat, embedQuery: async () => { if (first) { first = false; throw new Error("synthetic model load failure"); } return flat.embedQuery(); } };
    const core = createCore({ home, testInternals: flatTestInternals({ extra: { embeddings } }) });
    await core.start();
    const c = await connect({ address: core.address, token: core.token });
    try {
      let s: any; const until = Date.now() + 5000;
      do { s = await c.call<any>("core.status"); if (s.engine.degraded?.reason === "model-failed") break; await new Promise((r) => setTimeout(r, 50)); } while (Date.now() < until);
      assert.equal(s.process.state, "ready");
      assert.equal(s.engine.ready, false);
      assert.deepEqual(s.engine.degraded, { reason: "model-failed", capability: "embedding" });
      assert.equal(s.engine.models.embedder.state, "failed");
      assert.equal(s.engine.models.embedder.error, "provider-failed");
      const r = await c.call<any>("memory.recall", { caller, agentId: "bernd", query: "anything about lunch", joined: true });
      assert.equal(typeof r.joined.text, "string");
    } finally { await c.close(); await core.stop({ budgetMs: 5000 }); }
  });
});
