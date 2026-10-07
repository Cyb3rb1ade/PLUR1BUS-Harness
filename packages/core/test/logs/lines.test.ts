import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { open } from "node:fs/promises";
import { statSync } from "node:fs";
import { backwardLines, forwardLines, seekByTs, alignForward, CHUNK } from "../../src/logs/lines.ts";
import { logsDir, put } from "./helpers.ts";

async function collect<T>(g: AsyncGenerator<T>): Promise<T[]> { const out: T[] = []; for await (const x of g) out.push(x); return out; }
async function both(text: string, maxLine?: number) {
  const f = put(logsDir(), "a.log", text);
  const fh = await open(f, "r"); const size = statSync(f).size;
  try {
    const fwd = await collect(forwardLines(fh, { start: 0, end: size, ...(maxLine ? { maxLine } : {}) }));
    const bwd = await collect(backwardLines(fh, { end: size, ...(maxLine ? { maxLine } : {}) }));
    return { fwd, bwd };
  } finally { await fh.close(); }
}
const texts = (l: Array<{ text: string; tooLong: boolean }>): string[] => l.filter((x) => !x.tooLong).map((x) => x.text);

describe("line iterators", () => {
  it("yield the complete lines in both directions and ignore an unterminated last line", async () => {
    const { fwd, bwd } = await both("one\ntwo\r\n\nthree\nhal");
    assert.deepEqual(texts(fwd), ["one", "two", "three"]);
    assert.deepEqual(texts(bwd), ["three", "two", "one"]);
  });
  it("a file that is only a half line, or empty, yields nothing", async () => {
    for (const t of ["", "half", "\n", "\n\n"]) { const { fwd, bwd } = await both(t); assert.deepEqual([texts(fwd), texts(bwd)], [[], []], JSON.stringify(t)); }
  });
  it("lines that straddle chunk boundaries come out whole and in the same set both ways", async () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `line-${i}-${"x".repeat((i * 37) % 200)}`);
    const text = lines.join("\n") + "\n";
    assert.ok(text.length > 3 * CHUNK);
    const { fwd, bwd } = await both(text);
    assert.deepEqual(texts(fwd), lines);
    assert.deepEqual(texts(bwd), [...lines].reverse());
  });
  it("a line longer than the cap is skipped once, without buffering, and the neighbours survive", async () => {
    const big = "y".repeat(300_000);
    const { fwd, bwd } = await both(`a\n${big}\nb\n`, 100_000);
    assert.deepEqual(texts(fwd), ["a", "b"]); assert.equal(fwd.filter((x) => x.tooLong).length, 1);
    assert.deepEqual(texts(bwd), ["b", "a"]); assert.equal(bwd.filter((x) => x.tooLong).length, 1);
  });
  it("a multibyte character cut by a chunk boundary is decoded whole", async () => {
    const pad = "p".repeat(CHUNK - 2);
    const { fwd, bwd } = await both(`${pad}€x\nä\n`);
    assert.deepEqual(texts(fwd), [`${pad}€x`, "ä"]);
    assert.deepEqual(texts(bwd), ["ä", `${pad}€x`]);
  });
});

describe("seekByTs", () => {
  it("finds a window in front of the first line at or after the timestamp in a file much larger than a chunk", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 40_000; i++) lines.push(JSON.stringify({ ts: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(), level: "info", msg: "m".repeat(40) }));
    const f = put(logsDir(), "big.log", lines.join("\n") + "\n");
    const size = statSync(f).size; assert.ok(size > 2_000_000);
    const fh = await open(f, "r");
    try {
      const stats = { bytes: 0 };
      const tsOf = (l: string): string | null => { try { return JSON.parse(l).ts; } catch { return null; } };
      const target = new Date(Date.UTC(2026, 0, 1) + 30_000 * 1000).toISOString();
      const at = await alignForward(fh, await seekByTs(fh, size, target, tsOf, false, stats), size, stats);
      const first = await collect(forwardLines(fh, { start: at, end: size }));
      const i = first.findIndex((l) => tsOf(l.text)! >= target);
      assert.ok(i >= 0 && first[i]!.text === lines[30_000]);
      assert.ok(i < 2000, `window in front of the target is small (${i} lines)`);
      assert.ok(stats.bytes < 200_000, `the search read ${stats.bytes} bytes of ${size}`);
    } finally { await fh.close(); }
  });
});
