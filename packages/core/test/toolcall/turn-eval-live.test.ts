/** N-G2: live evaluation refuses missing credentials/config and gates only measured real-adapter evidence. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTurnEvalAdapter, parseTurnEvalModels, turnEvalLiveGate } from "../../src/toolcall/turn-eval-live.ts";
import { runTurnEval } from "../../src/toolcall/turn-eval.ts";

const VALID = {
  provider: "provider", model: "model", baseUrl: "https://provider.example/v1", keyEnv: "PROVIDER_KEY",
  wireFormat: "chat_completions",
};

describe("live turn eval configuration and gates", () => {
  it("rejects absent, empty or malformed model configuration with an actionable error", () => {
    for (const value of [undefined, "", "[]", "{}", "broken"]) {
      assert.throws(() => parseTurnEvalModels(value), /PLUR1BUS_TURN_EVAL_MODELS/);
    }
  });

  it("accepts the four provider wires and rejects credentials embedded in a URL", () => {
    for (const wireFormat of ["chat_completions", "codex_responses", "anthropic_messages", "gemini"]) {
      const models = parseTurnEvalModels(JSON.stringify([{ ...VALID, wireFormat }]));
      assert.equal(models[0]!.wireFormat, wireFormat);
    }
    const embeddedCredential = { ...VALID, baseUrl: "https://user:secret@example.com" };
    assert.throws(() => parseTurnEvalModels(JSON.stringify([embeddedCredential])));
    assert.throws(() => parseTurnEvalModels(JSON.stringify([{ ...VALID, wireFormat: "unknown" }])));
  });

  it("refuses a configured credential name with no value and permits explicit keyless local endpoints", () => {
    const model = parseTurnEvalModels(JSON.stringify([VALID]))[0]!;
    assert.throws(() => createTurnEvalAdapter(model, {}), /PROVIDER_KEY/);
    const localConfig = { ...VALID, local: true, baseUrl: "http://127.0.0.1:8080/v1" };
    const local = parseTurnEvalModels(JSON.stringify([localConfig]))[0]!;
    assert.equal(typeof createTurnEvalAdapter(local, {}).stream, "function");
  });

  it("never accepts fixture reports as live quality evidence", async () => {
    const report = await runTurnEval([]);
    assert.equal(turnEvalLiveGate(report).passed, false);
    assert.ok(turnEvalLiveGate(report).failures.includes("real model evidence required"));
  });

  it("rejects the exact target misses while preserving the 95/5/90 percent boundaries", async () => {
    const report = { ...await runTurnEval([]), evidence: "live" as const };
    report.denominators.tools = 20;
    report.denominators.skills = 10;
    report.denominators.neededTurns = 20;
    report.metrics.toolHitRate = .95;
    report.metrics.missingToolRate = .05;
    report.metrics.skillHitRate = .9;
    assert.equal(turnEvalLiveGate(report).passed, true);
    report.metrics.toolHitRate = .949;
    report.metrics.missingToolRate = .051;
    report.metrics.skillHitRate = .899;
    report.metrics.policyViolations = 1;
    assert.equal(turnEvalLiveGate(report).failures.length, 4);
  });
});
