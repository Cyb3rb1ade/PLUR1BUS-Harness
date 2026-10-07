import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MAX_LINE_BYTES, bisectByTime, completeEnd, readLinesBackward, type RawLine } from "../../src/logs/line-io.ts";

const dir = mkdtempSync(path.join(tmpdir(), "d4-lineio-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = (content: string | Buffer): string => { const p = path.join(dir, `f${n++}.log`); writeFileSync(p, content); return p; };

async function backward(p: string, block?: number): Promise<RawLine[]> {
  const fh = await open(p, "r");
  try {
    const end = await completeEnd(fh, statSync(p).size, block);
    const out: RawLine[] = [];
    for await (const l of readLinesBackward(fh, end, block)) out.push(l);
    return out;
  } finally { await fh.close(); }
}
const texts = (ls: RawLine[]): (string | null)[] => ls.map((l) => l.text);

describe("readLinesBackward", () => {
  it("yields lines last to first, with byte offsets", async () => {
    const ls = await backward(file("a\nbb\nccc\n"));
    assert.deepEqual(texts(ls), ["ccc", "bb", "a"]);
    assert.deepEqual(ls.map((l) => [l.start, l.end]), [[5, 8], [2, 4], [0, 1]]);
  });

  it("ignores a half last line (no trailing newline), however long", async () => {
    assert.deepEqual(texts(await backward(file("a\nb\nhalf-writ"))), ["b", "a"]);
    assert.deepEqual(texts(await backward(file("half"))), []);
    assert.deepEqual(texts(await backward(file("a\n" + "x".repeat(200_000)))), ["a"]);
  });

  it("handles CRLF, empty lines and an empty or newline-only file", async () => {
    assert.deepEqual(texts(await backward(file("a\r\n\r\nb\r\n"))), ["b", "a"]);
    assert.deepEqual(texts(await backward(file(""))), []);
    assert.deepEqual(texts(await backward(file("\n\n"))), []);
  });

  it("is the same at every block size, including lines that straddle blocks and multibyte text", async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `{"i":${i},"msg":"Zeile ${"ü€".repeat(i % 7)} ${"x".repeat(i)}"}`);
    const p = file(lines.join("\n") + "\n");
    const want = [...lines].reverse();
    for (const block of [1, 2, 3, 7, 16, 64, 4096]) assert.deepEqual(texts(await backward(p, block)), want, `block ${block}`);
  });

  it("reports an oversize line without holding it, and carries on with the lines before it", async () => {
    const p = file(`ok1\n${"y".repeat(MAX_LINE_BYTES + 10)}\nok2\n`);
    const ls = await backward(p, 1024);
    assert.deepEqual(ls.map((l) => [l.text, l.oversize]), [["ok2", false], [null, true], ["ok1", false]]);
  });

  it("reads a big file's tail with bounded IO (does not read the whole file)", async () => {
    const big = file(Buffer.concat([Buffer.from("filler line\n".repeat(700_000)), Buffer.from("last-1\nlast-2\n")]));
    const fh = await open(big, "r");
    const reads: number[] = [];
    const orig = fh.read.bind(fh);
    (fh as any).read = (...a: any[]) => { reads.push(a[2]); return (orig as any)(...a); };
    try {
      const end = await completeEnd(fh, statSync(big).size);
      const got: string[] = [];
      for await (const l of readLinesBackward(fh, end)) { got.push(l.text!); if (got.length === 2) break; }
      assert.deepEqual(got, ["last-2", "last-1"]);
      assert.ok(reads.reduce((a, b) => a + b, 0) <= 256 * 1024, `read ${reads.reduce((a, b) => a + b, 0)} bytes`);
    } finally { await fh.close(); }
  });
});

describe("bisectByTime", () => {
  const tsOf = (l: string): number | null => { const m = /^t=(\d+)/.exec(l); return m ? Number(m[1]) : null; };
  const make = (ts: number[], extra: (i: number) => string = () => "") => file(ts.map((t, i) => `t=${t} ${"p".repeat(i % 5)}${extra(i)}`).join("\n") + "\n");
  async function find(p: string, target: number, block?: number): Promise<{ off: number; first: string | null }> {
    const fh = await open(p, "r");
    try {
      const end = await completeEnd(fh, statSync(p).size);
      const off = await bisectByTime(fh, end, target, tsOf, block ? { blockBytes: block } : {});
      const it = readLinesBackward(fh, end);
      let first: string | null = null;
      for await (const l of it) { if (l.start === off) { first = l.text; break; } if (l.start < off) break; }
      return { off, first };
    } finally { await fh.close(); }
  }

  it("returns the start of the first line at or after the target", async () => {
    const p = make([10, 20, 20, 30, 40, 50]);
    assert.match((await find(p, 20)).first!, /^t=20 /);
    assert.equal((await find(p, 20)).off, "t=10 \n".length);
    assert.match((await find(p, 25)).first!, /^t=30/);
    assert.equal((await find(p, 0)).off, 0);
    assert.equal((await find(p, 51)).off, statSync(p).size);
  });

  it("agrees with a linear scan on a larger file and at small block sizes", async () => {
    const ts = Array.from({ length: 500 }, (_, i) => 1000 + i * 3);
    const p = make(ts, (i) => ` ${"z".repeat(i % 37)}`);
    const text = (await import("node:fs")).readFileSync(p, "utf8").split("\n");
    for (const target of [0, 1000, 1001, 1003, 1500, 2496, 2497, 99999]) {
      const idx = ts.findIndex((t) => t >= target);
      const wantOff = idx < 0 ? statSync(p).size : idx === 0 ? 0 : Buffer.byteLength(text.slice(0, idx).join("\n") + "\n");
      for (const block of [5, 64, 65536]) assert.equal((await find(p, target, block)).off, wantOff, `target ${target} block ${block}`);
    }
  });

  it("steps over corrupt lines at a probe point and over a half last line", async () => {
    const p = file("t=1 a\nGARBAGE\n\u0000\u0000\nt=5 b\nt=9 c\nt=12 half");
    // A corrupt run before the target may be included (never skipped past): the result is never later than the true start.
    assert.match((await find(p, 5)).first!, /^(GARBAGE|t=5 b)/);
    assert.match((await find(p, 6)).first!, /^t=9 c/);
    assert.equal((await find(p, 10)).off, "t=1 a\nGARBAGE\n\u0000\u0000\nt=5 b\nt=9 c\n".length);
  });
});
