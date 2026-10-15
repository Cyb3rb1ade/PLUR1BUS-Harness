import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { errorCode, stage } from "../../src/composition/trace.ts";
import { currentTrace, newTrace, withTrace } from "../../src/logs/trace.ts";
import { recordingLog } from "./helpers.ts";

describe("composition/trace errorCode", () => {
  // characterization: Ist-Verhalten, nicht spezifiziert. errorCode has no documented contract beyond "source error codes
  // survive" (docs/architecture/turn-pipeline.md); the precedence code > kind > "turn-failed" is pinned as it is.
  const table: [string, unknown, string][] = [
    ["string code", { code: "tool-denied" }, "tool-denied"],
    ["string kind", { kind: "rate_limit" }, "rate_limit"],
    ["characterization: code wins over kind", { code: "a", kind: "b" }, "a"],
    ["characterization: non-string code falls through to kind", { code: 429, kind: "overloaded" }, "overloaded"],
    ["characterization: non-string code and kind", { code: 1, kind: 2 }, "turn-failed"],
    ["Error without code", new Error("boom"), "turn-failed"],
    ["Error with code", Object.assign(new Error("boom"), { code: "ENOENT" }), "ENOENT"],
    ["null", null, "turn-failed"],
    ["undefined", undefined, "turn-failed"],
    ["string", "boom", "turn-failed"],
    ["number", 42, "turn-failed"],
    ["empty object", {}, "turn-failed"],
    ["an empty code is no code: the fallback", { code: "" }, "turn-failed"],
    ["an empty code falls through to a string kind", { code: "", kind: "rate_limit" }, "rate_limit"],
    ["an empty code and an empty kind give the fallback", { code: "", kind: "" }, "turn-failed"],
  ];
  for (const [name, input, expected] of table) it(name, () => assert.equal(errorCode(input), expected));
});

describe("composition/trace stage", () => {
  const live = () => new AbortController().signal;

  it("logs start then end around the work and returns its value", async () => {
    const { records, log } = recordingLog();
    const value = await stage("unit", live(), log, () => 7);
    assert.equal(value, 7);
    assert.deepEqual(records.map((r) => [r.stage, r.phase]), [["unit", "start"], ["unit", "end"]]);
    assert.equal(typeof records[1]!.durationMs, "number");
    assert.ok(records[1]!.durationMs! >= 0);
    assert.equal(records[0]!.span_id, records[1]!.span_id);
    assert.match(records[0]!.trace_id, /^[0-9a-f]{32}$/);
    assert.match(records[0]!.span_id, /^[0-9a-f]{16}$/);
  });

  it("awaits an async body", async () => {
    const { records, log } = recordingLog();
    const value = await stage("async", live(), log, async () => { await Promise.resolve(); return "later"; });
    assert.equal(value, "later");
    assert.equal(records.at(-1)!.phase, "end");
  });

  it("rethrows the original exception object and logs an error record with its code", async () => {
    const { records, log } = recordingLog();
    const boom = Object.assign(new Error("boom"), { code: "tool-denied" });
    await assert.rejects(() => stage("fail", live(), log, () => { throw boom; }), (e) => e === boom);
    assert.deepEqual(records.map((r) => r.phase), ["start", "error"]);
    assert.equal(records[1]!.code, "tool-denied");
    assert.ok(!records.some((r) => r.phase === "end"));
  });

  it("an error without a code is logged as turn-failed", async () => {
    const { records, log } = recordingLog();
    await assert.rejects(() => stage("fail", live(), log, () => { throw new Error("x"); }), /x/);
    assert.equal(records[1]!.code, "turn-failed");
  });

  it("a signal that is already aborted throws before the work runs and before anything is logged", async () => {
    const { records, log } = recordingLog();
    const ac = new AbortController(); const reason = new Error("cancelled"); ac.abort(reason);
    let ran = false;
    await assert.rejects(() => stage("pre", ac.signal, log, () => { ran = true; }), (e) => e === reason);
    assert.equal(ran, false);
    assert.deepEqual(records, []);
  });

  it("a signal aborted during the work is checked after it: error record, no end record, no value", async () => {
    const { records, log } = recordingLog();
    const ac = new AbortController(); const reason = new Error("cancelled mid-flight");
    await assert.rejects(() => stage("mid", ac.signal, log, () => { ac.abort(reason); return "late"; }), (e) => e === reason);
    assert.deepEqual(records.map((r) => r.phase), ["start", "error"]);
  });

  it("nested stages share the trace and are parented to the enclosing span", async () => {
    const { records, log } = recordingLog();
    await stage("outer", live(), log, async () => { await stage("inner", live(), log, () => 1); });
    const [outerStart, innerStart] = records;
    assert.equal(outerStart!.stage, "outer"); assert.equal(innerStart!.stage, "inner");
    assert.equal(innerStart!.trace_id, outerStart!.trace_id);
    assert.equal(innerStart!.parent_span_id, outerStart!.span_id);
    assert.notEqual(innerStart!.span_id, outerStart!.span_id);
  });

  it("an existing trace is the parent; the stage's own span becomes the current trace inside the body", async () => {
    const { records, log } = recordingLog();
    const parent = newTrace();
    let inside: ReturnType<typeof currentTrace>;
    await withTrace(parent, () => stage("child", live(), log, () => { inside = currentTrace(); }));
    assert.equal(records[0]!.trace_id, parent.trace_id);
    assert.equal(records[0]!.parent_span_id, parent.span_id);
    assert.equal(inside!.span_id, records[0]!.span_id);
    assert.equal(inside!.traceparent, `00-${parent.trace_id}-${records[0]!.span_id}-01`);
  });

  it("without a surrounding trace each top-level stage starts a fresh trace", async () => {
    const { records, log } = recordingLog();
    await stage("a", live(), log, () => 1);
    await stage("b", live(), log, () => 2);
    assert.notEqual(records[0]!.trace_id, records[2]!.trace_id);
  });

  it("sibling stages get distinct span ids under the same parent", async () => {
    const { records, log } = recordingLog();
    await withTrace(newTrace(), async () => { await stage("a", live(), log, () => 1); await stage("b", live(), log, () => 2); });
    const starts = records.filter((r) => r.phase === "start");
    assert.notEqual(starts[0]!.span_id, starts[1]!.span_id);
    assert.equal(starts[0]!.parent_span_id, starts[1]!.parent_span_id);
  });
});
