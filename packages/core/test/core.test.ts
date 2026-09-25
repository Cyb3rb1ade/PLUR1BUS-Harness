import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type CoreClient } from "@plur1bus/module-api";
import { defaults } from "@plur1bus/config-schema";
import { createCore, type Core } from "../src/core.ts";
import { layout } from "../src/paths.ts";
import { flatEmbedder } from "./helpers/flat-embedder.ts";

const caller = { channel: "cli" as const, accountId: "macbooker", userId: "cyberblade" };

describe("core", () => {
  const home = mkdtempSync(join(tmpdir(), "p1b-core-"));
  const l = layout(home);
  let core: Core; let c: CoreClient;
  before(async () => {
    const cfg = defaults(); cfg.agents.bernd = {};
    cfg.engine = { neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false }, merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false }, temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false }, reranker: { enabled: false }, runtime: { recallTimeoutMs: 10_000 } };
    writeFileSync(l.configPath, JSON.stringify(cfg));
    core = createCore({ home, testInternals: { embeddings: flatEmbedder() } });
    await core.start();
    c = await connect({ address: core.address, token: core.token });
  });
  after(async () => { await c?.close(); await core?.stop({ budgetMs: 5000 }); });

  it("core.status is ready with the registered agent idle and the real contract", async () => {
    const s = await c.call<any>("core.status");
    assert.equal(s.process.state, "ready"); assert.equal(s.contract, "1.4.1"); assert.equal(s.rpc, "1.0.0");
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

  it("recall for an unregistered agent is E_AGENT_UNKNOWN and creates nothing", async () => {
    await assert.rejects(c.call("memory.recall", { caller, agentId: "ghost", query: "x" }), (e: any) => e.error === "E_AGENT_UNKNOWN");
    assert.equal(existsSync(l.agentDir("ghost")), false);
  });

  it("an invalid caller identity comes back degraded, not as an error", async () => {
    // The schema admits control characters in userId; the principal mapping (engine INPUT_LIMITS parity) does not.
    const r = await c.call<any>("memory.recall", { caller: { ...caller, userId: "cyber\u0001blade" }, agentId: "bernd", query: "anything" });
    assert.equal(r.degraded?.reason, "principal-invalid");
    // An over-long userId never reaches the core's principal mapping: CallerIdentity.userId maxLength 128 rejects it at the wire.
    await assert.rejects(c.call("memory.recall", { caller: { ...caller, userId: "u".repeat(129) }, agentId: "bernd", query: "anything" }), (e: any) => e.error === "E_INVALID_PARAMS");
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

  it("a second core on the same home is refused by the lock", async () => {
    const second = createCore({ home, testInternals: { embeddings: flatEmbedder() } });
    await assert.rejects(second.start(), (e: any) => e.error === "E_LOCKED");
  });
});
