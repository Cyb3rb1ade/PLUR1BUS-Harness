import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { joinBlocks } from "../src/join.ts";

const b = (name: string, text: string, droppable = true) => ({ name, text, droppable, chars: text.length });

describe("joinBlocks", () => {
  it("joins in order with blank lines when under the cap", () => {
    const r = joinBlocks([b("time", "now"), b("memories", "- a")], 100);
    assert.deepEqual(r, { text: "now\n\n- a", deferrals: [] });
  });
  it("clips the last droppable block first and records the deferral", () => {
    const r = joinBlocks([b("start", "S", false), b("memories", "0123456789"), b("reminder", "R")], 9);
    assert.equal(r.text, "S\n\n0123\n\nR".length <= 9 ? r.text : r.text);
    assert.ok(r.text.length <= 9);
    assert.equal(r.deferrals.length, 1);
    assert.deepEqual(r.deferrals[0], { block: "memories", kind: "clipped", from: 10, to: 10 - (("S\n\n0123456789\n\nR").length - 9), reason: "global-cap" });
  });
  it("drops droppable blocks that cannot fit at all, never a non-droppable one", () => {
    const r = joinBlocks([b("start", "SSSSS", false), b("memories", "MMMMM"), b("reminder", "RRRRR")], 6);
    assert.equal(r.text, "SSSSS");
    assert.deepEqual(r.deferrals.map((d) => [d.block, d.kind]), [["memories", "dropped"], ["reminder", "dropped"]]);
  });
  it("I4: never splits a surrogate pair when the cap lands inside an emoji; reports the adjusted length", () => {
    const text = "abc\u{1F600}def"; // the emoji is 2 UTF-16 units, at indexes 3 and 4
    const r = joinBlocks([b("memories", text)], 4); // a plain slice(0, 4) would end on the high surrogate
    assert.equal(r.text, "abc");
    assert.equal(r.text.isWellFormed(), true);
    assert.deepEqual(r.deferrals, [{ block: "memories", kind: "clipped", from: text.length, to: 3, reason: "global-cap" }]);
    assert.equal(joinBlocks([b("memories", text)], 5).text, "abc\u{1F600}", "a cap just past the pair keeps it whole");
    assert.equal(JSON.stringify(r.text).includes("\\ud"), false);
  });
  it("I4: a block that is only one non-BMP character is dropped, not clipped to a lone surrogate", () => {
    const r = joinBlocks([b("start", "S", false), b("memories", "\u{1F600}")], 4);
    assert.equal(r.text, "S");
    assert.deepEqual(r.deferrals.map((d) => [d.block, d.kind]), [["memories", "dropped"]]);
  });
  it("Infinity cap joins everything", () => {
    assert.equal(joinBlocks([b("a", "x".repeat(50_000))], Number.POSITIVE_INFINITY).text.length, 50_000);
  });
});
