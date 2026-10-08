import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CHUNK, MAX_LINE, alignForward, backwardLines, forwardLines, lastLineBoundary, seekByTs, type RawLine, type ScanStats } from "../../src/logs/lines.ts";

let root = "";
beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), "p1b-lines-cov-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

async function collect<T>(g: AsyncGenerator<T>): Promise<T[]> { const out: T[] = []; for await (const x of g) out.push(x); return out; }
let seq = 0;
async function withFile<T>(data: string | Buffer, fn: (fh: FileHandle, size: number) => Promise<T>): Promise<T> {
  const p = path.join(root, `f${seq++}.log`); writeFileSync(p, data);
  const fh = await open(p, "r");
  try { return await fn(fh, Buffer.byteLength(data)); } finally { await fh.close(); }
}
const tok = (l: RawLine[]): string[] => l.map(x => (x.tooLong ? "<long>" : x.text));

/** Reference model: complete lines only, CR stripped, empty/CR-only skipped, over-long (raw bytes incl. CR) replaced by a marker. */
function reference(text: string, maxLine: number): string[] {
  const parts = Buffer.from(text).toString("latin1").split("\n"); parts.pop();
  const out: string[] = [];
  for (const raw of parts) {
    const b = Buffer.from(raw, "latin1");
    if (b.length > maxLine) { out.push("<long>"); continue; }
    if (b.length === 0 || (b.length === 1 && b[0] === 0x0d)) continue;
    const e = b[b.length - 1] === 0x0d ? b.length - 1 : b.length;
    out.push(b.toString("utf8", 0, e));
  }
  return out;
}
function prng(seed: number): () => number { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

describe("forwardLines", () => {
  it("exports the documented constants", () => { assert.equal(CHUNK, 65536); assert.equal(MAX_LINE, 262144); });
  it("yields nothing for an empty range, an empty file, and start == end", async () => {
    await withFile("", async (fh) => { assert.deepEqual(await collect(forwardLines(fh, { start: 0, end: 0 })), []); });
    await withFile("a\nb\n", async (fh) => { assert.deepEqual(await collect(forwardLines(fh, { start: 2, end: 2 })), []); });
  });
  it("honours start (a line start) and end (cuts mid-line: the cut line is unterminated and ignored)", async () => {
    await withFile("one\ntwo\nthree\n", async (fh, size) => {
      assert.deepEqual(tok(await collect(forwardLines(fh, { start: 4, end: size }))), ["two", "three"]);
      assert.deepEqual(tok(await collect(forwardLines(fh, { start: 0, end: 9 }))), ["one", "two"]);
      assert.deepEqual(tok(await collect(forwardLines(fh, { start: 0, end: 8 }))), ["one", "two"]);
    });
  });
  it("stops cleanly when the file is shorter than `end` (it shrank)", async () => {
    await withFile("a\nb\npartial", async (fh) => {
      assert.deepEqual(tok(await collect(forwardLines(fh, { start: 0, end: 5000 }))), ["a", "b"]);
    });
  });
  it("stops cleanly when start is beyond the file", async () => {
    await withFile("a\n", async (fh) => { assert.deepEqual(await collect(forwardLines(fh, { start: 100, end: 200 })), []); });
  });
  it("counts bytes read in stats and works without stats", async () => {
    await withFile("aa\nbb\n", async (fh, size) => {
      const stats: ScanStats = { bytes: 0 };
      await collect(forwardLines(fh, { start: 0, end: size, stats }));
      assert.equal(stats.bytes, size);
      await collect(forwardLines(fh, { start: 0, end: size }));
    });
  });
  it("drops CR-only lines, including a CR that ends one chunk with its LF opening the next", async () => {
    const text = `${"y".repeat(CHUNK - 2)}\n\r\nafter\n`; // the CR is the last byte of chunk 1, the LF the first of chunk 2
    assert.equal(text.indexOf("\r"), CHUNK - 1);
    await withFile(text, async (fh, size) => {
      assert.deepEqual(tok(await collect(forwardLines(fh, { start: 0, end: size }))), ["y".repeat(CHUNK - 2), "after"]);
    });
  });
  it("assembles a multi-byte character that straddles a chunk boundary", async () => {
    const text = `${"a".repeat(CHUNK - 1)}€\nnext\n`;
    await withFile(text, async (fh, size) => {
      assert.deepEqual(tok(await collect(forwardLines(fh, { start: 0, end: size }))), [`${"a".repeat(CHUNK - 1)}€`, "next"]);
    });
  });
  it("a long line spanning several chunks that stays under the cap is returned whole", async () => {
    const mid = "m".repeat(CHUNK * 2 + 10);
    await withFile(`a\n${mid}\nb\n`, async (fh, size) => {
      assert.deepEqual(tok(await collect(forwardLines(fh, { start: 0, end: size }))), ["a", mid, "b"]);
    });
  });
  it("an over-long line is reported once, even across many chunks, and skipping ends at its newline in a later chunk", async () => {
    await withFile(`a\n${"z".repeat(CHUNK * 3)}\nb\n`, async (fh, size) => {
      assert.deepEqual(tok(await collect(forwardLines(fh, { start: 0, end: size, maxLine: 1000 }))), ["a", "<long>", "b"]);
    });
  });
  it("an over-long line whose newline falls in the same chunk is reported once", async () => {
    await withFile(`a\n${"z".repeat(50)}\nb\n`, async (fh, size) => {
      assert.deepEqual(tok(await collect(forwardLines(fh, { start: 0, end: size, maxLine: 10 }))), ["a", "<long>", "b"]);
    });
  });
  it("a line of exactly maxLine bytes is kept, maxLine+1 is too long (CR counts as raw byte)", async () => {
    await withFile(`${"k".repeat(10)}\n${"k".repeat(11)}\n${"k".repeat(9)}\r\n${"k".repeat(10)}\r\n`, async (fh, size) => {
      assert.deepEqual(tok(await collect(forwardLines(fh, { start: 0, end: size, maxLine: 10 }))), ["k".repeat(10), "<long>", "k".repeat(9), "<long>"]);
    });
  });
  it("an unterminated over-long tail is reported as too long but never as text", async () => {
    await withFile(`a\n${"t".repeat(5000)}`, async (fh, size) => {
      const out = await collect(forwardLines(fh, { start: 0, end: size, maxLine: 100 }));
      assert.deepEqual(out.filter(x => !x.tooLong).map(x => x.text), ["a"]);
    });
  });
  it("an unterminated over-long tail is not reported as a (corrupt) line, as the header says unterminated lines are never yielded", { skip: "UNKLAR: forwardLines meldet eine unterminierte Überlängen-Zeile als tooLong, backwardLines nicht – siehe docs/testing/coverage-2026-10.md#logs-lines-unterminated-too-long-asymmetry" }, async () => {
    await withFile(`a\n${"t".repeat(5000)}`, async (fh, size) => {
      const fwd = await collect(forwardLines(fh, { start: 0, end: size, maxLine: 100 }));
      const bwd = await collect(backwardLines(fh, { end: size, maxLine: 100 }));
      assert.deepEqual(tok(fwd), tok(bwd.reverse()));
    });
  });
  it("an unterminated valid-JSON last line is never yielded", async () => {
    await withFile('{"ts":"x"}\n{"ts":"y"}', async (fh, size) => {
      assert.deepEqual(tok(await collect(forwardLines(fh, { start: 0, end: size }))), ['{"ts":"x"}']);
    });
  });
  it("handles NUL and invalid UTF-8 bytes without throwing", async () => {
    await withFile(Buffer.from([0x61, 0x00, 0xff, 0xfe, 0x0a, 0x62, 0x0a]), async (fh, size) => {
      const out = await collect(forwardLines(fh, { start: 0, end: size }));
      assert.equal(out.length, 2); assert.equal(out[1]!.text, "b"); assert.ok(out[0]!.text.startsWith("a\u0000"));
    });
  });
});

describe("backwardLines", () => {
  it("yields nothing for an empty file, end 0, and a file without a newline", async () => {
    await withFile("", async (fh) => { assert.deepEqual(await collect(backwardLines(fh, { end: 0 })), []); });
    await withFile("abc\n", async (fh) => { assert.deepEqual(await collect(backwardLines(fh, { end: 0 })), []); });
    await withFile("no newline here", async (fh, size) => { assert.deepEqual(await collect(backwardLines(fh, { end: size })), []); });
  });
  it("honours `end` in the middle of a line (the cut line is ignored)", async () => {
    await withFile("one\ntwo\nthree\n", async (fh) => {
      assert.deepEqual(tok(await collect(backwardLines(fh, { end: 10 }))), ["two", "one"]);
      assert.deepEqual(tok(await collect(backwardLines(fh, { end: 8 }))), ["two", "one"]);
      assert.deepEqual(tok(await collect(backwardLines(fh, { end: 4 }))), ["one"]);
    });
  });
  it("counts bytes in stats and works without stats", async () => {
    await withFile("aa\nbb\n", async (fh, size) => {
      const stats: ScanStats = { bytes: 0 };
      await collect(backwardLines(fh, { end: size, stats }));
      assert.ok(stats.bytes >= size);
      await collect(backwardLines(fh, { end: size }));
    });
  });
  it("skips CR-only lines, including the very first line of the file", async () => {
    await withFile("\r\nabc\n\r\ndef\r\n", async (fh, size) => {
      assert.deepEqual(tok(await collect(backwardLines(fh, { end: size }))), ["def", "abc"]);
    });
  });
  it("the first line of the file: kept, CR stripped, and reported when over-long", async () => {
    await withFile("first\r\nsecond\n", async (fh, size) => { assert.deepEqual(tok(await collect(backwardLines(fh, { end: size }))), ["second", "first"]); });
    await withFile("first-line-is-long\nsecond\n", async (fh, size) => { assert.deepEqual(tok(await collect(backwardLines(fh, { end: size, maxLine: 8 }))), ["second", "<long>"]); });
  });
  it("a CR-only first line spanning no boundary is not yielded, a CR line in a chunk join is not yielded either", async () => {
    const text = `\r\n${"q".repeat(CHUNK)}\n`;
    await withFile(text, async (fh, size) => { assert.deepEqual(tok(await collect(backwardLines(fh, { end: size }))), ["q".repeat(CHUNK)]); });
  });
  it("an over-long line is skipped across chunks and the lines before it survive", async () => {
    await withFile(`start\nmiddle\n${"L".repeat(CHUNK * 3)}\nlast\n`, async (fh, size) => {
      assert.deepEqual(tok(await collect(backwardLines(fh, { end: size, maxLine: 2000 }))), ["last", "<long>", "middle", "start"]);
    });
  });
  it("an over-long first line spanning chunks ends the iteration with a single report", async () => {
    await withFile(`${"F".repeat(CHUNK * 2 + 5)}\nlast\n`, async (fh, size) => {
      assert.deepEqual(tok(await collect(backwardLines(fh, { end: size, maxLine: 2000 }))), ["last", "<long>"]);
    });
  });
  it("a line spanning several chunks below the cap is joined", async () => {
    const mid = "w".repeat(CHUNK * 2 + 17);
    await withFile(`a\n${mid}\nb\n`, async (fh, size) => { assert.deepEqual(tok(await collect(backwardLines(fh, { end: size }))), ["b", mid, "a"]); });
  });
  it("a multi-byte character across a chunk boundary", async () => {
    const line = `${"a".repeat(CHUNK - 1)}€`;
    await withFile(`${line}\nz\n`, async (fh, size) => { assert.deepEqual(tok(await collect(backwardLines(fh, { end: size }))), ["z", line]); });
  });
  it("newlines exactly on chunk boundaries", async () => {
    const l1 = "a".repeat(CHUNK - 1); const l2 = "b".repeat(CHUNK - 1);
    await withFile(`${l1}\n${l2}\n`, async (fh, size) => {
      assert.deepEqual(tok(await collect(backwardLines(fh, { end: size }))), [l2, l1]);
      assert.deepEqual(tok(await collect(forwardLines(fh, { start: 0, end: size }))), [l1, l2]);
    });
  });
});

describe("lastLineBoundary", () => {
  it("returns the offset after the last newline before end", async () => {
    await withFile("ab\ncd\nef", async (fh) => {
      assert.equal(await lastLineBoundary(fh, 8), 6);
      assert.equal(await lastLineBoundary(fh, 6), 6);
      assert.equal(await lastLineBoundary(fh, 5), 3);
      assert.equal(await lastLineBoundary(fh, 3), 3);
      assert.equal(await lastLineBoundary(fh, 2), 0);
      assert.equal(await lastLineBoundary(fh, 0), 0);
    });
  });
  it("scans back over several chunks and reports stats", async () => {
    await withFile(`x\n${"y".repeat(CHUNK * 2 + 3)}`, async (fh, size) => {
      const stats: ScanStats = { bytes: 0 };
      assert.equal(await lastLineBoundary(fh, size, stats), 2);
      assert.ok(stats.bytes >= size);
      assert.equal(await lastLineBoundary(fh, size), 2);
    });
  });
  it("returns 0 when the file has no newline at all", async () => {
    await withFile("y".repeat(CHUNK + 5), async (fh, size) => { assert.equal(await lastLineBoundary(fh, size), 0); });
  });
});

describe("forward and backward agree with a reference model", () => {
  const rnd = prng(20261008);
  const alphabet = ["a", "b", "ü", "€", "😀", " ", "\r", "{", '"'];
  function randomText(lines: number, maxLen: number): string {
    let out = "";
    for (let i = 0; i < lines; i++) {
      const n = Math.floor(rnd() * maxLen); let l = "";
      for (let j = 0; j < n; j++) l += alphabet[Math.floor(rnd() * alphabet.length)];
      out += l + (rnd() < 0.15 ? "\r\n" : "\n");
    }
    return out;
  }
  const configs: Array<[string, string, number | undefined]> = [
    ["tiny lines", randomText(200, 12), undefined],
    ["small maxLine with long tail of lengths", randomText(300, 60), 25],
    ["medium lines, default cap", randomText(1500, 200), undefined],
    ["multi-chunk with a small cap", randomText(3000, 120), 90],
    ["only newlines", "\n".repeat(500), undefined],
    ["only CRLFs", "\r\n".repeat(500), undefined],
    ["CRs without newline then newline", "\r".repeat(10) + "\n", undefined],
  ];
  for (const [label, text, maxLine] of configs) {
    it(label, async () => {
      const cap = maxLine ?? MAX_LINE; const expected = reference(text, cap);
      await withFile(text, async (fh, size) => {
        const base = maxLine ? { maxLine } : {};
        assert.deepEqual(tok(await collect(forwardLines(fh, { start: 0, end: size, ...base }))), expected);
        assert.deepEqual(tok(await collect(backwardLines(fh, { end: size, ...base }))), [...expected].reverse());
      });
    });
  }
  it("a file larger than several chunks with a few giant lines in the middle", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 400; i++) lines.push(`row-${i}-${"p".repeat(i % 300)}`);
    lines.splice(150, 0, "G".repeat(CHUNK + 100)); lines.splice(300, 0, "H".repeat(CHUNK * 2 + 1));
    const text = lines.join("\n") + "\n"; const cap = 5000; const expected = reference(text, cap);
    assert.equal(expected.filter(x => x === "<long>").length, 2);
    await withFile(text, async (fh, size) => {
      assert.deepEqual(tok(await collect(forwardLines(fh, { start: 0, end: size, maxLine: cap }))), expected);
      assert.deepEqual(tok(await collect(backwardLines(fh, { end: size, maxLine: cap }))), [...expected].reverse());
    });
  });
});

describe("alignForward", () => {
  it("returns 0 for offsets <= 0 and size for offsets >= size", async () => {
    await withFile("ab\ncd\n", async (fh, size) => {
      assert.equal(await alignForward(fh, 0, size), 0);
      assert.equal(await alignForward(fh, -5, size), 0);
      assert.equal(await alignForward(fh, size, size), size);
      assert.equal(await alignForward(fh, size + 10, size), size);
    });
  });
  it("keeps an offset that is right after a newline, otherwise moves to the next line start", async () => {
    await withFile("ab\ncd\nef\n", async (fh, size) => {
      assert.equal(await alignForward(fh, 3, size), 3);
      assert.equal(await alignForward(fh, 1, size), 3);
      assert.equal(await alignForward(fh, 2, size), 3);
      assert.equal(await alignForward(fh, 4, size), 6);
      assert.equal(await alignForward(fh, 8, size), 9);
    });
  });
  it("returns size when no newline follows (including through several probes and stats)", async () => {
    await withFile(`a\n${"n".repeat(10_000)}`, async (fh, size) => {
      const stats: ScanStats = { bytes: 0 };
      assert.equal(await alignForward(fh, 5, size, stats), size);
      assert.ok(stats.bytes >= 9000);
    });
  });
  it("finds a newline after more than one probe", async () => {
    await withFile(`${"n".repeat(9000)}\nx\n`, async (fh, size) => { assert.equal(await alignForward(fh, 10, size), 9001); });
  });
  it("answers size when `size` claims more bytes than the file has", async () => {
    await withFile("abcdef", async (fh) => { assert.equal(await alignForward(fh, 2, 100), 100); });
  });
});

describe("seekByTs", () => {
  const line = (i: number): string => `{"ts":"${String(i).padStart(8, "0")}","pad":"${"p".repeat(90)}"}\n`;
  const tsOf = (l: string): string | null => { const m = /"ts":"(\d+)"/.exec(l); return m ? m[1]! : null; };
  const N = 3000; const text = Array.from({ length: N }, (_, i) => line(i)).join(""); const L = Buffer.byteLength(line(0));
  const key = (i: number): string => String(i).padStart(8, "0");

  it("returns 0 for small files (nothing to search) and for empty files", async () => {
    await withFile(text.slice(0, L * 10), async (fh, size) => { assert.equal(await seekByTs(fh, size, key(5), tsOf, false), 0); });
    await withFile("", async (fh) => { assert.equal(await seekByTs(fh, 0, key(5), tsOf, false), 0); });
  });
  it("lands at or before the first matching line, within a bounded window of it", async () => {
    await withFile(text, async (fh, size) => {
      for (const target of [0, 1, 700, 1500, 2999]) {
        const off = await seekByTs(fh, size, key(target), tsOf, false);
        assert.ok(off <= target * L, `target ${target}: ${off} > ${target * L}`);
        assert.ok(off >= target * L - 2 * 64 * 1024, `target ${target}: ${off} too early`);
      }
    });
  });
  it("a timestamp after the end ends near the end; before the start gives 0", async () => {
    await withFile(text, async (fh, size) => {
      const late = await seekByTs(fh, size, key(99999), tsOf, false);
      assert.ok(late >= size - 2 * 64 * 1024 && late <= size);
      assert.equal(await seekByTs(fh, size, "00000000", tsOf, false), 0);
      assert.equal(await seekByTs(fh, size, "", tsOf, false), 0);
    });
  });
  it("strict mode moves past lines equal to the timestamp", async () => {
    const dup = Array.from({ length: 3000 }, (_, i) => line(Math.floor(i / 100))).join(""); // 100 lines per ts
    await withFile(dup, async (fh, size) => {
      const lax = await seekByTs(fh, size, key(20), tsOf, false);
      const strict = await seekByTs(fh, size, key(20), tsOf, true);
      assert.ok(lax <= strict, `${lax} <= ${strict}`);
      assert.ok(lax <= 20 * 100 * L); assert.ok(strict <= 21 * 100 * L);
      assert.ok(strict >= lax);
    });
  });
  it("gives up with 0 when a probe line cannot be read (unterminated within the probe window)", async () => {
    const fat = (i: number): string => `{"ts":"${key(i)}","pad":"${"x".repeat(5000)}"}\n`;
    await withFile(Array.from({ length: 200 }, (_, i) => fat(i)).join(""), async (fh, size) => {
      assert.equal(await seekByTs(fh, size, key(150), tsOf, false), 0);
    });
  });
  it("gives up with 0 when a probe line has no timestamp", async () => {
    await withFile(Array.from({ length: 2000 }, () => "no timestamp here ".repeat(5) + "\n").join(""), async (fh, size) => {
      assert.equal(await seekByTs(fh, size, key(1), tsOf, false), 0);
    });
  });
  it("a giant tail line (no newline in the probed half) narrows the window without erroring", async () => {
    await withFile(`${Array.from({ length: 50 }, (_, i) => line(i)).join("")}${"g".repeat(400_000)}\n`, async (fh, size) => {
      const off = await seekByTs(fh, size, key(10), tsOf, false);
      assert.ok(off >= 0 && off <= size);
    });
  });
  it("counts the probe bytes in stats and stays far below the file size", async () => {
    await withFile(text, async (fh, size) => {
      const stats: ScanStats = { bytes: 0 };
      await seekByTs(fh, size, key(1500), tsOf, false, stats);
      assert.ok(stats.bytes > 0 && stats.bytes < size / 4, String(stats.bytes));
    });
  });
});
