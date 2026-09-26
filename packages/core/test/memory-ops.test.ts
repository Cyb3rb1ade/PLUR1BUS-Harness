import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type CoreClient } from "@plur1bus/module-api";
import { defaults } from "@plur1bus/config-schema";
import { validateParams } from "@plur1bus/rpc-schema";
import { createCore, type Core } from "../src/core.ts";
import { MEMORY_OP_METHODS } from "../src/memory-ops.ts";
import { layout } from "../src/paths.ts";
import { flatTestInternals } from "./helpers/flat-embedder.ts";

const caller = { channel: "cli" as const, accountId: "macbooker", userId: "cyberblade" };
const badCaller = { ...caller, userId: "u".repeat(129) };

function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), "p1b-memops-"));
  const cfg = defaults(); cfg.agents.bernd = {}; cfg.agents.anna = {};
  cfg.engine = { neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false }, merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false }, temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false }, reranker: { enabled: false }, runtime: { recallTimeoutMs: 10_000 } };
  // Several distinct facts with the flat embedder: disable capture dedup (see core.test.ts).
  cfg.engine.duplicateThreshold = 1.01;
  writeFileSync(layout(home).configPath, JSON.stringify(cfg));
  return home;
}

const rejectsWith = (error: string, reason?: string) => (e: any) => {
  assert.equal(e.error, error, `${e.error} ${e.reason}: ${e.message}`);
  if (reason !== undefined) assert.equal(e.reason, reason, e.message);
  return true;
};

describe("memory ops (in-process core)", () => {
  const home = newHome();
  let core: Core; let c: CoreClient;
  before(async () => {
    core = createCore({ home, testInternals: flatTestInternals() });
    await core.start();
    c = await connect({ address: core.address, token: core.token });
  });
  after(async () => { await c?.close(); await core?.stop({ budgetMs: 5000 }); });

  const list = async (agentId: string, who = caller) => c.call<any>("memory.list", { caller: who, agentId, since: 0 });
  const ids = async (agentId: string) => new Set<string>((await list(agentId)).items.map((x: any) => x.id));
  /** Captures one fact for the agent and returns the id of the card it added. */
  async function capture(agentId: string, content: string): Promise<string> {
    const before = await ids(agentId);
    const r = await c.call<any>("memory.capture", { caller, agentId, messages: [{ role: "user", content }, { role: "assistant", content: "Noted." }], wait: true, waitMs: 10_000 });
    assert.ok(r.stored >= 1, JSON.stringify(r));
    const added = [...(await ids(agentId))].filter((id) => !before.has(id));
    assert.equal(added.length, 1, `expected one new card, got ${added.length}`);
    return added[0]!;
  }

  it("list since 0 returns both captured cards newest first; show resolves each id", async () => {
    await capture("bernd", "Please remember that the roadmap review is on Thursday at ten.");
    await new Promise((r) => setTimeout(r, 5)); // distinct createdAt
    await capture("bernd", "Please remember that the office plants need water on Mondays.");
    const r = await list("bernd");
    assert.equal(r.agentId, "bernd"); assert.equal(r.truncated, false); assert.equal("degraded" in r, false);
    assert.equal(r.items.length, 2);
    assert.ok(r.items[0].createdAt >= r.items[1].createdAt);
    for (const item of r.items) {
      const { card } = await c.call<any>("memory.show", { caller, agentId: "bernd", id: item.id });
      assert.equal(card.id, item.id); assert.equal(card.text, item.text); assert.equal(card.scope, "agent-private");
    }
  });

  it("correct returns a new live id and the old id is E_NOT_FOUND", async () => {
    const id = await capture("bernd", "Please remember that the team lunch is on Friday.");
    const r = await c.call<any>("memory.correct", { caller, agentId: "bernd", id, text: "The team lunch is on Wednesday." });
    assert.equal(r.archived, true); assert.notEqual(r.id, id);
    const { card } = await c.call<any>("memory.show", { caller, agentId: "bernd", id: r.id });
    assert.match(card.text, /Wednesday/);
    await assert.rejects(c.call("memory.show", { caller, agentId: "bernd", id }), rejectsWith("E_NOT_FOUND", "not-found"));
  });

  it("forget archives; a second forget answers alreadyForgotten; state counts drop by one", async () => {
    const id = await capture("bernd", "Please remember that the parking garage closes at eight.");
    const s0 = await c.call<any>("memory.state", { caller, agentId: "bernd" });
    assert.equal(s0.agentId, "bernd"); assert.equal(typeof s0.archiveDir, "string"); assert.equal("degraded" in s0, false);
    const f1 = await c.call<any>("memory.forget", { caller, agentId: "bernd", id });
    assert.equal(f1.id, id); assert.equal(f1.archived, true); assert.equal(f1.alreadyForgotten, false);
    const f2 = await c.call<any>("memory.forget", { caller, agentId: "bernd", id });
    assert.equal(f2.alreadyForgotten, true);
    const s1 = await c.call<any>("memory.state", { caller, agentId: "bernd" });
    assert.equal(s1.cards.agentPrivate, s0.cards.agentPrivate - 1);
  });

  let sharedId = "";
  it("bernd shares to user; anna lists the copy with sharedBy bernd; anna's forget and correct of the copy are E_DENIED", async () => {
    const id = await capture("bernd", "Please remember that the release freeze starts on the fifteenth.");
    const s = await c.call<any>("memory.share", { caller, agentId: "bernd", id, target: "user" });
    assert.equal(s.sourceId, id); assert.equal(s.target, "user"); sharedId = s.sharedId;
    const copy = (await list("anna")).items.find((x: any) => x.id === sharedId);
    assert.ok(copy, "anna sees the shared copy");
    assert.equal(copy.scope, "user"); assert.equal(copy.sharedBy, "bernd"); assert.equal(copy.sourceId, id);
    await assert.rejects(c.call("memory.forget", { caller, agentId: "anna", id: sharedId }), rejectsWith("E_DENIED", "denied"));
    await assert.rejects(c.call("memory.correct", { caller, agentId: "anna", id: sharedId, text: "The release freeze starts on the tenth." }), rejectsWith("E_DENIED", "denied"));
  });

  it("anna proposes; both list it pending; bernd accepts; anna sees accepted with resultId; a second proposal is rejected with a note", async () => {
    assert.ok(sharedId, "depends on the share test");
    const pr = await c.call<any>("memory.propose", { caller, agentId: "anna", sharedId, text: "The release freeze starts on the twentieth.", note: "moved in the planning call" });
    assert.equal(pr.sharedId, sharedId); assert.equal(pr.sharerAgentId, "bernd");
    for (const agentId of ["anna", "bernd"]) {
      const l = await c.call<any>("memory.proposals.list", { caller, agentId, status: "pending" });
      const p = l.items.find((x: any) => x.id === pr.proposalId);
      assert.ok(p, `${agentId} lists the proposal`);
      assert.equal(p.status, "pending"); assert.equal(p.proposerAgentId, "anna"); assert.equal(p.note, "moved in the planning call");
      assert.equal(l.unreadable, 0);
    }
    const acc = await c.call<any>("memory.proposals.accept", { caller, agentId: "bernd", proposalId: pr.proposalId });
    assert.equal(acc.proposalId, pr.proposalId); assert.equal(typeof acc.id, "string"); assert.equal(typeof acc.sourceId, "string");
    const seen = (await c.call<any>("memory.proposals.list", { caller, agentId: "anna" })).items.find((x: any) => x.id === pr.proposalId);
    assert.equal(seen.status, "accepted"); assert.equal(seen.resultId, acc.id);

    const pr2 = await c.call<any>("memory.propose", { caller, agentId: "anna", sharedId: acc.id, text: "The release freeze starts on the first." });
    const rej = await c.call<any>("memory.proposals.reject", { caller, agentId: "bernd", proposalId: pr2.proposalId, note: "the date is fixed" });
    assert.deepEqual(rej, { proposalId: pr2.proposalId, status: "rejected" });
    const seen2 = (await c.call<any>("memory.proposals.list", { caller, agentId: "anna", status: "rejected" })).items.find((x: any) => x.id === pr2.proposalId);
    assert.equal(seen2.resolutionNote, "the date is fixed");
  });

  it("accept by the proposer is E_NOT_FOUND (anti-oracle)", async () => {
    const id = await capture("bernd", "Please remember that the demo day is in March.");
    const { sharedId: copy } = await c.call<any>("memory.share", { caller, agentId: "bernd", id, target: "user" });
    const pr = await c.call<any>("memory.propose", { caller, agentId: "anna", sharedId: copy, text: "The demo day is in April." });
    await assert.rejects(c.call("memory.proposals.accept", { caller, agentId: "anna", proposalId: pr.proposalId }), rejectsWith("E_NOT_FOUND", "not-found"));
  });

  it("topic with since is E_INVALID_PARAMS topic-xor-since; a whitespace-only correct text is E_INVALID_PARAMS reason invalid-input", async () => {
    const base = { caller, agentId: "bernd" };
    await assert.rejects(c.call("memory.list", { ...base, topic: "roadmap", since: 0 }), rejectsWith("E_INVALID_PARAMS", "topic-xor-since"));
    await assert.rejects(c.call("memory.list", base), rejectsWith("E_INVALID_PARAMS", "topic-xor-since"));
    await assert.rejects(c.call("memory.list", { ...base, topic: "roadmap", until: 1 }), rejectsWith("E_INVALID_PARAMS", "topic-xor-since"));
    await assert.rejects(c.call("memory.list", { ...base, until: Date.now() }), rejectsWith("E_INVALID_PARAMS", "topic-xor-since"));
    const topical = await c.call<any>("memory.list", { ...base, topic: "roadmap" });
    assert.ok(Array.isArray(topical.items));
    const id = (await list("bernd")).items.find((x: any) => x.scope === "agent-private").id;
    await assert.rejects(c.call("memory.correct", { ...base, id, text: "   " }), rejectsWith("E_INVALID_PARAMS", "invalid-input"));
  });

  it("an invalid caller identity degrades reads and refuses writes", async () => {
    const r = await list("bernd", badCaller);
    assert.equal(r.degraded?.reason, "principal-invalid"); assert.equal(r.degraded?.capability, "identity");
    const st = await c.call<any>("memory.state", { caller: badCaller, agentId: "bernd" });
    assert.equal(st.degraded?.reason, "principal-invalid");
    const id = (await list("bernd")).items.find((x: any) => x.scope === "agent-private").id;
    const shown = await c.call<any>("memory.show", { caller: badCaller, agentId: "bernd", id });
    assert.equal(shown.degraded?.reason, "principal-invalid");
    await assert.rejects(c.call("memory.forget", { caller: badCaller, agentId: "bernd", id }), rejectsWith("E_DENIED", "principal-invalid"));
    for (const [m, extra] of [["memory.correct", { id, text: "changed" }], ["memory.share", { id, target: "user" }], ["memory.propose", { sharedId: id, text: "changed" }],
      ["memory.proposals.accept", { proposalId: "p-1" }], ["memory.proposals.reject", { proposalId: "p-1" }]] as const) {
      await assert.rejects(c.call(m, { caller: badCaller, agentId: "bernd", ...extra }), rejectsWith("E_DENIED", "principal-invalid"), m);
    }
    const { card } = await c.call<any>("memory.show", { caller, agentId: "bernd", id });
    assert.equal(card.id, id);
  });

  it("every memory op for an unregistered agent is E_AGENT_UNKNOWN", async () => {
    const extra: Record<string, object> = {
      "memory.list": { since: 0 }, "memory.show": { id: "m-1" }, "memory.forget": { id: "m-1" }, "memory.correct": { id: "m-1", text: "fixed" },
      "memory.share": { id: "m-1", target: "workspace" }, "memory.state": {}, "memory.propose": { sharedId: "m-copy", text: "fixed" },
      "memory.proposals.list": {}, "memory.proposals.accept": { proposalId: "p-1" }, "memory.proposals.reject": { proposalId: "p-1" },
    };
    assert.deepEqual(Object.keys(extra).sort(), [...MEMORY_OP_METHODS].sort());
    for (const m of MEMORY_OP_METHODS) {
      const params = { caller, agentId: "ghost", ...extra[m] };
      assert.ok(validateParams(m, params).ok, m);
      await assert.rejects(c.call(m, params), rejectsWith("E_AGENT_UNKNOWN", "not-registered"), m);
    }
  });

  it("core.auth features include memory.ops and memory.proposals", () => {
    const f = c.hello.capabilities?.features ?? [];
    assert.ok(f.includes("memory.ops") && f.includes("memory.proposals"), f.join(","));
  });
});
