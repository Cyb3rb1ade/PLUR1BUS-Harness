import assert from "node:assert/strict";
import { test } from "node:test";
import { MATRIX_MAX_BODY_BYTES, splitMessage } from "../src/split.ts";

const bytes = (s: string) => new TextEncoder().encode(s).length;

test("short text is returned unchanged; whitespace-only text yields nothing", () => {
  assert.deepEqual(splitMessage("hello"), ["hello"]);
  assert.deepEqual(splitMessage("   \n  "), []);
  assert.deepEqual(splitMessage(""), []);
});

test("default size is conservative (16000 bytes)", () => {
  assert.equal(MATRIX_MAX_BODY_BYTES, 16_000);
});

test("long prose splits on line boundaries and every chunk fits", () => {
  const line = "lorem ipsum dolor sit amet ".repeat(4).trim();
  const text = Array.from({ length: 200 }, (_, i) => `${i} ${line}`).join("\n");
  const chunks = splitMessage(text, 1024);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(bytes(c) <= 1024, `chunk of ${bytes(c)} bytes`);
  assert.equal(chunks.join("\n").replace(/\n+/g, "\n"), text.replace(/\n+/g, "\n"));
});

test("over-long single line is hard split on code points, never inside a surrogate pair", () => {
  const text = "😀".repeat(400); // 4 bytes each, 1600 bytes total
  const chunks = splitMessage(text, 512);
  assert.ok(chunks.length >= 4);
  for (const c of chunks) {
    assert.ok(bytes(c) <= 512);
    assert.doesNotThrow(() => new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(c)));
    assert.ok(!/[\ud800-\udbff]$/.test(c) && !/^[\udc00-\udfff]/.test(c));
  }
  assert.equal(chunks.join(""), text);
});

// Table-driven: a fenced block longer than the limit must be closed at the end of each chunk and reopened with the same
// fence in the next one, so no chunk ever leaves a fence open for the client to render as the rest of the message.
const fenceCases: [string, string][] = [
  ["backtick fence", "```ts"],
  ["tilde fence", "~~~python"],
  ["long fence", "````md"],
];
for (const [name, open] of fenceCases) {
  test(`code fence is closed and reopened across chunks: ${name}`, () => {
    const marker = open.match(/^[`~]+/)![0];
    const body = Array.from({ length: 120 }, (_, i) => `const value${i} = ${i} * ${i};`).join("\n");
    const text = `intro\n${open}\n${body}\n${marker}\noutro`;
    const chunks = splitMessage(text, 700);
    assert.ok(chunks.length > 1);
    for (const c of chunks) {
      assert.ok(bytes(c) <= 700, `chunk ${bytes(c)}`);
      const fences = c.split("\n").filter((l) => /^ {0,3}(`{3,}|~{3,})/.test(l)).length;
      assert.equal(fences % 2, 0, `unbalanced fences in chunk:\n${c}`);
    }
    assert.ok(chunks.slice(1).some((c) => c.startsWith(open)), "next chunk reopens the fence with its opening line");
    assert.ok(chunks.at(-1)!.endsWith("outro"));
  });
}

test("chunks never become whitespace-only", () => {
  const text = `${"a".repeat(900)}\n\n\n\n${"b".repeat(900)}`;
  for (const c of splitMessage(text, 1000)) assert.ok(c.trim().length > 0);
});

test("invalid max is rejected", () => {
  assert.throws(() => splitMessage("x", 10), RangeError);
  assert.throws(() => splitMessage("x", 1.5), RangeError);
});
