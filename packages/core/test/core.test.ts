import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type CoreClient } from "@plur1bus/module-api";
import { defaults } from "@plur1bus/config-schema";
import { createCore, type Core } from "../src/core.ts";
import { appendJournalLine } from "../src/journal.ts";
import { layout } from "../src/paths.ts";
import { flatTestInternals } from "./helpers/flat-embedder.ts";

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
    assert.equal(s.process.state, "ready"); assert.equal(s.contract, "1.6.0"); assert.equal(s.rpc, "1.0.0");
    assert.deepEqual(s.agents.map((a: any) => [a.agentId, a.activity.state]), [["bernd", "idle"]]);
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

  it("memory ops answer E_NOT_AVAILABLE engine-pr-E1", async () => {
    for (const m of ["memory.list", "memory.show", "memory.forget", "memory.correct", "memory.share", "memory.state"]) {
      await assert.rejects(c.call(m, { caller, agentId: "bernd" }), (e: any) => e.error === "E_NOT_AVAILABLE" && e.reason === "engine-pr-E1", m);
    }
  });

  it("jobs.list has 18 jobs; jobs.run of a skipped job returns a JobRun; history lists it", async () => {
    const { jobs } = await c.call<any>("jobs.list"); assert.equal(jobs.length, 18);
    const run = await c.call<any>("jobs.run", { agentId: "bernd", job: "gc-run" });
    assert.equal(run.job, "gc-run"); assert.ok(["completed", "skipped"].includes(run.outcome), run.outcome);
    const { runs } = await c.call<any>("jobs.history", { agentId: "bernd" }); assert.ok(runs.some((x: any) => x.runId === run.runId));
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
