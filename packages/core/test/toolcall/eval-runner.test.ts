// core/toolcall eval runner: scenario execution, unknown/denied/failed tool outcomes, repair accounting, report arithmetic
// (zero denominators), live-mode gating, error containment. Scenarios here are built inline; the fixture corpus stays with eval.test.ts.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runScenario, runEval, report, markdownReport, fakeModel, type EvalScenario, type EvalModelPort, type EvalTool, type ScenarioResult } from "../../src/toolcall/eval.ts";
import type { ToolCall } from "../../../providers/src/types.ts";

const searchDef = { name: "search", description: "Search the web", parameters: { type: "object", additionalProperties: false, required: ["query"], properties: { query: { type: "string", minLength: 1 }, count: { type: "integer", minimum: 1 } } } } as const;
const tool = (over: Partial<EvalTool> = {}): EvalTool => ({
  entry: { id: "search", name: "search", description: "Search reviews online", category: "web.research", kind: "tool", effect: "read", risk: "low", source: "inline", version: "1" },
  definition: searchDef as never, ...over,
});
const other = (): EvalTool => ({ entry: { id: "calendar", name: "calendar", description: "Calendar events", category: "comm.calendar", kind: "tool", effect: "read", risk: "low", source: "inline", version: "1" }, definition: { name: "calendar", description: "d", parameters: { type: "object", additionalProperties: false, properties: {} } } as never });
const call = (name: string, argumentsRaw: string, id = "c1"): ToolCall => ({ id, name, argumentsRaw });
// "Search laptop reviews" -> rule classifier: one task [0,21), web.research, medium class.
function scenario(over: Partial<EvalScenario> = {}): EvalScenario {
  return {
    id: "inline-1", input: "Search laptop reviews", family: "openai-chat", tools: [tool(), other()],
    expected: { calls: [{ name: "search", arguments: { query: "laptops" }, outcome: "ok" }], tasks: [{ start: 0, end: 21, category: "web.research", minimumClass: "medium" }], needed: ["search"] },
    transcript: { calls: [call("search", "{\"query\":\"laptops\"}")] }, tags: [], ...over,
  };
}

describe("runScenario", () => {
  it("a consistent scenario passes with exact accounting", async () => {
    const r = await runScenario(scenario());
    assert.deepEqual(r, { id: "inline-1", passed: true, routingHits: 1, routingTotal: 1, segmentationMatches: 1, predictedSegments: 1, expectedSegments: 1, underProvisioned: 0, overProvisioned: 0, classTotal: 1, repairAttempts: 0, repairSuccesses: 0, errors: [] });
  });

  it("a call to a tool that is not part of the scenario is recorded as unknown and never validated or executed", async () => {
    const r = await runScenario(scenario({ transcript: { calls: [call("search", "{\"query\":\"laptops\"}"), call("rm_rf", "{}", "c2")] } }));
    assert.equal(r.passed, false); assert.ok(r.errors.includes("unknown tool:rm_rf"));
    assert.ok(!r.errors.includes("calls or arguments mismatch"), "the known call is still matched, the unknown one is simply not part of the executed calls");
  });

  it("an unknown tool alone yields an error and no executed call", async () => {
    const r = await runScenario(scenario({ transcript: { calls: [call("ghost", "{}")] } }));
    assert.deepEqual(r.errors.sort(), ["calls or arguments mismatch", "unknown tool:ghost"]);
  });

  it("invalid arguments are reported as tool-call-invalid (no repair port output means no rescue)", async () => {
    const s = scenario({ transcript: { calls: [call("search", "{\"count\":1}")] }, expected: { ...scenario().expected, calls: [{ name: "search", outcome: "tool-call-invalid" }] } });
    const r = await runScenario(s, fakeModel(s));
    assert.equal(r.passed, true); assert.equal(r.repairAttempts, 1); assert.equal(r.repairSuccesses, 0);
  });

  it("a repaired call counts one attempt and one success", async () => {
    const s = scenario({ transcript: { calls: [call("search", "{\"count\":1}")], repairs: [{ query: "laptops" }] } });
    const r = await runScenario(s, fakeModel(s));
    assert.equal(r.passed, true); assert.equal(r.repairAttempts, 1); assert.equal(r.repairSuccesses, 1);
  });

  it("denied and failing tools are reported with their outcome, still with validated arguments", async () => {
    for (const [flag, outcome] of [["denied", "tool-denied"], ["failure", "tool-failed"]] as const) {
      const s = scenario({ tools: [tool({ [flag]: true }), other()], expected: { ...scenario().expected, calls: [{ name: "search", arguments: { query: "laptops" }, outcome }] } });
      assert.equal((await runScenario(s)).passed, true, flag);
    }
  });

  it("the expected outcome is compared, not assumed: a denied tool expected as ok fails", async () => {
    const r = await runScenario(scenario({ tools: [tool({ denied: true }), other()] }));
    assert.equal(r.passed, false); assert.ok(r.errors.includes("calls or arguments mismatch"));
  });

  it("the model's call order and arguments must match exactly", async () => {
    const two = scenario({ expected: { ...scenario().expected, calls: [{ name: "search", arguments: { query: "a" }, outcome: "ok" }, { name: "search", arguments: { query: "b" }, outcome: "ok" }] } });
    const inOrder = await runScenario({ ...two, transcript: { calls: [call("search", "{\"query\":\"a\"}", "1"), call("search", "{\"query\":\"b\"}", "2")] } });
    const swapped = await runScenario({ ...two, transcript: { calls: [call("search", "{\"query\":\"b\"}", "2"), call("search", "{\"query\":\"a\"}", "1")] } });
    assert.equal(inOrder.passed, true); assert.equal(swapped.passed, false);
  });

  it("a routing miss (needed tool not offered) and a wrong segment are errors", async () => {
    const miss = await runScenario(scenario({ expected: { ...scenario().expected, needed: ["search", "not-in-catalogue"] } }));
    assert.ok(miss.errors.includes("routing miss")); assert.equal(miss.routingHits, 1); assert.equal(miss.routingTotal, 2);
    const seg = await runScenario(scenario({ expected: { ...scenario().expected, tasks: [{ start: 0, end: 5, category: "web.research", minimumClass: "medium" }] } }));
    assert.ok(seg.errors.includes("segmentation mismatch")); assert.equal(seg.underProvisioned, 1);
  });

  it("a wrong expected category is an error even when the segment matches", async () => {
    const r = await runScenario(scenario({ expected: { ...scenario().expected, tasks: [{ start: 0, end: 21, category: "docs.create", minimumClass: "medium" }] } }));
    assert.ok(r.errors.includes("category mismatch"));
  });

  it("class provisioning: a higher minimum than chosen is under-provisioned (an error), a lower one is over-provisioned (allowed)", async () => {
    const under = await runScenario(scenario({ expected: { ...scenario().expected, tasks: [{ start: 0, end: 21, category: "web.research", minimumClass: "frontier" }] } }));
    assert.equal(under.underProvisioned, 1); assert.ok(under.errors.includes("under-provisioned"));
    const over = await runScenario(scenario({ expected: { ...scenario().expected, tasks: [{ start: 0, end: 21, category: "web.research", minimumClass: "small" }] } }));
    assert.equal(over.overProvisioned, 1); assert.equal(over.passed, true);
  });

  it("scenario tools are compiled for the scenario's family: an invalid tool definition makes the scenario throw", async () => {
    await assert.rejects(runScenario(scenario({ tools: [tool({ definition: { name: "bad name", parameters: searchDef.parameters } as never })] })), /invalid tool name/);
  });

  it("a registration that the index refuses throws as well", async () => {
    await assert.rejects(runScenario(scenario({ tools: [tool({ entry: { ...tool().entry, category: "BAD" } })] })), /invalid capability entry/);
  });

  it("the model port gets the offered tool ids, not the expected answers", async () => {
    let seenOffered: readonly string[] = [];
    const model: EvalModelPort = { async calls(_s, offered) { seenOffered = offered; return []; } };
    await runScenario(scenario(), model);
    assert.ok(seenOffered.includes("search"));
  });

  it("the fake model replays the transcript without sharing state between runs", async () => {
    const s = scenario({ transcript: { calls: [call("search", "{\"count\":1}")], repairs: [{ query: "x" }, { query: "y" }] } });
    const m1 = fakeModel(s), m2 = fakeModel(s);
    assert.deepEqual(await m1.repair!({ tool: "t", args: {}, issues: [], message: "" }), { query: "x" });
    assert.deepEqual(await m1.repair!({ tool: "t", args: {}, issues: [], message: "" }), { query: "y" });
    assert.deepEqual(await m2.repair!({ tool: "t", args: {}, issues: [], message: "" }), { query: "x" });
    const calls = await m1.calls(s, []); calls.length = 0;
    assert.equal(s.transcript.calls.length, 1, "the transcript is cloned");
  });
});

describe("report and runEval", () => {
  const result = (over: Partial<ScenarioResult> = {}): ScenarioResult => ({ id: "r", passed: true, routingHits: 1, routingTotal: 1, segmentationMatches: 1, predictedSegments: 1, expectedSegments: 1, underProvisioned: 0, overProvisioned: 0, classTotal: 1, repairAttempts: 0, repairSuccesses: 0, errors: [], ...over });

  it("an empty run has zero metrics and zero denominators, never NaN", () => {
    const r = report([]);
    assert.deepEqual(r.metrics, { scenarioPassRate: 0, routingRecall: 0, repairSuccess: 0, segmentationF1: 0, underProvisioning: 0, overProvisioning: 0 });
    assert.deepEqual(r.denominators, { scenarios: 0, routing: 0, repairs: 0, tasks: 0 });
    for (const v of Object.values(r.metrics)) assert.ok(Number.isFinite(v));
  });

  it("metrics are plain ratios over the summed counters", () => {
    const r = report([
      result({ passed: true, routingHits: 2, routingTotal: 2, segmentationMatches: 2, predictedSegments: 2, expectedSegments: 2, classTotal: 2, repairAttempts: 1, repairSuccesses: 1 }),
      result({ passed: false, routingHits: 0, routingTotal: 2, segmentationMatches: 1, predictedSegments: 3, expectedSegments: 1, classTotal: 1, underProvisioned: 1, overProvisioned: 0, repairAttempts: 1, repairSuccesses: 0 }),
    ]);
    assert.equal(r.metrics.scenarioPassRate, 0.5); assert.equal(r.metrics.routingRecall, 0.5); assert.equal(r.metrics.repairSuccess, 0.5);
    assert.ok(Math.abs(r.metrics.segmentationF1 - (2 * 3) / (5 + 3)) < 1e-12);
    assert.ok(Math.abs(r.metrics.underProvisioning - 1 / 3) < 1e-12); assert.equal(r.metrics.overProvisioning, 0);
    assert.deepEqual(r.denominators, { scenarios: 2, routing: 4, repairs: 2, tasks: 3 });
    assert.equal(r.mode, "fixture"); assert.equal(r.status, "completed");
  });

  it("the report keeps the mode it is given", () => { assert.equal(report([], "live").mode, "live"); });

  it("markdown report prints every metric as a percentage with two decimals and the denominators", () => {
    const md = markdownReport(report([result({ routingHits: 1, routingTotal: 3 })]));
    assert.match(md, /^# Tool eval \(fixture, completed\)/);
    assert.match(md, /\| routingRecall \| 33\.33% \|/); assert.match(md, /\| scenarioPassRate \| 100\.00% \|/);
    assert.match(md, /Scenarios: 1; routing targets: 3; repair attempts: 0; tasks: 1\./);
  });

  it("a skipped live report carries its reason in the markdown", () => {
    const md = markdownReport({ ...report([], "live"), status: "skipped", reason: "PLUR1BUS_LIVE_EVAL=1 required" });
    assert.match(md, /Tool eval \(live, skipped\)/); assert.match(md, /PLUR1BUS_LIVE_EVAL=1 required/);
  });

  it("runEval fixture mode runs every scenario in order", async () => {
    const r = await runEval([scenario({ id: "a" }), scenario({ id: "b" })]);
    assert.deepEqual(r.scenarios.map(s => s.id), ["a", "b"]); assert.equal(r.metrics.scenarioPassRate, 1);
  });

  it("an exception in one scenario is contained: it is reported as a failed scenario and the others still run", async () => {
    const broken = scenario({ id: "broken", tools: [tool({ definition: { name: "bad name", parameters: searchDef.parameters } as never })] });
    const r = await runEval([scenario({ id: "before" }), broken, scenario({ id: "after" })]);
    assert.deepEqual(r.scenarios.map(s => [s.id, s.passed]), [["before", true], ["broken", false], ["after", true]]);
    assert.deepEqual(r.scenarios[1]!.errors, ["scenario raised an error"]);
    assert.equal(r.scenarios[1]!.underProvisioned, 1); assert.equal(r.scenarios[1]!.routingTotal, 1);
    assert.ok(!JSON.stringify(r).includes("bad name"), "the exception text is not copied into the report");
  });

  it("live mode needs the exact flag value '1' in the given env and does not read process.env when env is supplied", async () => {
    let created = 0;
    const model = () => { created++; return fakeModel(scenario()); };
    for (const env of [{}, { PLUR1BUS_LIVE_EVAL: "0" }, { PLUR1BUS_LIVE_EVAL: "true" }, { PLUR1BUS_LIVE_EVAL: "" }, { PLUR1BUS_LIVE_EVAL: undefined }]) {
      const r = await runEval([scenario()], { mode: "live", env, model });
      assert.equal(r.status, "skipped", JSON.stringify(env)); assert.equal(r.reason, "PLUR1BUS_LIVE_EVAL=1 required"); assert.deepEqual(r.scenarios, []);
    }
    assert.equal(created, 0);
    const live = await runEval([scenario()], { mode: "live", env: { PLUR1BUS_LIVE_EVAL: "1" }, model });
    assert.equal(live.status, "completed"); assert.equal(live.mode, "live"); assert.equal(created, 1);
  });

  it("live mode without an explicit model port is refused even when enabled", async () => {
    await assert.rejects(runEval([scenario()], { mode: "live", env: { PLUR1BUS_LIVE_EVAL: "1" } }), /explicit model port/);
  });

  it("a classifier port decides segmentation; a malformed classifier answer is contained as a scenario error", async () => {
    const r = await runEval([scenario()], { classifier: () => ({ schema: "wrong" as never, shape: "chat", tasks: [] }) });
    assert.equal(r.scenarios[0]!.passed, false); assert.deepEqual(r.scenarios[0]!.errors, ["scenario raised an error"]);
  });
});
