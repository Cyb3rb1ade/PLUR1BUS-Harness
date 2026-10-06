import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, normalizeText, sha256Hex } from "../../src/prompt/canonical.ts";

describe("canonicalJson (ADR-010 R3)", () => {
  it("sorts keys at every depth, independent of insertion order", () => {
    const a = { b: 1, a: { d: [3, { y: 1, x: 2 }], c: "z" } };
    const b = { a: { c: "z", d: [3, { x: 2, y: 1 }] }, b: 1 };
    assert.equal(canonicalJson(a), canonicalJson(b));
    assert.equal(canonicalJson(a), '{"a":{"c":"z","d":[3,{"x":2,"y":1}]},"b":1}');
  });
  it("orders keys by code point, not UTF-16 code unit", () => {
    // U+FF5E (BMP, code unit 0xFF5E) sorts before U+1F600 (astral, first code unit 0xD83D) by code unit, after it by code point.
    const order = Object.keys(JSON.parse(canonicalJson({ "\u{1F600}": 1, "～": 2 })));
    assert.deepEqual(order, ["～", "\u{1F600}"]);
  });
  it("normalises strings (values and keys) to NFC", () => {
    assert.equal(canonicalJson({ "é": "å" }), canonicalJson({ "é": "å" }));
  });
  it("replaces lone surrogates so the output is always well-formed", () => {
    assert.equal(canonicalJson("a\ud83db").isWellFormed(), true);
    assert.equal(canonicalJson("a\ud83db"), '"a�b"');
  });
  it("renders -0 as 0 and refuses non-finite numbers, undefined array items, bigint, functions and non-plain objects", () => {
    assert.equal(canonicalJson([-0, 1.5, 1e21]), "[0,1.5,1e+21]");
    for (const bad of [NaN, Infinity, [undefined], 1n, () => 1, new Date(0), new Map(), Symbol("x")]) {
      assert.throws(() => canonicalJson(bad as never), TypeError, String(bad));
    }
  });
  it("omits undefined object properties (optional fields) but keeps null", () => {
    assert.equal(canonicalJson({ a: undefined, b: null }), '{"b":null}');
  });
  it("refuses cycles", () => {
    const o: Record<string, unknown> = {}; o.self = o;
    assert.throws(() => canonicalJson(o), TypeError);
  });
});

describe("normalizeText", () => {
  it("NFC, LF line ends, well-formed", () => {
    assert.equal(normalizeText("é\r\nx\ry\ud83d"), "é\nx\ny�");
  });
});

describe("sha256Hex", () => {
  it("hashes UTF-8 bytes", () => {
    assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
