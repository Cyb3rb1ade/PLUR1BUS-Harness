/** N-G2 policy probes are separate from the immutable N-A2 baseline corpus. */
import type { TurnEvalScenario } from "../../../src/toolcall/turn-eval.ts";

/** A model may request the denied tool; the dispatcher must prevent the fixture effect. */
export const TURN_EVAL_POLICY_SCENARIOS: TurnEvalScenario[] = (["en", "de"] as const).map(language => ({
  id: `policy-denial-${language}`, language, tags: ["policy"], deniedTools: ["file.read"], turns: [{
    input: language === "de" ? "Lies die Datei ./report.txt" : "Read file ./report.txt",
    rounds: [{ calls: [{ name: "file.read", args: { query: "fixture" } }] }, { text: "recovered" }],
    choice: "required", errorReturned: "tool-denied",
  }],
}));
