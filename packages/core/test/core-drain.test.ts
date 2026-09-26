import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@plur1bus/module-api";
import { defaults } from "@plur1bus/config-schema";
import { createCore } from "../src/core.ts";
import { layout } from "../src/paths.ts";
import { flatTestInternals } from "./helpers/flat-embedder.ts";

// G17: shutdown drains in-flight memory ops before it closes the sockets. Windows-safe: every stop is an in-process
// core.stop(), never a signal. The embedder delay holds the op inside the engine; stop() begins while it is held.

const caller = { channel: "cli" as const, accountId: "macbooker", userId: "cyberblade" };
const BUDGET_MS = 5_000;
const HOLD_MS = 600;
const STOP_AFTER_MS = 50;

function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), "p1b-drain-"));
  const cfg = defaults(); cfg.agents.bernd = {};
  cfg.engine = { neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false }, merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false }, temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false }, reranker: { enabled: false }, runtime: { recallTimeoutMs: 10_000 } };
  cfg.engine.duplicateThreshold = 1.01;
  writeFileSync(layout(home).configPath, JSON.stringify(cfg));
  return home;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** An embedder hold: `delayMs` is the queryDelayMs seam; `entered` resolves once the held op is inside the embedder.
 *  Waiting on `entered` (not a wall-clock guess) keeps the premise true under load: memory.correct checks the engine's
 *  closing flag right before it mutates, so a stop that lands before the op reaches the embedder refuses it instead. */
function embedHold(ms: number) {
  let armed = false; let enter!: () => void;
  const entered = new Promise<void>((res) => { enter = res; });
  return {
    delayMs: () => { if (!armed) return 0; enter(); return ms; },
    arm: () => { armed = true; }, disarm: () => { armed = false; }, entered,
  };
}
/** Tracks whether a call has settled, so a test can assert its premise: stop() began while the op was still held. */
function tracked<T>(p: Promise<T>): { p: Promise<T>; settled: () => boolean } {
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  return { p, settled: () => done };
}

describe("core stop drains in-flight memory ops (G17)", () => {
  it("a memory.list in flight when stop begins gets its result, not a closed connection", async () => {
    const home = newHome();
    const hold = embedHold(HOLD_MS);
    const core = createCore({ home, testInternals: flatTestInternals({ queryDelayMs: hold.delayMs }) });
    await core.start();
    const c = await connect({ address: core.address, token: core.token });
    try {
      hold.arm();
      const list = tracked(c.call<any>("memory.list", { caller, agentId: "bernd", topic: "x" }));
      await hold.entered; await sleep(STOP_AFTER_MS);
      assert.equal(list.settled(), false, "premise: the list is still held in the embedder when stop begins");
      const stopped = core.stop({ budgetMs: BUDGET_MS });
      const r = await list.p;
      assert.ok(Array.isArray(r.items), JSON.stringify(r));
      await stopped;
      assert.equal(core.status().process.state, "stopped");
    } finally { await c.close(); await core.stop({ budgetMs: BUDGET_MS }); }
  });

  it("a memory op sent after stop began answers E_CORE_UNAVAILABLE core-stopping", async () => {
    const home = newHome();
    const hold = embedHold(HOLD_MS);
    const core = createCore({ home, testInternals: flatTestInternals({ queryDelayMs: hold.delayMs }) });
    await core.start();
    const c1 = await connect({ address: core.address, token: core.token });
    const c2 = await connect({ address: core.address, token: core.token }); // connected before stop begins
    try {
      hold.arm();
      const list = tracked(c1.call<any>("memory.list", { caller, agentId: "bernd", topic: "x" }));
      await hold.entered; await sleep(STOP_AFTER_MS);
      assert.equal(list.settled(), false, "premise: the list is still in flight when stop begins");
      const stopped = core.stop({ budgetMs: BUDGET_MS });
      await assert.rejects(c2.call("memory.state", { caller, agentId: "bernd" }), (e: any) => {
        assert.equal(e.error, "E_CORE_UNAVAILABLE", `${e.error} ${e.reason}: ${e.message}`);
        assert.equal(e.reason, "core-stopping");
        return true;
      });
      assert.equal(list.settled(), false, "premise: the refusal arrived while the list was still in flight");
      assert.ok(Array.isArray((await list.p).items), "the in-flight list still answers");
      await stopped;
    } finally { await c1.close(); await c2.close(); await core.stop({ budgetMs: BUDGET_MS }); }
  });

  it("a correct in flight when stop begins completes and survives restart", async () => {
    const home = newHome();
    const hold = embedHold(HOLD_MS);
    // memory.correct re-embeds the new text through `embed` (engine memory-ops/write.js), so queryDelayMs holds it;
    // passageDelayMs would not (measured: ~60 ms with a 600 ms passage delay).
    const internals = () => flatTestInternals({ queryDelayMs: hold.delayMs });
    const core = createCore({ home, testInternals: internals() });
    await core.start();
    const c = await connect({ address: core.address, token: core.token });
    let newId: string;
    try {
      const cap = await c.call<any>("memory.capture", { caller, agentId: "bernd", messages: [{ role: "user", content: "Please remember that the team lunch is on Friday." }, { role: "assistant", content: "Noted." }], wait: true, waitMs: 10_000 });
      assert.ok(cap.stored >= 1, JSON.stringify(cap));
      const { items } = await c.call<any>("memory.list", { caller, agentId: "bernd", since: 0 });
      assert.equal(items.length, 1);
      hold.arm();
      const correct = tracked(c.call<any>("memory.correct", { caller, agentId: "bernd", id: items[0].id, text: "The team lunch is on Wednesday." }));
      await hold.entered; await sleep(STOP_AFTER_MS);
      assert.equal(correct.settled(), false, "premise: the correct is still held in the embedder when stop begins");
      const stopped = core.stop({ budgetMs: BUDGET_MS });
      const r = await correct.p;
      assert.equal(r.archived, true); assert.notEqual(r.id, items[0].id);
      newId = r.id;
      await stopped;
    } finally { await c.close(); await core.stop({ budgetMs: BUDGET_MS }); }

    hold.disarm();
    const next = createCore({ home, testInternals: internals() });
    await next.start();
    const c2 = await connect({ address: next.address, token: next.token });
    try {
      const { card } = await c2.call<any>("memory.show", { caller, agentId: "bernd", id: newId });
      assert.match(card.text, /Wednesday/);
    } finally { await c2.close(); await next.stop({ budgetMs: BUDGET_MS }); }
  });
});
