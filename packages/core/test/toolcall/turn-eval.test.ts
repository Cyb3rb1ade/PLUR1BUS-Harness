/** N-A2/G1: the deterministic corpus checks the real composition turn boundary. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runTurnEval, type TurnEvalScenario } from "../../src/toolcall/turn-eval.ts";
import { TURN_EVAL_SCENARIOS } from "../fixtures/turn-eval/scenarios.ts";
import { TURN_EVAL_POLICY_SCENARIOS } from "../fixtures/turn-eval/policy-scenarios.ts";

describe("turn eval over createTurnProvider", () => {
  it("runs every German and English case and reports its harness checks", async () => {
    const report = await runTurnEval(TURN_EVAL_SCENARIOS);
    assert.equal(report.scenarios.length, TURN_EVAL_SCENARIOS.length);
    assert.ok(report.scenarios.every(s => s.checks.length > 0));
    assert.deepEqual(new Set(TURN_EVAL_SCENARIOS.map(s => s.language)), new Set(["de", "en"]));
  });

  it("satisfies tool reachability, skill disclosure, choices and error recovery for every fixture", async () => {
    const report = await runTurnEval(TURN_EVAL_SCENARIOS);
    const failed = report.scenarios.flatMap(s => s.checks.filter(c => !c.passed).map(c => `${s.id}: ${c.name}`));
    assert.deepEqual(failed, []);
  });

  it("measures missing tools from observed execution when an adapter answers without evidence", async () => {
    const scenario: TurnEvalScenario = {
      id: "wrong-adapter", language: "en", tags: ["tool-needed"], turns: [{
        input: "Read file ./report.txt", choice: "auto", requiredTools: ["file.read"], rounds: [],
      }],
    };
    const report = await runTurnEval([scenario], { adapterForScenario: () => ({ async *stream() {
      yield { type: "done", result: {
        text: "invented answer", toolCalls: [], finishReason: "stop", rawFinishReason: "stop", meta: {},
        usage: { inputTokens: 10, outputTokens: 2 },
      } };
    } }) });
    assert.equal(report.evidence, "fixture");
    assert.equal(report.metrics.toolHitRate, 0);
    assert.equal(report.metrics.missingToolRate, 1);
    assert.equal(report.scenarios[0]!.passed, false);
  });

  it("keeps zero denominators finite and reports an empty corpus as zero evidence", async () => {
    const report = await runTurnEval([]);
    assert.deepEqual(report.denominators, {
      scenarios: 0, turns: 0, tools: 0, skills: 0, neededTurns: 0, plainTurns: 0, policyAttempts: 0,
    });
    assert.ok(Object.values(report.metrics).every(value => value === 0));
  });

  it("counts attempted forbidden operations and verifies that policy prevents their execution", async () => {
    const report = await runTurnEval(TURN_EVAL_POLICY_SCENARIOS);
    assert.equal(report.metrics.policyViolations, 0);
    assert.equal(report.denominators.policyAttempts, 2);
    assert.ok(report.scenarios.every(s => s.checks.some(c => c.name.includes("policy blocks") && c.passed)));
  });

  it("counts a policy escape when a deliberately broken policy fixture allows the forbidden effect", async () => {
    const report = await runTurnEval(TURN_EVAL_POLICY_SCENARIOS, {
      providerOptions: { policyContext: () => ({}) },
    });
    assert.equal(report.denominators.policyAttempts, 2);
    assert.equal(report.metrics.policyViolations, 2);
    assert.ok(report.scenarios.every(s => !s.passed));
  });
});
