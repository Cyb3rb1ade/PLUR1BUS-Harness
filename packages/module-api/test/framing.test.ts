import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LineDecoder, LineTooLong, MAX_LINE_BYTES, encodeLine } from "../src/framing.ts";

describe("framing", () => {
  it("round-trips one value per line, across chunk boundaries", () => {
    const d = new LineDecoder();
    const a = encodeLine({ id: 1 }); const b = encodeLine({ id: 2, s: "ü\n" });
    const all = Buffer.concat([a, b]);
    const out = [...d.push(all.subarray(0, 5)), ...d.push(all.subarray(5))];
    assert.deepEqual(out, [{ id: 1 }, { id: 2, s: "ü\n" }]);
  });
  it("I4 backstop: a lone surrogate goes out as U+FFFD, never a \\udXXX escape; pairs and literal backslashes are untouched", () => {
    const line = encodeLine({ joined: { text: "abc\ud83d" }, lone: ["\ude00x"], pair: "\u{1F600}", literal: "C:\\ud800" }).toString("utf8");
    assert.equal(/\\ud[89a-f]/i.test(line.replaceAll("\\\\", "")), false, line);
    assert.deepEqual(JSON.parse(line), { joined: { text: "abc\uFFFD" }, lone: ["\uFFFDx"], pair: "\u{1F600}", literal: "C:\\ud800" });
  });
  it("throws LineTooLong past 4 MiB without buffering more", () => {
    const d = new LineDecoder();
    assert.throws(() => d.push(Buffer.alloc(MAX_LINE_BYTES + 1, 0x61)), LineTooLong);
  });
  it("decode keeps the valid lines of a chunk that also holds an unparseable one (Low)", { timeout: 10_000 }, () => {
    const d = new LineDecoder();
    const chunk = Buffer.concat([encodeLine({ id: 1 }), Buffer.from("{nope}\n"), encodeLine({ id: 2 })]);
    const r = d.decode(chunk);
    assert.deepEqual(r.values, [{ id: 1 }, { id: 2 }]);
    assert.equal(r.bad.length, 1);
    assert.ok(r.bad[0] instanceof SyntaxError);
    assert.equal(r.tooLong, undefined);
  });
  it("decode reports an over-long tail without losing the lines before it", { timeout: 10_000 }, () => {
    const d = new LineDecoder();
    const r = d.decode(Buffer.concat([encodeLine({ id: 1 }), Buffer.alloc(MAX_LINE_BYTES + 1, 0x61)]));
    assert.deepEqual(r.values, [{ id: 1 }]);
    assert.ok(r.tooLong instanceof LineTooLong);
  });
  it("push still throws, now after the whole chunk was consumed, and hands over what it parsed", { timeout: 10_000 }, () => {
    const d = new LineDecoder();
    try { d.push(Buffer.concat([encodeLine({ id: 1 }), Buffer.from("{nope}\n")])); assert.fail("push must throw"); }
    catch (e) { assert.deepEqual((e as { parsed?: unknown[] }).parsed, [{ id: 1 }]); }
  });
  it("throws on invalid JSON with the offending line kept out of the stream", () => {
    const d = new LineDecoder();
    assert.throws(() => d.push(Buffer.from("{nope}\n")), SyntaxError);
    assert.deepEqual(d.push(encodeLine({ ok: true })), [{ ok: true }]);
  });
});
