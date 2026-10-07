import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LineReader, encodeLine } from "../../src/acp/framing.ts";

const b = (s: string) => Buffer.from(s, "utf8");

describe("acp framing", () => {
  it("splits lines across chunks, handles CRLF and multi-byte characters cut mid-sequence", () => {
    const r = new LineReader(1024);
    const euro = b("{\"a\":\"€\"}\n");
    assert.deepEqual(r.push(euro.subarray(0, 8)), []);
    assert.deepEqual(r.push(Buffer.concat([euro.subarray(8), b("{\"b\":1}\r\n\n")])), [{ line: "{\"a\":\"€\"}" }, { line: "{\"b\":1}" }]);
  });

  it("an oversize line is reported once, its remainder is discarded up to the newline, the next line is fine", () => {
    const r = new LineReader(16);
    assert.deepEqual(r.push(b("x".repeat(40))), [{ overflow: true }]);
    assert.deepEqual(r.push(b("y".repeat(40))), [], "still discarding, not reported again");
    assert.deepEqual(r.push(b("zz\n{\"ok\":1}\n")), [{ line: "{\"ok\":1}" }]);
  });

  it("a line of exactly the limit passes; one byte more does not (limit counts bytes, not characters)", () => {
    const r = new LineReader(6);
    assert.deepEqual(r.push(b("123456\n")), [{ line: "123456" }]);
    assert.deepEqual(r.push(b("1234567\n")), [{ overflow: true }]);
    assert.deepEqual(new LineReader(4).push(b("€€\n")), [{ overflow: true }]);
  });

  it("end() yields an unterminated last line", () => {
    const r = new LineReader(64);
    r.push(b("{\"last\":true}"));
    assert.deepEqual(r.end(), [{ line: "{\"last\":true}" }]);
    assert.deepEqual(r.end(), []);
  });

  it("encodeLine is one line of JSON, even for text that contains newlines and U+2028", () => {
    const s = encodeLine({ t: "a\nb c" });
    assert.equal(s.endsWith("\n"), true);
    assert.equal(s.slice(0, -1).includes("\n"), false);
    assert.deepEqual(JSON.parse(s), { t: "a\nb c" });
  });
});
