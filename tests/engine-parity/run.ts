import { deepStrictEqual } from "node:assert";
import { existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { assertNoMarkers, compare, isRecord, normalizeStep, type StepResult } from "./lib/diff.ts";
import { renderReport, type Outcome } from "./lib/report.ts";
import { PIN, readGolden, readScenario, scenarioRoot, type Golden, type Scenario } from "./lib/scenario.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const root = join(repo, scenarioRoot);
const goldenRoot = fileURLToPath(new URL("./golden", import.meta.url));

function scenarios(path: string): string[] {
  const info = lstatSync(path);
  if (info.isDirectory()) return readdirSync(path).sort().flatMap(name => scenarios(join(path, name)));
  if (info.isFile() && path.endsWith(".json")) return [path];
  if (info.isSymbolicLink()) throw new Error("scenario paths must be ordinary files and directories");
  return [];
}

function scenarioId(path: string): string {
  const name = relative(root, path).split(sep).join("/");
  if (isAbsolute(name) || !/^[a-z0-9-]+\/[a-z0-9-]+\.json$/.test(name)) {
    throw new Error("use a scenario in tests/engine-parity/scenarios/<area>/<name>.json");
  }
  return name.slice(0, -".json".length);
}

function resultError(step: StepResult): string | undefined {
  const error = isRecord(step.result) ? step.result.error : undefined;
  if (!isRecord(error) || typeof error.code !== "string") return undefined;
  return error.reason ? `${error.code}/${String(error.reason)}` : error.code;
}

function differences(scenario: Scenario, expected: StepResult[], actual: StepResult[]): string[] {
  if (actual.length !== scenario.steps.length || expected.length !== scenario.steps.length) return ["step count differs"];
  return scenario.steps.flatMap((step, index) => {
    const got = actual[index]!;
    const want = step.expect === "golden" ? expected[index]! : normalizeStep(step.expect);
    const at = `step ${index + 1} ${step.op}`;
    const error = resultError(got);
    if (step.expect === "golden" && error) return [`${at}: ${error}`];
    return compare(want, got, step.tolerance, step.traceCompare).map(diff => `${at} ${diff}`);
  });
}

async function record(path: string, name: string, scenario: Scenario, file: string, runNode: (scenario: Scenario) => Promise<StepResult[]>): Promise<Outcome> {
  const steps = await runNode(scenario);
  const second = await runNode(scenario);
  // Use the strict normalized values, not the diff tolerance, to verify deterministic recording.
  try { deepStrictEqual(second, steps); }
  catch {
    const changed = steps.findIndex((step, index) => JSON.stringify(step) !== JSON.stringify(second[index]));
    throw new Error(`Node recording varied between fresh homes at step ${changed + 1}`);
  }
  const errors = differences(scenario, steps, steps);
  if (errors.length) throw new Error(errors.join("; "));
  const golden: Golden = {
    schema: "engine-parity.golden/1",
    recordedFrom: {
      engine: "node", commit: PIN,
      at: existsSync(file) ? readGolden(file, name).recordedFrom.at : new Date().toISOString(),
    },
    steps,
  };
  assertNoMarkers(golden, "recording");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(golden, null, 2) + "\n");
  return { scenario: scenarioId(path), node: "recorded twice", rust: "—", ok: true };
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : "parity run failed";
  try { assertNoMarkers(message, "parity diagnostic"); }
  catch { return "secret marker detected in diagnostic"; }
  return message;
}

function requireOffline(scenario: Scenario): void {
  if (scenario.seams.embedder === "real" || scenario.seams.reranker !== "none") {
    throw new Error("the offline runner supports flat and hash embeddings with reranking disabled");
  }
  if (process.env.PLUR1BUS_ALLOW_TEST_INTERNALS !== "1") {
    throw new Error("set PLUR1BUS_ALLOW_TEST_INTERNALS=1 for offline parity");
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "--") argv.shift();
  const check = argv.indexOf("--check");
  if (check >= 0 && (argv[check + 1] === undefined || argv[check + 1]?.startsWith("--"))) {
    argv.splice(check + 1, 0, scenarioRoot);
  }
  const { values: options } = parseArgs({ args: argv, options: {
    check: { type: "string" }, record: { type: "string" }, compare: { type: "string" },
    "node-only": { type: "boolean" }, report: { type: "string" },
  } });
  const selections = [options.check, options.record, options.compare].filter(value => value !== undefined);
  if (selections.length > 1 || (selections.length === 0 && options.report === undefined)
      || (options["node-only"] && (options.record !== undefined || options.compare !== undefined))) {
    throw new Error("usage: pnpm parity --check|--record|--compare <scenario or directory> [--node-only] [--report <file>]");
  }
  const selected = resolve(repo, selections[0] ?? scenarioRoot);
  if (selected !== root) {
    const fromRoot = relative(root, selected);
    if (isAbsolute(fromRoot) || fromRoot.startsWith("..")) throw new Error("scenario input must be inside the parity scenario directory");
  }
  const paths = scenarios(selected);
  if (!paths.length || (options.compare !== undefined && paths.length !== 1)) throw new Error("no scenarios, or --compare selected more than one");
  const outcomes: Outcome[] = [];
  for (const path of paths) {
    const name = scenarioId(path);
    const file = join(goldenRoot, `${name}.json`);
    const row: Outcome = { scenario: name, node: "—", rust: "—", ok: false };
    outcomes.push(row);
    try {
      const scenario = readScenario(path);
      requireOffline(scenario);
      const { runNode } = await import("./lib/node-side.ts");
      if (options.record !== undefined) {
        Object.assign(row, await record(path, name, scenario, file, runNode));
        continue;
      }
      const expected = readGolden(file, name).steps;
      let node: StepResult[] | undefined;
      try {
        node = await runNode(scenario);
        const mismatches = differences(scenario, expected, node);
        row.node = mismatches.join("; ") || "pass";
      } catch (error) { row.node = errorText(error); }
      if (!options["node-only"]) {
        try {
          const { runRust } = await import("./lib/rust-side.ts");
          const rust = await runRust(scenario);
          const mismatches = differences(scenario, expected, rust);
          row.rust = mismatches.join("; ") || "pass";
          if (options.compare !== undefined) console.log(JSON.stringify({ scenario: name, node, rust }, null, 2));
        } catch (error) { row.rust = errorText(error); }
      }
      row.ok = row.node === "pass" && (options["node-only"] === true || row.rust === "pass");
    } catch (error) { row.node = errorText(error); }
  }
  const report = renderReport(outcomes);
  if (options.report) writeFileSync(resolve(options.report), report);
  console.log(report);
  if (outcomes.some(row => !row.ok)) process.exitCode = 1;
}

main().catch(error => {
  console.error(errorText(error));
  process.exitCode = 1;
});
