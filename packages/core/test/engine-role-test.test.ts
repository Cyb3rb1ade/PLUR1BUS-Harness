import assert from "node:assert/strict";
import { test } from "node:test";
import { validateParams, validateResult } from "@plur1bus/rpc-schema";
import { buildEngineTestSurface, createEngineTestDiagnostics } from "../src/rpc/engine-test-surface.ts";
import { guardMethods } from "../src/rbac/guard.ts";
import { memoryAuditSink } from "../src/rbac/audit.ts";

const identity = { model: "local/embed", dimensions: 3, provider: "local-transformers", fingerprintId: "fixture" };
const ctx = () => ({ requestId: "probe", connectionId: "fixture", signal: new AbortController().signal });
function surface(over: Record<string, unknown> = {}, role = "owner", kind = "person", config = {}) {
  let calls = 0;
  const embedding = {
    identities: () => [identity],
    embed: async (texts: string[], o: any) => { calls++; assert.equal(texts.length, 1); assert.equal(o.kind, "query"); assert.equal(o.identity, identity); assert.ok(o.signal instanceof AbortSignal); return [new Float32Array([1, 2, 3])]; },
    rerank: async (query: string, docs: string[], o: any) => { calls++; assert.ok(query); assert.equal(docs.length, 2); assert.equal(o.topN, 1); assert.ok(o.signal instanceof AbortSignal); return [{ index: 0, score: .9 }]; }, ...over,
  };
  const methods = buildEngineTestSurface({ embedding: embedding as any, config: () => ({ reranker: { enabled: true, local: { model: "local/rerank" } }, ...config }), timeoutMs: 30 });
  const guarded = guardMethods(methods, { resolve: () => ({ kind, role, userId: "person" }) as any, audit: memoryAuditSink(), now: () => 1 });
  return { call: (role: string) => guarded["admin.engine.test"]!({ role }, ctx()), calls: () => calls };
}

test("engine role tests require a human Owner/Admin before reaching the provider", async () => {
  for (const [role, kind] of [["viewer", "person"], ["operator", "person"], ["member", "person"], ["owner", "agent"], ["admin", "agent"]]) {
    const s = surface({}, role, kind);
    await assert.rejects(s.call("embedder"), (e: any) => e.error === "E_DENIED"); assert.equal(s.calls(), 0);
  }
  for (const role of ["owner", "admin"]) assert.equal((await surface({}, role).call("embedder") as any).ok, true);
});
test("embedder reports validated dimensions and active model; reranker reports active model and latency", async () => {
  const s = surface();
  const embed = await s.call("embedder") as any;
  assert.equal(embed.model, "local/embed"); assert.equal(embed.dimensions, 3); assert.equal(embed.ok, true); assert.ok(embed.durationMs >= 0);
  const rerank = await s.call("reranker") as any;
  assert.equal(rerank.model, "local/rerank"); assert.equal(rerank.ok, true); assert.ok(rerank.durationMs >= 0); assert.equal(s.calls(), 2);
});
test("invalid vectors and rerank hits fail safely", async () => {
  for (const [role, over] of [["embedder", { embed: async () => [new Float32Array([NaN, 2, 3])] }], ["reranker", { rerank: async () => [{ index: 9, score: .4 }] }]] as const) {
    const result = await surface(over).call(role) as any; assert.equal(result.ok, false); assert.equal(result.errorClass, "provider");
  }
});
test("structured transport classifications survive causes without returning credentials or error messages", async () => {
  for (const errorClass of ["egress", "key", "download", "provider"]) {
    const secret = "private-fixture-credential";
    const e = new Error(secret, { cause: Object.assign(new Error(secret), { errorClass }) });
    const result = await surface({ embed: async () => { throw e; } }).call("embedder");
    assert.equal((result as any).errorClass, errorClass); assert.ok(!JSON.stringify(result).includes(secret));
  }
});
test("deadline bounds providers that ignore cancellation and passes an aborted signal", async () => {
  let signal: AbortSignal | undefined;
  const result = await surface({ embed: (_t: unknown, o: any) => { signal = o.signal; return new Promise(() => {}); } }).call("embedder") as any;
  assert.equal(result.errorClass, "timeout"); assert.equal(signal?.aborted, true);
});
test("unsupported captioner and disabled reranker never call providers", async () => {
  const captioner = surface(); assert.equal((await captioner.call("captioner") as any).errorClass, "unsupported"); assert.equal(captioner.calls(), 0);
  const disabled = surface({}, "owner", "person", { reranker: { enabled: false } }); assert.equal((await disabled.call("reranker") as any).errorClass, "unsupported"); assert.equal(disabled.calls(), 0);
});
test("schema closes inputs and validates bounded safe results", () => {
  assert.equal(validateParams("admin.engine.test", { role: "embedder" }).ok, true);
  for (const p of [{}, { role: "chat" }, { role: "embedder", key: "secret" }, { role: "embedder", timeoutMs: 1 }]) assert.equal(validateParams("admin.engine.test", p).ok, false);
  assert.equal(validateResult("admin.engine.test", { role: "embedder", ok: true, model: "local/embed", dimensions: 3, durationMs: 3 }).ok, true);
  assert.equal(validateResult("admin.engine.test", { role: "captioner", ok: false, durationMs: 0, errorClass: "unsupported" }).ok, true);
});

test("probe diagnostics preserve safe classifications even when engine hides causes; concurrent failures stay isolated", async () => {
  const diagnostics = createEngineTestDiagnostics();
  const [a,b] = await Promise.all([
    diagnostics.run(async () => { await new Promise(r => setTimeout(r, 2)); diagnostics.observe({ errorClass: "egress" }); throw new Error("provider removed cause"); }).catch((e: any) => e),
    diagnostics.run(async () => { diagnostics.observe({ errorClass: "key" }); await new Promise(r => setTimeout(r, 5)); throw new Error("other provider"); }).catch((e: any) => e),
  ]);
  assert.equal(a.errorClass, "egress"); assert.equal(b.errorClass, "key");
});
