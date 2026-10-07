import assert from "node:assert/strict";
import { test } from "node:test";
import { splitMessage } from "../src/index.ts";

test("short text is one chunk", () => assert.deepEqual(splitMessage("hello"), ["hello"]));

test("long text splits at 4096 and is lossless", () => {
  const text = "x".repeat(10_000);
  const parts = splitMessage(text);
  assert.equal(parts.length, 3);
  assert.ok(parts.every((p) => p.length <= 4096));
  assert.equal(parts.join(""), text);
});

test("prefers paragraph, then newline, then space", () => {
  const a = "a".repeat(3000);
  const para = splitMessage(`${a}\n\n${"b".repeat(3000)}`);
  assert.equal(para[0], `${a}\n\n`);
  const words = splitMessage(`${"w ".repeat(3000)}`);
  assert.ok(words.every((p) => p.length <= 4096 && p.endsWith(" ")));
});

test("never splits a surrogate pair", () => {
  const text = "😀".repeat(3000); // 6000 code units
  const parts = splitMessage(text);
  assert.ok(parts.every((p) => p.length <= 4096));
  assert.equal(parts.join(""), text);
  for (const p of parts) assert.doesNotMatch(p, /^[\udc00-\udfff]|[\ud800-\udbff]$/);
});

test("whitespace-only chunks are dropped, empty text yields nothing", () => {
  assert.deepEqual(splitMessage(""), []);
  assert.deepEqual(splitMessage("  \n "), []);
});
