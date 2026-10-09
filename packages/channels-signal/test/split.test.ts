import assert from "node:assert/strict";
import { test } from "node:test";
import { splitMessage, splitStyled, toSignalText, redactString, redactAttrs, TokenBucket } from "../src/index.ts";

test("splitMessage: short text is one chunk, long text respects the limit and is lossless", () => {
  assert.deepEqual(splitMessage("hi"), ["hi"]);
  const text = ("word ".repeat(30) + "\n\n").repeat(40);
  const chunks = splitMessage(text, 500);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 500);
  assert.equal(chunks.join(""), text);
});

test("splitMessage: never tears a surrogate pair", () => {
  const text = "😀".repeat(50);
  for (const max of [2, 3, 5, 7, 33]) {
    const chunks = splitMessage(text, max);
    assert.equal(chunks.join(""), text);
    for (const c of chunks) {
      assert.ok(c.length <= max);
      assert.ok(!/^[\udc00-\udfff]/.test(c) && !/[\ud800-\udbff]$/.test(c), `torn pair at max=${max}`);
    }
  }
});

test("splitMessage: rejects bad max and drops whitespace-only chunks", () => {
  assert.throws(() => splitMessage("x", 1), RangeError);
  assert.deepEqual(splitMessage("   \n  "), []);
});

test("splitStyled: ranges are clipped and re-based per chunk, code blocks reopen", () => {
  const { text, styles } = toSignalText("intro\n\n```\n" + "line of code\n".repeat(30) + "```\nafter **bold** end");
  const chunks = splitStyled({ text, styles }, 100);
  assert.ok(chunks.length > 2);
  let rebuilt = "";
  for (const c of chunks) {
    assert.ok(c.text.length <= 100);
    for (const s of c.styles) assert.ok(s.start >= 0 && s.length > 0 && s.start + s.length <= c.text.length);
    rebuilt += c.text;
  }
  assert.equal(rebuilt, text);
  const mono = chunks.filter((c) => c.styles.some((s) => s.style === "MONOSPACE"));
  assert.ok(mono.length >= 3, "monospace reopened on every chunk the block touches");
  const last = chunks.at(-1)!;
  const bold = last.styles.find((s) => s.style === "BOLD")!;
  assert.equal(last.text.slice(bold.start, bold.start + bold.length), "bold");
});

test("splitStyled: emoji offsets stay correct after a cut", () => {
  const { text, styles } = toSignalText("😀".repeat(10) + " " + "**x😀y**");
  const chunks = splitStyled({ text, styles }, 12);
  const joined = chunks.map((c) => c.styles.map((s) => c.text.slice(s.start, s.start + s.length)).join("|")).filter(Boolean).join("|");
  assert.equal(joined, "x😀y");
});

test("redact: numbers, uuids, paths and known values are scrubbed", () => {
  const s = redactString("from +4915112345678 id 123e4567-e89b-12d3-a456-426614174000 at /run/user/1000/signal-cli/socket secretvalue", "secretvalue");
  assert.ok(!/\d{6}|123e4567|\/run|secretvalue/.test(s), s);
  assert.deepEqual(redactAttrs({ a: "+4915112345678", n: 3, ok: true }), { a: "+[redacted]", n: 3, ok: true });
});

test("TokenBucket: waits only when empty (virtual clock)", async () => {
  let now = 0;
  const waits: number[] = [];
  const b = new TokenBucket(2, 1000, () => now, async (ms) => { waits.push(ms); now += ms; });
  const ac = new AbortController();
  await b.take(ac.signal);
  await b.take(ac.signal);
  assert.deepEqual(waits, []);
  await b.take(ac.signal);
  assert.deepEqual(waits, [1000]);
});
