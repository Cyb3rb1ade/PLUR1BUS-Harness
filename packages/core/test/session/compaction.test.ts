import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Compactor, defaultCompaction, digest, estimateTokens, fitTail, truncateWithPointer } from "../../src/session/compaction.ts";
import { SessionStore } from "../../src/session/store.ts";

const OWNER = "user:v1:o";
function fill(store: SessionStore, sessionId: string, turns: number, chars: (i: number) => number): void {
  for (let i = 0; i < turns; i++) {
    const text = `q${i} ` + "x".repeat(chars(i));
    const { turn } = store.beginTurn(sessionId, text, estimateTokens(text));
    const a = `a${i} ` + "y".repeat(chars(i));
    store.completeTurn(turn.id, { text: a, tokens: estimateTokens(a) });
  }
}

describe("compaction (L1/L2/L14)", () => {
  it("truncateWithPointer stays within the token budget and leaves a pointer", () => {
    const r = truncateWithPointer("z".repeat(10_000), 100, "see message m1");
    assert.equal(r.truncated, true); assert.ok(estimateTokens(r.text) <= 100); assert.match(r.text, /truncated 10000 chars; see message m1/);
    assert.deepEqual(truncateWithPointer("short", 100, "p"), { text: "short", truncated: false });
  });

  it("fitTail keeps the newest lines inside the bound for any input", () => {
    const text = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    for (const max of [1, 5, 40, 400]) { const out = fitTail(text, max); assert.ok(estimateTokens(out) <= max, `max ${max}: ${estimateTokens(out)}`); }
    assert.match(fitTail(text, 60), /line 499$/);
  });

  it("an untouched short session is not compacted", async () => {
    const store = new SessionStore({ path: ":memory:" });
    const s = store.createSession({ kind: "direct", agentId: "a", owner: OWNER });
    fill(store, s.id, 3, () => 40);
    const c = new Compactor(store, defaultCompaction(8192));
    const v = await c.prepare(s.id);
    assert.equal(v.compaction.swapped, false); assert.equal(v.summaries.length, 0); assert.equal(v.messages.length, 6);
  });

  it("L14 property: the assembled context never exceeds hardRatio × window, for sessions 1×–10× the window, with hostile sizes", async () => {
    const cfg = defaultCompaction(2000);
    let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (let factor = 1; factor <= 10; factor++) {
      const store = new SessionStore({ path: ":memory:" });
      const s = store.createSession({ kind: "direct", agentId: "a", owner: OWNER });
      const swaps: number[] = []; let checkpoints = 0;
      const c = new Compactor(store, cfg, { beforeSwap: async () => { checkpoints++; } });
      let total = 0;
      while (total < cfg.windowTokens * factor) {
        // mix of tiny, medium and a few giant messages (a 50 000-char tool dump)
        const chars = rnd() < 0.05 ? 50_000 : Math.floor(rnd() * 900) + 10;
        const text = "u".repeat(chars); total += Math.min(estimateTokens(text), cfg.maxMessageTokens) * 2; // what the view sees (giants are capped)
        const { turn } = store.beginTurn(s.id, text, estimateTokens(text));
        const v = await c.prepare(s.id);
        assert.ok(v.tokens <= c.hardLimit, `factor ${factor}: ${v.tokens} > ${c.hardLimit}`);
        assert.ok(v.summaries.reduce((n, x) => n + x.tokens, 0) <= cfg.summaryMaxTokens, "summary bound");
        if (v.compaction.swapped) swaps.push(v.compaction.toSeq!);
        store.completeTurn(turn.id, { text: "r".repeat(chars), tokens: estimateTokens("r".repeat(chars)) });
        await c.afterTurn(s.id);
        assert.ok(store.listSummaries(s.id, "applied").length <= 1, "tiered merge keeps one applied summary");
      }
      if (factor >= 2) { assert.ok(swaps.length > 0, `factor ${factor} must have compacted`); assert.equal(checkpoints, swaps.length, "a checkpoint before every swap"); }
      assert.equal(store.listMessages(s.id).length, store.getSession(s.id)!.turnCount * 2, "history is append-only: nothing deleted");
    }
  });

  it("cuts only at turn boundaries and never the newest turn", async () => {
    const store = new SessionStore({ path: ":memory:" });
    const s = store.createSession({ kind: "direct", agentId: "a", owner: OWNER });
    fill(store, s.id, 12, () => 1500);
    const newest = store.beginTurn(s.id, "newest question", 4);
    const c = new Compactor(store, defaultCompaction(2000));
    const v = await c.prepare(s.id);
    assert.equal(v.compaction.swapped, true);
    assert.ok(v.messages.some((m) => m.id === newest.message.id), "newest turn kept");
    const toSeq = v.compaction.toSeq!; const msgs = store.listMessages(s.id);
    const boundary = msgs.find((m) => m.seq === toSeq)!;
    assert.equal(boundary.role, "assistant", "the cut ends on a completed turn");
    assert.equal(msgs.find((m) => m.seq === toSeq + 1)!.role, "user");
  });

  it("the soft threshold prepares a summary without swapping it in; the hard swap reuses it", async () => {
    const store = new SessionStore({ path: ":memory:" });
    const s = store.createSession({ kind: "direct", agentId: "a", owner: OWNER });
    const cfg = defaultCompaction(1000); const c = new Compactor(store, cfg);
    fill(store, s.id, 6, () => 400); // 6 × 2 × ~100 = ~1200+ tokens: over soft (650)
    const before = c.view(s.id);
    assert.ok(before.tokens > c.softLimit);
    assert.deepEqual(await c.afterTurn(s.id), { prepared: true });
    assert.equal(store.listSummaries(s.id, "prepared").length, 1);
    assert.equal(c.view(s.id).summaries.length, 0, "not swapped in yet");
    assert.deepEqual(await c.afterTurn(s.id), { prepared: false }, "one prepared summary at a time");
    const { turn } = store.beginTurn(s.id, "go", 1);
    const v = await c.prepare(s.id); void turn;
    assert.equal(v.compaction.swapped, true);
    assert.equal(store.listSummaries(s.id, "prepared").length, 0);
  });

  it("a failing checkpoint does not stop the swap and is reported", async () => {
    const store = new SessionStore({ path: ":memory:" });
    const s = store.createSession({ kind: "direct", agentId: "a", owner: OWNER });
    fill(store, s.id, 12, () => 1500); store.beginTurn(s.id, "q", 1);
    const errs: string[] = [];
    const c = new Compactor(store, defaultCompaction(2000), { beforeSwap: async () => { throw new Error("engine down"); }, onError: (w) => errs.push(w) });
    const v = await c.prepare(s.id);
    assert.equal(v.compaction.checkpoint, "failed"); assert.equal(v.compaction.swapped, true); assert.equal(errs.length, 1);
    assert.ok(v.tokens <= c.hardLimit);
  });

  it("digest is deterministic and line-capped", () => {
    const d = digest([{ role: "user", seq: 1, text: "a\n\n b   c" }, { role: "assistant", seq: 2, text: "z".repeat(1000) }]);
    assert.equal(d.split("\n").length, 2); assert.equal(d.split("\n")[0], "user#1: a b c"); assert.ok(d.split("\n")[1]!.length <= 200);
  });
});
