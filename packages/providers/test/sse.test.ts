import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderError, SseParser } from "../src/index.ts";

const T = { timeout: 10_000 };
const enc = (s: string) => new TextEncoder().encode(s);

function parseAll(bytes: Uint8Array, sizes: number[]) {
  const p = new SseParser(1 << 20);
  const out = [];
  let i = 0, k = 0;
  while (i < bytes.length) { const n = sizes[k++ % sizes.length]!; out.push(...p.push(bytes.subarray(i, i + n))); i += n; }
  out.push(...p.end());
  return out;
}

const doc = "id: 7\nevent: ping\ndata: one\n\n: comment\ndata: two\ndata: lines\n\ndata:no-space\n\nretry: 5\n\ndata\n\n";

test("fields, comments, multi-line data, empty data, ignored retry", T, () => {
  assert.deepEqual(parseAll(enc(doc), [1000]), [
    { id: "7", event: "ping", data: "one" },
    { id: "7", data: "two\nlines" },
    { id: "7", data: "no-space" },
    { id: "7", data: "" },
  ]);
});

test("every split of the bytes gives the same events (including 1 byte at a time)", T, () => {
  const want = parseAll(enc(doc), [1000]);
  for (const sizes of [[1], [2], [3], [5, 1], [7, 2, 1]]) assert.deepEqual(parseAll(enc(doc), sizes), want, sizes.join());
});

test("CRLF, CR and LF line ends are equivalent, also when CR and LF are split across chunks", T, () => {
  const lf = "data: a\n\ndata: b\n\n";
  const want = [{ data: "a" }, { data: "b" }];
  assert.deepEqual(parseAll(enc(lf.replaceAll("\n", "\r\n")), [1]), want);
  assert.deepEqual(parseAll(enc(lf.replaceAll("\n", "\r")), [1]), want);
  assert.deepEqual(parseAll(enc(lf.replaceAll("\n", "\r\n")), [8]), want);
});

test("multi-byte UTF-8 split across chunks decodes intact; a BOM at the start is dropped", T, () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...enc("data: Zürich 🌤\n\n")]);
  assert.deepEqual(parseAll(bytes, [1]), [{ data: "Zürich 🌤" }]);
});

test("an event cut off by the end of the stream is dropped", T, () => {
  assert.deepEqual(parseAll(enc("data: whole\n\ndata: cut"), [4]), [{ data: "whole" }]);
});

test("invalid UTF-8 is a protocol error", T, () => {
  const p = new SseParser(1024);
  assert.throws(() => p.push(new Uint8Array([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xff, 0x0a, 0x0a])), (e) => e instanceof ProviderError && e.kind === "unknown");
});

test("an oversized event or line is a protocol error", T, () => {
  const p = new SseParser(64);
  assert.throws(() => { for (let i = 0; i < 10; i++) p.push(enc("data: 0123456789\n")); }, (e) => e instanceof ProviderError && e.kind === "unknown");
  const q = new SseParser(64);
  assert.throws(() => q.push(enc("x".repeat(100))), (e) => e instanceof ProviderError && e.kind === "unknown");
});
