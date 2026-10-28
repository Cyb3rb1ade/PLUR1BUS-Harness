/** N-A2/G1: explicit baseline capture and strict regression gate over the actual turn provider. */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { runTurnEval } from "../../packages/core/src/toolcall/turn-eval.ts";
import {
  createTurnEvalAdapter, parseTurnEvalModels, turnEvalFamily, turnEvalLiveGate,
} from "../../packages/core/src/toolcall/turn-eval-live.ts";
import { TURN_EVAL_SCENARIOS } from "../../packages/core/test/fixtures/turn-eval/scenarios.ts";
import { TURN_EVAL_POLICY_SCENARIOS } from "../../packages/core/test/fixtures/turn-eval/policy-scenarios.ts";

const args = process.argv.slice(2);
const baseline = args.includes("--baseline");
const live = args.includes("--live");
const regression = args.includes("--regression");
if ([baseline, live, regression].filter(Boolean).length > 1) throw new Error("choose one turn eval mode");
const outputIndex = args.indexOf("--out");
const output = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
if (outputIndex >= 0 && (!output || output.startsWith("--"))) throw new Error("--out requires a report file path");
for (const [index, arg] of args.entries()) {
  if (index === outputIndex + 1 && outputIndex >= 0) continue;
  if (!["--baseline", "--regression", "--live", "--out"].includes(arg)) throw new Error("unknown turn eval argument");
}
if (live) {
  const models = parseTurnEvalModels(process.env.PLUR1BUS_TURN_EVAL_MODELS);
  const reports = [];
  for (const model of models) {
    const adapter = createTurnEvalAdapter(model);
    const report = await runTurnEval([...TURN_EVAL_SCENARIOS, ...TURN_EVAL_POLICY_SCENARIOS], {
      evidence: "live", adapterForScenario: () => adapter, provider: model.provider, model: model.model,
      family: turnEvalFamily(model), providerOptions: { isLocalProvider: () => model.local === true },
    });
    const gate = turnEvalLiveGate(report);
    reports.push({ provider: model.provider, model: model.model, gate, report });
    console.log(JSON.stringify({ provider: model.provider, model: model.model, gate,
      metrics: report.metrics, denominators: report.denominators }, null, 2));
    if (!gate.passed) process.exitCode = 1;
  }
  const path = resolve(output ?? "artifacts/turn-eval/live-reports.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ schema: "plur1bus.turn-eval-models/1", reports }, null, 2)}\n`);
} else {
  const report = await runTurnEval(TURN_EVAL_SCENARIOS);
  const summary = {
    mode: baseline ? "baseline" : "regression", evidence: report.evidence,
    passed: report.scenarios.filter(s => s.passed).length, ...report.denominators, metrics: report.metrics,
    failures: report.scenarios.filter(s => !s.passed).map(s => ({
      id: s.id, checks: s.checks.filter(c => !c.passed).map(c => c.name),
    })),
  };
  if (output) {
    const path = resolve(output);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(summary, null, 2));
  if (!baseline && report.scenarios.some(s => !s.passed)) process.exitCode = 1;
}
