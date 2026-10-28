/** N-A2/G1: explicit baseline capture and strict regression gate over the actual turn provider. */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { runTurnEval } from "../../packages/core/src/toolcall/turn-eval.ts";
import { TURN_EVAL_SCENARIOS } from "../../packages/core/test/fixtures/turn-eval/scenarios.ts";

const args = process.argv.slice(2);
const baseline = args.includes("--baseline");
const outputIndex = args.indexOf("--out");
const output = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
if (outputIndex >= 0 && (!output || output.startsWith("--"))) throw new Error("--out requires a report file path");
for (const [index, arg] of args.entries()) {
  if (index === outputIndex + 1 && outputIndex >= 0) continue;
  if (!["--baseline", "--regression", "--out"].includes(arg)) throw new Error("unknown turn eval argument");
}
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
