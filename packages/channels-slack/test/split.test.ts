import assert from "node:assert/strict";
import { test } from "node:test";
import { SLACK_MAX_TEXT, splitMessage } from "../src/index.ts";

test("short text is one chunk; empty and whitespace-only text yields nothing", () => {
  assert.deepEqual(splitMessage("hello"), ["hello"]);
  assert.deepEqual(splitMessage("   \n\n  "), []);
});

test("long text splits within the limit, losslessly, preferring paragraph breaks", () => {
  const para = "p".repeat(2000);
  const text = `${para}\n\n${para}\n\n${para}`;
  const parts = splitMessage(text, SLACK_MAX_TEXT);
  assert.ok(parts.length >= 2);
  for (const p of parts) assert.ok(p.length <= SLACK_MAX_TEXT, `chunk ${p.length}`);
  assert.equal(parts.join("").replace(/\s/g, ""), text.replace(/\s/g, ""));
  assert.equal(parts[0], `${para}\n\n`);
});

test("never splits a surrogate pair", () => {
  const emoji = "\u{1F600}";
  const text = "a".repeat(9) + emoji.repeat(20);
  for (let max = 16; max < 40; max++) {
    for (const p of splitMessage(text, max)) {
      assert.ok(!/[\ud800-\udbff]$/.test(p), `lone high surrogate at max=${max}`);
      assert.ok(!/^[\udc00-\udfff]/.test(p), `lone low surrogate at max=${max}`);
    }
  }
});

test("never tears an angle-bracket token", () => {
  const link = "<https://example.test/" + "x".repeat(10) + "|label>"; // a token that fits one chunk
  const text = "w".repeat(20) + " " + link + " " + "z".repeat(20);
  for (const p of splitMessage(text, 50)) {
    assert.ok(p.length <= 50);
    const opens = (p.match(/</g) ?? []).length;
    const closes = (p.match(/>/g) ?? []).length;
    assert.equal(opens, closes, p);
  }
});

test("code fences are closed at a chunk end and reopened at the next start", () => {
  const body = Array.from({ length: 30 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
  const text = "```\n" + body + "\n```";
  const parts = splitMessage(text, 200);
  assert.ok(parts.length > 1);
  for (const [i, p] of parts.entries()) {
    const fences = (p.match(/^```/gm) ?? []).length;
    assert.equal(fences % 2, 0, `chunk ${i} has balanced fences`);
    assert.ok(p.length <= 200);
  }
  assert.ok(parts[1]!.startsWith("```\n"));
});

test("rejects bad max", () => {
  assert.throws(() => splitMessage("x", 4), RangeError);
  assert.throws(() => splitMessage("x", 1.5), RangeError);
});
