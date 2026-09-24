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
  it("throws LineTooLong past 4 MiB without buffering more", () => {
    const d = new LineDecoder();
    assert.throws(() => d.push(Buffer.alloc(MAX_LINE_BYTES + 1, 0x61)), LineTooLong);
  });
  it("throws on invalid JSON with the offending line kept out of the stream", () => {
    const d = new LineDecoder();
    assert.throws(() => d.push(Buffer.from("{nope}\n")), SyntaxError);
    assert.deepEqual(d.push(encodeLine({ ok: true })), [{ ok: true }]);
  });
});
