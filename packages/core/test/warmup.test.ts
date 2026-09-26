import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type * as E from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import type { HarnessLogger } from "../src/logger.ts";
import { WARMUP_QUERY, projectModels, startWarmup } from "../src/warmup.ts";

type Line = [level: string, msg: string, fields: Record<string, unknown> | undefined];
function recordingLogger(lines: Line[]): HarnessLogger {
  const at = (level: string) => (msg: string, fields?: Record<string, unknown>) => { lines.push([level, msg, fields]); };
  const l: HarnessLogger = { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error"), child: () => l, setLevel: () => {}, close: async () => {} };
  return l;
}

const identity: E.EmbeddingIdentity = { fingerprintId: "fp-1", provider: "local-transformers", model: "e5-small", dimensions: 384 };
function models(embedder: E.ModelState, reranker: E.ModelState, extra: Partial<E.ModelReadiness> = {}): E.ModelsStatus {
  return {
    embedder: { state: embedder, warming: false, checkedAt: embedder === "loading" ? null : 1_000, identity, ...extra },
    reranker: { state: reranker, warming: false, checkedAt: reranker === "ready" ? 1_001 : null, provider: reranker === "disabled" ? null : "local-transformers" },
  };
}
const fakeEngine = (warm: E.ModelsService["warm"]) => ({ models: { status: () => models("loading", "loading"), warm } }) as unknown as E.Engine;

describe("warmup", () => {
  it("calls models.warm once with the shutdown signal and reports the result", async () => {
    const lines: Line[] = []; const calls: Array<{ signal?: AbortSignal; refresh?: boolean } | undefined> = [];
    const shutdown = new AbortController(); const done: E.ModelsStatus[] = [];
    const w = startWarmup({
      engine: fakeEngine(async (opts) => { calls.push(opts); return models("ready", "ready"); }),
      logger: recordingLogger(lines), signal: shutdown.signal, onDone: (m) => done.push(m),
    });
    await w.done;
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.signal?.aborted, false);
    shutdown.abort(); // the signal handed to warm() follows the shutdown signal
    assert.equal(calls[0]!.signal?.aborted, true);
    assert.equal(done.length, 1); assert.equal(done[0]!.embedder.state, "ready");
    const info = lines.find(([lvl, msg]) => lvl === "info" && msg === "models warm");
    assert.ok(info, JSON.stringify(lines));
    assert.equal(info[2]!.embedder, "ready"); assert.equal(info[2]!.reranker, "ready"); assert.equal(typeof info[2]!.ms, "number");
  });

  it("abort ends the wait without throwing", async () => {
    const lines: Line[] = []; const done: E.ModelsStatus[] = [];
    const w = startWarmup({
      engine: fakeEngine((opts) => new Promise((_, reject) => opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))),
      logger: recordingLogger(lines), signal: new AbortController().signal, onDone: (m) => done.push(m),
    });
    w.abort();
    await w.done; // resolves, never rejects
    assert.deepEqual(done, []);
    assert.ok(lines.some(([lvl]) => lvl === "debug"), JSON.stringify(lines));
    assert.equal(lines.some(([lvl]) => lvl === "error" || lvl === "warn"), false, JSON.stringify(lines));
  });

  it("a closed engine's rejection is logged at debug and never thrown", async () => {
    const lines: Line[] = [];
    const w = startWarmup({
      engine: fakeEngine(async () => { throw Object.assign(new Error("engine is closed"), { name: "MemoryOpError", code: "storage" }); }),
      logger: recordingLogger(lines), signal: new AbortController().signal, onDone: () => assert.fail("onDone after a rejection"),
    });
    await w.done;
    assert.ok(lines.some(([lvl, msg]) => lvl === "debug" && /warm/.test(msg)), JSON.stringify(lines));
  });

  it("after the embedder is ready, warms each agent's recall path with memory.list and the reranker once, never recall (H3-R23)", async () => {
    const lines: Line[] = []; const order: string[] = []; const rerankSignals: AbortSignal[] = [];
    const shutdown = new AbortController();
    const engine = {
      models: { status: () => models("loading", "loading"), warm: async () => { order.push("warm"); return models("ready", "ready"); } },
      recall: () => assert.fail("the warm-up must never call engine.recall"),
      memory: {
        list: async (q: any, p: any, a: any) => {
          order.push(`list:${p.agentId}:${q.topic}:${q.limit}:${a.origin}`);
          if (p.agentId === "ghost") throw new Error("synthetic list failure");
          return { agentId: p.agentId, items: [{ id: "m-1" }], truncated: true };
        },
      },
      embedding: { rerank: async (q: string, docs: string[], o: any) => { order.push(`rerank:${docs.length}:${o.topN}`); rerankSignals.push(o.signal); return []; } },
    } as unknown as E.Engine;
    const w = startWarmup({
      engine, logger: recordingLogger(lines), signal: shutdown.signal, onDone: () => order.push("onDone"),
      recallPath: { agents: () => ["bernd", "ghost", "nobody", "anna"], principal: (agentId) => (agentId === "nobody" ? null : ({ agentId } as unknown as E.Principal)) },
      onRecallDone: () => order.push("onRecallDone"),
    });
    await w.done;
    // One rerank for the whole pass (a remote reranker bills per call), after the agents' lists.
    assert.deepEqual(order, ["warm", "onDone", `list:bernd:${WARMUP_QUERY}:1:user`, `list:ghost:${WARMUP_QUERY}:1:user`, `list:anna:${WARMUP_QUERY}:1:user`, "rerank:2:1", "onRecallDone"]);
    const warm = lines.filter(([lvl, msg]) => lvl === "info" && msg === "recall path warm");
    assert.deepEqual(warm.map(([, , f]) => [f!.agentId, f!.items, f!.truncated, f!.timedOut, typeof f!.ms]), [["bernd", 1, true, false, "number"], ["anna", 1, true, false, "number"]]);
    assert.equal(lines.filter(([lvl, msg]) => lvl === "info" && msg === "reranker warm").length, 1);
    assert.ok(lines.some(([lvl, msg, f]) => lvl === "debug" && msg === "recall warm-up failed" && f!.agentId === "ghost"), JSON.stringify(lines));
    assert.equal(rerankSignals[0]!.aborted, false);
    shutdown.abort(); // the rerank's signal follows the shutdown signal (and its own timeout)
    assert.equal(rerankSignals[0]!.aborted, true);
  });

  it("skips the rerank when the reranker is disabled, and the pass when the embedder is not ready", async () => {
    for (const [embedder, want] of [["ready", ["list", "onRecallDone"]], ["failed", ["onRecallDone"]]] as const) {
      const order: string[] = [];
      const engine = {
        models: { status: () => models("loading", "loading"), warm: async () => models(embedder, "disabled", embedder === "failed" ? { error: "provider-failed" } : {}) },
        memory: { list: async () => { order.push("list"); return { items: [], truncated: false }; } },
        embedding: { rerank: async () => { order.push("rerank"); return []; } },
      } as unknown as E.Engine;
      const w = startWarmup({
        engine, logger: recordingLogger([]), signal: new AbortController().signal, onDone: () => {},
        recallPath: { agents: () => ["bernd"], principal: (agentId) => ({ agentId } as unknown as E.Principal) },
        onRecallDone: () => order.push("onRecallDone"),
      });
      await w.done;
      assert.deepEqual(order, want, embedder);
    }
  });

  it("a hung memory.list ends at the per-agent timeout; an abort ends the pass; onRecallDone runs either way", async () => {
    const order: string[] = []; const lines: Line[] = [];
    const engine = {
      models: { status: () => models("loading", "loading"), warm: async () => models("ready", "disabled") },
      memory: { list: (_q: unknown, p: any) => { order.push(p.agentId); return new Promise(() => {}); } },
    } as unknown as E.Engine;
    const w = startWarmup({
      engine, logger: recordingLogger(lines), signal: new AbortController().signal, onDone: () => {}, recallTimeoutMs: 30,
      recallPath: { agents: () => ["bernd", "anna"], principal: (agentId) => ({ agentId } as unknown as E.Principal) },
      onRecallDone: () => order.push("onRecallDone"),
    });
    await w.done;
    assert.deepEqual(order, ["bernd", "anna", "onRecallDone"]);
    assert.deepEqual(lines.filter(([, msg]) => msg === "recall path warm").map(([, , f]) => f!.timedOut), [true, true]);

    const order2: string[] = [];
    const engine2 = {
      models: { status: () => models("loading", "loading"), warm: async () => models("ready", "disabled") },
      memory: { list: (_q: unknown, p: any) => { order2.push(p.agentId); w2.abort(); return new Promise(() => {}); } },
    } as unknown as E.Engine;
    const w2 = startWarmup({
      engine: engine2, logger: recordingLogger([]), signal: new AbortController().signal, onDone: () => {},
      recallPath: { agents: () => ["bernd", "anna"], principal: (agentId) => ({ agentId } as unknown as E.Principal) },
      onRecallDone: () => order2.push("onRecallDone"),
    });
    await w2.done;
    assert.deepEqual(order2, ["bernd", "onRecallDone"]);
  });

  it("projectModels rounds a fractional checkedAt and turns a non-finite one into null", () => {
    const frac = models("ready", "ready"); frac.embedder.checkedAt = 1_000.6; frac.reranker.checkedAt = Number.NaN;
    const p = projectModels(frac);
    assert.equal(p.embedder.checkedAt, 1_001);
    assert.equal(p.reranker.checkedAt, null);
    const inf = models("failed", "ready", { error: "aborted" }); inf.embedder.checkedAt = Number.POSITIVE_INFINITY;
    assert.equal(projectModels(inf).embedder.checkedAt, null);
  });

  it("projectModels maps identity.model and reranker provider to id and drops unknown fields", () => {
    const m = models("failed", "disabled", { error: "provider-failed" }) as E.ModelsStatus & { extra?: unknown };
    (m.embedder as unknown as Record<string, unknown>).futureField = 1;
    (m as unknown as Record<string, unknown>).futureModel = {};
    assert.deepEqual(projectModels(m), {
      embedder: { state: "failed", warming: false, checkedAt: 1_000, error: "provider-failed", id: "e5-small" },
      reranker: { state: "disabled", warming: false, checkedAt: null, id: null },
    });
    const ready = projectModels(models("ready", "ready"));
    assert.equal(ready.embedder.checkedAt, 1_000);
    assert.equal(ready.reranker.id, "local-transformers");
    assert.equal("error" in ready.embedder, false);
  });
});
