import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
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

/** Every file under `dir` (relative path → "size:mtimeMs"), for before/after comparisons. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { const st = statSync(p); out[relative(dir, p)] = `${st.size}:${st.mtimeMs}`; }
    }
  };
  walk(dir);
  return out;
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

describe("core live capture then journal replay (Task 15 review, Q3)", () => {
  it("a live capture with runId journal:X, then a journal line with id X, is one card and the line is dropped", async () => {
    const home = newHome(); const l = layout(home);
    const id = "55555555-5555-4555-8555-555555555555";
    const text = "Please remember that the window cleaner comes on Monday at ten.";
    const messages = [{ role: "user" as const, content: text }] as [any];
    // As `plur1bus memory add` does: the live capture carries runId journal:<id>; a core that stores it and dies before
    // replying makes the CLI journal the same turn under the same id.
    const first = createCore({ home, testInternals: flatTestInternals() });
    await first.start();
    const c1 = await connect({ address: first.address, token: first.token });
    try {
      const r = await c1.call<any>("memory.capture", { caller, agentId: "bernd", sessionKey: "s1", runId: `journal:${id}`, messages, wait: true, waitMs: 10_000 });
      assert.equal(r.stored, 1, JSON.stringify(r));
    } finally { await c1.close(); await first.stop({ budgetMs: 5000 }); }
    appendJournalLine(l.journal, { v: 1, id, at: 1000, agentId: "bernd", sessionKey: "s1", caller, messages });
    const core = createCore({ home, testInternals: flatTestInternals() });
    await core.start();
    const c = await connect({ address: core.address, token: core.token });
    try {
      assert.deepEqual(readdirSync(l.journal), [], "the replayed line was a duplicate-turn and left the journal");
      const { items } = await c.call<any>("memory.list", { caller, agentId: "bernd", since: 0, limit: 100 });
      assert.equal(items.filter((x: any) => /window cleaner/.test(x.text)).length, 1, JSON.stringify(items.map((x: any) => x.text)));
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
  // H3-R22/R23: the models' probes alone leave the first recall cold (a real query embedding, the first table
  // search); a recall that pays that inside the core's 600 ms hard budget answers `aborted` even though its phases
  // look fast. The flat embedder stands in for a cold model: its first three embedQuery calls take 350 ms each (the
  // warm-up probe, the warm-up's memory.list, and the first of the two a recall makes). The read-only recall-path
  // warm-up absorbs one of them, which keeps the first client recall inside the budget (without it: 700 ms of
  // embedding in the first recall, aborted).
  it("the first memory.recall after engine.ready is not aborted: the recall-path warm-up absorbs the cold path (H3-R22/R23)", async () => {
    const home = newHome(); let calls = 0;
    const core = createCore({ home, testInternals: flatTestInternals({ queryDelayMs: () => (++calls <= 3 ? 350 : 0) }) });
    await core.start();
    const c = await connect({ address: core.address, token: core.token });
    try {
      let s: any; const until = Date.now() + 8000;
      do { s = await c.call<any>("core.status"); if (s.engine.ready) break; await new Promise((r) => setTimeout(r, 50)); } while (Date.now() < until);
      assert.equal(s.engine.ready, true, JSON.stringify(s.engine));
      assert.equal(calls, 2, `the warm-up's memory.list embedded the query before engine.ready (embedQuery calls: ${calls})`);
      const r = await c.call<any>("memory.recall", { caller, agentId: "bernd", query: "when is the roadmap review", joined: true, budget: { hardMs: 600, softMs: 400 } });
      assert.equal(r.degraded, null, `first recall: ${JSON.stringify(r.degraded)} timing ${JSON.stringify(r.timing)}`);
    } finally { await c.close(); await core.stop({ budgetMs: 5000 }); }
  });

  it("engine is models-warming (capability recall) while the recall-path warm-up runs, and it emits nothing", async () => {
    const home = newHome(); let calls = 0;
    // Probe fast, then the warm-up's memory.list embedding takes 400 ms: the models are ready, the recall path is not.
    const core = createCore({ home, testInternals: flatTestInternals({ queryDelayMs: () => (++calls === 2 ? 400 : 0) }) });
    await core.start();
    const c = await connect({ address: core.address, token: core.token });
    const got: string[] = []; c.onNotification((m) => got.push(m));
    try {
      await c.call("events.subscribe", {});
      let s: any; const until = Date.now() + 5000;
      do { s = await c.call<any>("core.status"); if (s.engine.degraded?.capability === "recall") break; await new Promise((r) => setTimeout(r, 20)); } while (Date.now() < until);
      assert.deepEqual(s.engine.degraded, { reason: "models-warming", capability: "recall" });
      assert.equal(s.engine.ready, false);
      assert.equal(s.engine.models.embedder.state, "ready");
      assert.deepEqual(s.agents.map((a: any) => a.activity.state), ["idle"], "the warm-up is not agent activity");
      const until2 = Date.now() + 5000;
      do { s = await c.call<any>("core.status"); if (s.engine.ready) break; await new Promise((r) => setTimeout(r, 50)); } while (Date.now() < until2);
      assert.equal(s.engine.ready, true); assert.equal(s.engine.degraded, null);
      assert.equal(got.some((m) => m.startsWith("recall.") || m === "agent.activity" || m === "engine.event"), false, JSON.stringify(got));
    } finally { await c.close(); await core.stop({ budgetMs: 5000 }); }
  });

  // H3-R23: a user-origin recall presents due reminders, records activity (run-state.json) and writes mood/neo state
  // into the agent workspace; the warm-up must do none of it. The control (a real recall afterwards) proves the
  // snapshot sees those writes.
  it("the warm-up leaves the agent workspace untouched: activity, pending reminders, mood files (H3-R23)", async () => {
    const home = newHome(); const l = layout(home); let first = true;
    mkdirSync(l.workspaceDir("bernd"), { recursive: true, mode: 0o700 });
    const ws = realpathSync(l.workspaceDir("bernd"));
    // lib/reminder-pending.js: keyed by the workspace path the engine is given (the layout path, not its realpath).
    const wsKey = l.workspaceDir("bernd").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
    const pendingFile = join(ws, ".adaptive-learning", "reminders", wsKey, "bernd", "pending-reminders.json");
    mkdirSync(dirname(pendingFile), { recursive: true });
    const pending = JSON.stringify({ pending: { "r-1": { id: "r-1", reminderKey: "r-1", text: "water the plants", remindAt: Date.now() - 3_600_000 } } });
    writeFileSync(pendingFile, pending);
    // The probe takes 300 ms, so the snapshot below is taken before the warm-up's memory.list runs.
    const core = createCore({ home, testInternals: flatTestInternals({ queryDelayMs: () => { const d = first ? 300 : 0; first = false; return d; } }) });
    await core.start();
    const before = snapshot(ws);
    const c = await connect({ address: core.address, token: core.token });
    const got: string[] = []; c.onNotification((m) => got.push(m));
    try {
      await c.call("events.subscribe", {});
      let s: any; const until = Date.now() + 8000;
      do { s = await c.call<any>("core.status"); if (s.engine.ready) break; await new Promise((r) => setTimeout(r, 50)); } while (Date.now() < until);
      assert.equal(s.engine.ready, true, JSON.stringify(s.engine));
      const after = snapshot(ws);
      assert.deepEqual(after, before, "the warm-up changed the agent workspace");
      assert.equal(readFileSync(pendingFile, "utf8"), pending, "pending reminders unchanged");
      for (const f of ["run-state.json", ".current-mood.txt", ".emotional-state.json"]) assert.equal(after[f], before[f], f);
      assert.equal(got.some((m) => m.startsWith("recall.")), false, JSON.stringify(got));
      // Control: a client recall does write the workspace (activity) and presents the due reminder.
      const r = await c.call<any>("memory.recall", { caller, agentId: "bernd", query: "anything due today", joined: true });
      assert.notDeepEqual(snapshot(ws), before, "a real recall writes the workspace (the snapshot would see a warm-up's writes)");
      assert.match(r.joined.text, /water the plants/);
    } finally { await c.close(); await core.stop({ budgetMs: 5000 }); }
  });

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
