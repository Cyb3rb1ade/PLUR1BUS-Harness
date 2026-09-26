import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type * as E from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import type { HarnessLogger } from "../src/logger.ts";
import { projectModels, startWarmup } from "../src/warmup.ts";

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
