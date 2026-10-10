import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InMemoryMediaIndex, type InMemoryMediaIndexOptions } from "../../src/media-search/in-memory.ts";
import type { MediaIndexRequest, Segment } from "../../src/media-search/types.ts";
import { scope } from "./helpers.ts";

// 3-dim "embedding space": the text of a query or the mediaId prefix picks an axis.
const AXES: Record<string, number[]> = { cat: [1, 0, 0], dog: [0, 1, 0], bird: [0, 0, 1] };
const axisOf = (s: string) => AXES[Object.keys(AXES).find((k) => s.includes(k)) ?? "cat"]!;
function make(over: Partial<InMemoryMediaIndexOptions> = {}) {
  return new InMemoryMediaIndex({
    provider: "test", model: "tiny", dim: 3, fingerprint: "fp-1",
    embedText: async (t) => axisOf(t),
    embedMedia: async (req: MediaIndexRequest) => {
      const n = req.kind === "image" ? 1 : 2;
      const segments: Segment[] = Array.from({ length: n }, (_, i) => ({ idx: i, startMs: i * 1000, endMs: (i + 1) * 1000 }));
      return { vectors: segments.map(() => axisOf(req.mediaId)), segments };
    },
    ...over,
  });
}
const req = (mediaId: string, kind: MediaIndexRequest["kind"] = "image", s = scope()): MediaIndexRequest => ({ mediaId, kind, mime: `${kind}/x`, source: { bytes: new Uint8Array([1]) }, scope: s });

describe("InMemoryMediaIndex search", () => {
  it("ranks by cosine, filters kinds and minScore, applies limit", async () => {
    const m = make();
    await m.index(req("cat-1")); await m.index(req("dog-1")); await m.index(req("cat-v", "video"));
    const hits = await m.search({ text: "a cat", limit: 10, minScore: 0.1, scope: scope() });
    assert.deepEqual(hits.map((h) => h.mediaId), ["cat-1", "cat-v"]);
    assert.equal(hits[0]!.score, 1);
    assert.equal(hits[0]!.segment, undefined);
    assert.deepEqual(hits[1]!.segment, { idx: 0, startMs: 0, endMs: 1000 });
    assert.deepEqual((await m.search({ text: "cat", kinds: ["video"], limit: 10, scope: scope() })).map((h) => h.mediaId), ["cat-v"]);
    assert.equal((await m.search({ text: "cat", limit: 1, scope: scope() })).length, 1);
    assert.deepEqual((await m.search({ text: "cat", limit: 10, minScore: 0.5, scope: scope() })).length, 2);
    assert.equal((await m.search({ text: "bird", limit: 10, minScore: 0.5, scope: scope() })).length, 0);
  });
  it("likeMediaId uses stored vectors and excludes the source", async () => {
    const m = make();
    await m.index(req("cat-1")); await m.index(req("cat-2")); await m.index(req("dog-1"));
    const hits = await m.search({ likeMediaId: "cat-1", limit: 10, minScore: 0.1, scope: scope() });
    assert.deepEqual(hits.map((h) => h.mediaId), ["cat-2"]);
    await assert.rejects(m.search({ likeMediaId: "ghost", limit: 5, scope: scope() }), (e) => (e as { error?: string }).error === "E_NOT_FOUND");
  });
  it("requires exactly one of text/likeMediaId", async () => {
    const m = make();
    await assert.rejects(m.search({ limit: 5, scope: scope() }), (e) => (e as { error?: string }).error === "E_INVALID_PARAMS");
    await assert.rejects(m.search({ text: "a", likeMediaId: "b", limit: 5, scope: scope() }), (e) => (e as { error?: string }).error === "E_INVALID_PARAMS");
  });
  it("scope: same agent or same user sees a medium, others do not", async () => {
    const m = make();
    await m.index(req("cat-a", "image", scope("a1", "user:v1:u")));
    const see = async (s: ReturnType<typeof scope>) => (await m.search({ text: "cat", limit: 5, scope: s })).length;
    assert.equal(await see(scope("a1")), 1);
    assert.equal(await see(scope("a2", "user:v1:u")), 1);
    assert.equal(await see(scope("a2", "user:v1:other")), 0);
    assert.equal(await see(scope("a2")), 0);
    await assert.rejects(m.search({ likeMediaId: "cat-a", limit: 5, scope: scope("a2") }), (e) => (e as { error?: string }).error === "E_NOT_FOUND");
  });
  it("dimension mismatch -> E_MEDIA_DIMENSION", async () => {
    const bad = make({ embedText: async () => [1, 0] });
    await assert.rejects(bad.search({ text: "cat", limit: 5, scope: scope() }), (e) => (e as { error?: string }).error === "E_MEDIA_DIMENSION");
    const badMedia = make({ embedMedia: async () => ({ vectors: [[1, 0]], segments: [{ idx: 0, startMs: 0, endMs: 1 }] }) });
    await assert.rejects(badMedia.index(req("cat-1")), (e) => (e as { error?: string }).error === "E_MEDIA_DIMENSION");
  });
  it("fuseCaptions merges by RRF over ranks, never mixing scores", async () => {
    const captionHits = [{ mediaId: "dog-1", captionMemoryId: "mem-d" }, { mediaId: "cat-2" , captionMemoryId: "mem-c2" }];
    const m = make({ captions: { search: async () => captionHits } });
    await m.index(req("cat-1")); await m.index(req("cat-2")); await m.index(req("dog-1"));
    const plain = await m.search({ text: "cat", limit: 10, scope: scope() });
    assert.ok(plain.every((h) => h.score <= 1));
    const fused = await m.search({ text: "cat", limit: 10, minScore: 0.5, fuseCaptions: true, scope: scope() });
    const byId = new Map(fused.map((h) => [h.mediaId, h]));
    // cat-1: vector rank1 only; cat-2: vector rank2 + caption rank2; dog-1: caption rank1 only (below minScore for vectors)
    const rr = (r: number) => 1 / (60 + r);
    assert.ok(Math.abs(byId.get("cat-1")!.score - rr(1)) < 1e-12);
    assert.ok(Math.abs(byId.get("cat-2")!.score - (rr(2) + rr(2))) < 1e-12);
    assert.ok(Math.abs(byId.get("dog-1")!.score - rr(1)) < 1e-12);
    assert.equal(byId.get("cat-2")!.captionMemoryId, "mem-c2");
    assert.equal(fused[0]!.mediaId, "cat-2");
  });
  it("fused caption hits respect scope and unknown media", async () => {
    const m = make({ captions: { search: async () => [{ mediaId: "secret" }, { mediaId: "ghost" }] } });
    await m.index(req("secret", "image", scope("other")));
    assert.deepEqual(await m.search({ text: "cat", limit: 10, fuseCaptions: true, scope: scope("a1") }), []);
  });
});

describe("InMemoryMediaIndex lifecycle", () => {
  it("index states: unsupported-kind by modalities or embedMedia, failed on error", async () => {
    const m = make({ modalities: ["image"] });
    assert.deepEqual(await m.index(req("v", "video")), { segments: 0, state: "unsupported-kind" });
    const { mediaError } = await import("../../src/media-search/errors.ts");
    const u = make({ embedMedia: async () => { throw mediaError("E_MEDIA_UNSUPPORTED_KIND", "no port"); } });
    assert.equal((await u.index(req("x"))).state, "unsupported-kind");
    const f = make({ embedMedia: async () => { throw new Error("boom"); } });
    assert.equal((await f.index(req("x"))).state, "failed");
    assert.deepEqual((await f.status()).counts, { indexed: 0, pending: 0, failed: 1, unsupported: 0 });
    assert.equal((await u.status()).counts.unsupported, 1);
  });
  it("remove and setCaption call the caption hooks", async () => {
    const log: string[] = [];
    const m = make({ captions: { search: async () => [], set: async (id, t, s) => { log.push(`set:${id}:${t}:${s}`); }, remove: async (id) => { log.push(`rm:${id}`); } } });
    await m.index({ ...req("cat-1"), caption: "my cat", captionSource: "user" });
    await m.setCaption("cat-1", "better", "user");
    await m.remove("cat-1");
    assert.deepEqual(log, ["set:cat-1:my cat:user", "set:cat-1:better:user", "rm:cat-1"]);
    assert.deepEqual((await m.search({ text: "cat", limit: 5, scope: scope() })), []);
    await assert.rejects(m.setCaption("ghost", "x", "user"), (e) => (e as { error?: string }).error === "E_NOT_FOUND");
    assert.equal((await m.status()).counts.indexed, 0);
  });
  it("status reports identity", async () => {
    const s = await make().status();
    assert.deepEqual([s.enabled, s.provider, s.model, s.dim, s.fingerprint, s.backfill.state], [true, "test", "tiny", 3, "fp-1", "idle"]);
  });
});

describe("InMemoryMediaIndex backfill", () => {
  const pending = (n: number) => async function* () { for (let i = 0; i < n; i++) yield req(`cat-${i}`); };
  it("start runs to done when awaited", async () => {
    const m = make({ listUnindexed: pending(3) });
    await m.backfill.start({ reason: "enable" });
    const s = await m.status();
    assert.deepEqual([s.backfill.state, s.backfill.done, s.backfill.total, s.counts.indexed], ["done", 3, 3, 3]);
    assert.ok(s.backfill.startedAt);
  });
  it("budget false pauses with reason budget; resume continues once allowed", async () => {
    let allow = 2;
    const m = make({ listUnindexed: pending(4), budget: { canContinue: async () => allow-- > 0 } });
    await m.backfill.start({ reason: "manual" });
    let s = await m.status();
    assert.deepEqual([s.backfill.state, s.backfill.pausedReason, s.backfill.done], ["paused", "budget", 2]);
    allow = 10;
    await m.backfill.resume();
    s = await m.status();
    assert.deepEqual([s.backfill.state, s.backfill.done, s.backfill.pausedReason], ["done", 4, undefined]);
  });
  it("pause (user) from inside a running item, then resume", async () => {
    let m!: InMemoryMediaIndex; let n = 0;
    m = make({ listUnindexed: pending(3), embedMedia: async (r) => { if (++n === 1) await m.backfill.pause(); return { vectors: [axisOf(r.mediaId)], segments: [{ idx: 0, startMs: 0, endMs: 0 }] }; } });
    await m.backfill.start({ reason: "enable" });
    let s = await m.status();
    assert.deepEqual([s.backfill.state, s.backfill.pausedReason, s.backfill.done], ["paused", "user", 1]);
    await m.backfill.resume();
    s = await m.status();
    assert.deepEqual([s.backfill.state, s.backfill.done], ["done", 3]);
  });
  it("cancel stops and clears the queue; counts pending while queued", async () => {
    let m!: InMemoryMediaIndex; let pendingSeen = -1;
    m = make({ listUnindexed: pending(3), embedMedia: async (r) => { pendingSeen = (await m.status()).counts.pending; await m.backfill.cancel(); return { vectors: [axisOf(r.mediaId)], segments: [{ idx: 0, startMs: 0, endMs: 0 }] }; } });
    await m.backfill.start({ reason: "model-change" });
    const s = await m.status();
    assert.equal(pendingSeen, 2);
    assert.deepEqual([s.backfill.state, s.backfill.done, s.counts.pending], ["cancelled", 1, 0]);
    await m.backfill.resume(); // no-op unless paused
    assert.equal((await m.status()).backfill.state, "cancelled");
  });
  it("a failing item does not stop the backfill", async () => {
    let n = 0;
    const m = make({ listUnindexed: pending(3), embedMedia: async (r) => { if (++n === 2) throw new Error("x"); return { vectors: [axisOf(r.mediaId)], segments: [{ idx: 0, startMs: 0, endMs: 0 }] }; } });
    await m.backfill.start({ reason: "enable" });
    const s = await m.status();
    assert.deepEqual([s.backfill.state, s.backfill.done, s.counts.indexed, s.counts.failed], ["done", 3, 2, 1]);
  });
});
