/** D120 B1 owner entry point. No credentials, transcripts, checker diagnostics or raw exceptions enter public output. */
import { lstat, open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { createRedactor, secretFormsIn } from "../../packages/core/src/logs/redact.ts";
import { runCodingBench, runCodingFixture } from "../../packages/core/src/toolcall/coding-bench.ts";
import { codingConfiguration } from "../../packages/core/src/toolcall/coding-bench-live.ts";
import { runCodingSmoke } from "../../packages/core/src/toolcall/coding-bench-smoke.ts";
import { reserveCodingPublication } from "../../packages/core/src/toolcall/coding-bench-publication.ts";
import { loadCodingCorpus } from "../../packages/core/src/toolcall/coding-bench-corpus.ts";
import {
  compareCodingReports,
  mergeCodingReports,
  parseCodingComparison,
  parseCodingLiveReport,
  publicCodingReport,
  summarizeCodingRows,
  type CodingLiveReport,
} from "../../packages/core/src/toolcall/coding-bench-report.ts";
import {
  cleanupCodingHome,
  codingEvalHome,
  codingSecretValues,
  scanCodingPublications,
  setupCodingSecrets,
} from "../../packages/core/src/toolcall/coding-bench-secrets.ts";
import { parseTurnEvalModels, TURN_EVAL_KEY_ENV } from "../../packages/core/src/toolcall/turn-eval-live.ts";

const CORPUS = fileURLToPath(new URL("../../tests/bench/coding/", import.meta.url));
const MODES = ["--fixture", "--setup", "--smoke", "--live", "--compare", "--merge", "--render-baseline", "--scan", "--cleanup"];
const VALUES = [
  "--out",
  "--baseline",
  "--candidate",
  "--baseline-arm",
  "--candidate-arm",
  "--report",
  "--reports",
  "--log",
];
let phase = "arguments";

function argumentsOf(args: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const name = args[index]!;
    if (result.has(name) || ![...MODES, ...VALUES].includes(name)) throw new Error("coding arguments refused");
    const value = MODES.includes(name) ? "" : args[++index];
    if (value === undefined || value.startsWith("--")) throw new Error("coding arguments refused");
    result.set(name, value);
  }
  if (MODES.filter((mode) => result.has(mode)).length !== 1) throw new Error("coding mode refused");
  return result;
}
function required(args: Map<string, string>, name: string): string {
  const value = args.get(name);
  if (!value) throw new Error("coding option required");
  return value;
}
function allowed(args: Map<string, string>, names: readonly string[]): void {
  if ([...args.keys()].some((name) => !MODES.includes(name) && !names.includes(name))) {
    throw new Error("coding option refused");
  }
}
function homeOf(): string {
  const home = process.env.PLUR1BUS_CODING_BENCH_HOME;
  if (!home || !isAbsolute(home)) throw new Error("coding home required");
  return home;
}
function modelsOf() {
  const models = parseTurnEvalModels(process.env.PLUR1BUS_TURN_EVAL_MODELS);
  const index = process.env.PLUR1BUS_CODING_BENCH_MODEL_INDEX;
  if (index === undefined) return models;
  if (!/^(?:0|[1-9][0-9]?)$/u.test(index) || !models[Number(index)]) throw new Error("coding model index refused");
  return [models[Number(index)]!];
}
async function documentAt(path: string): Promise<unknown> {
  const file = resolve(path);
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 ** 2) throw new Error("coding report limit");
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > stat.size) throw new Error("coding report changed");
    return JSON.parse(buffer.subarray(0, offset).toString("utf8"));
  } finally {
    await handle.close();
  }
}
async function publish(path: string, text: string): Promise<void> {
  const publication = await reserveCodingPublication(path);
  try {
    await publication.commit(text);
  } finally {
    await publication.close();
  }
}
function scopedBaseline(report: CodingLiveReport, configurations: readonly string[]): CodingLiveReport {
  const models = report.models.filter((model) => configurations.includes(model.configuration));
  if (models.length !== configurations.length) throw new Error("coding baseline configuration unavailable");
  return parseCodingLiveReport({
    ...report,
    models,
    cases: report.cases.filter((row) => configurations.includes(row.configuration)),
    comparison: null,
  });
}

async function live(args: Map<string, string>, signal: AbortSignal): Promise<void> {
  allowed(args, ["--out", "--baseline"]);
  const output = required(args, "--out");
  phase = "configuration";
  if (Object.values(TURN_EVAL_KEY_ENV).some((name) => process.env[name])) {
    throw new Error("coding live refuses credential environment");
  }
  const models = modelsOf();
  phase = "live-home";
  const home = await codingEvalHome(homeOf());
  const secrets = await codingSecretValues(home, models);
  const baseline = args.has("--baseline")
    ? scopedBaseline(
        parseCodingLiveReport(await documentAt(required(args, "--baseline"))),
        models.map(codingConfiguration),
      )
    : undefined;
  if (baseline && baseline.corpus !== (await loadCodingCorpus(CORPUS)).fingerprint) {
    throw new Error("coding baseline corpus unavailable");
  }
  const revision = process.env.PLUR1BUS_CODING_BENCH_REVISION ?? process.env.GITHUB_SHA ?? "";
  const toolsBinary = process.env.PLUR1BUS_TOOLS_BIN ?? "";
  const limitsHelper = process.env.PLUR1BUS_SANDBOX_LIMITS_BIN ?? "";
  if (!isAbsolute(toolsBinary) || !isAbsolute(limitsHelper)) throw new Error("coding native binaries required");
  const publication = await reserveCodingPublication(output);
  try {
    phase = "live-preflight-and-run";
    const report = await runCodingBench(CORPUS, {
      home,
      models,
      revision,
      toolsBinary,
      limitsHelper,
      signal,
      onPhase(value) { phase = `live-${value}`; },
      onCase(progress) {
        console.log(JSON.stringify(progress));
      },
    });
    if (baseline) report.comparison = compareCodingReports(baseline, report);
    phase = "publication";
    const text = publicCodingReport(report, secrets);
    await publication.commit(text);
    const summary = summarizeCodingRows(report);
    console.log(
      JSON.stringify({
        status: "completed",
        evidence: "live",
        checked: summary.denominator,
        resolved: summary.resolved,
        measured: summary.measured,
        comparison: report.comparison?.gate ?? null,
      }),
    );
    if (summary.measured !== summary.denominator || (report.comparison && report.comparison.gate !== "not-regressed")) {
      process.exitCode = 1;
    }
  } finally {
    await publication.close();
  }
}

async function smoke(args: Map<string, string>, signal: AbortSignal): Promise<void> {
  allowed(args, ["--out"]);
  const output = required(args, "--out");
  phase = "configuration";
  if (Object.values(TURN_EVAL_KEY_ENV).some((name) => process.env[name])) {
    throw new Error("coding smoke refuses credential environment");
  }
  const models = modelsOf();
  if (models.length !== 1) throw new Error("one model per smoke");
  const model = models[0]!;
  const revision = process.env.PLUR1BUS_CODING_BENCH_REVISION ?? process.env.GITHUB_SHA ?? "";
  const toolsBinary = process.env.PLUR1BUS_TOOLS_BIN ?? "";
  const limitsHelper = process.env.PLUR1BUS_SANDBOX_LIMITS_BIN ?? "";
  if (process.platform !== "linux" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(revision)
    || !isAbsolute(toolsBinary) || !isAbsolute(limitsHelper)) throw new Error("coding smoke environment unavailable");
  phase = "smoke-home";
  const home = await codingEvalHome(homeOf());
  phase = "smoke-secret-store";
  const secrets = await codingSecretValues(home, models);
  phase = "smoke-publication-reservation";
  const publication = await reserveCodingPublication(output);
  try {
    phase = "smoke-preflight-and-run";
    const result = await runCodingSmoke(CORPUS, {
      home, models, revision, toolsBinary, limitsHelper,
      signal: AbortSignal.any([signal, AbortSignal.timeout(20 * 60_000)]),
      onPhase(value) { phase = `smoke-${value}`; },
    });
    phase = "publication";
    const record = {
      ...result, revision, configuration: codingConfiguration(model), provider: model.provider,
      model: model.model, capturedAt: new Date().toISOString(),
    };
    const sanitized = createRedactor({ secrets }).value(record);
    if (!isDeepStrictEqual(sanitized, record)) throw new Error("smoke metadata refused");
    const text = JSON.stringify(sanitized, null, 2) + "\n";
    if (secretFormsIn(secrets).some((value) => text.includes(value))) throw new Error("smoke publication refused");
    await publication.commit(text);
    console.log(JSON.stringify({ status: result.ready ? "smoke-ready" : "smoke-needs-review", checked: 1 }));
    if (!result.ready) process.exitCode = 1;
  } finally {
    await publication.close();
  }
}

function baselineMarkdown(report: CodingLiveReport): string {
  const summary = summarizeCodingRows(report);
  if (summary.measured !== summary.denominator) throw new Error("incomplete coding measurement");
  const lines = [
    "# B1 coding benchmark baseline",
    "",
    `Captured: ${report.generatedAt}.`,
    "",
    `Corpus: ${report.corpus}. Revision: ${report.revision}.`,
    "",
    `Environment: ${JSON.stringify(report.environment)}. Seeds: ${report.seeds.join(", ")}.`,
    "",
    "Every row below derives from the accompanying live JSON report. Fixture selftests are separate evidence.",
    "",
  ];
  for (const model of report.models)
    for (const { id: arm } of report.arms) {
      const rows = report.cases.filter((row) => row.configuration === model.configuration && row.arm === arm);
      const metrics = summarizeCodingRows(report, rows);
      const label = `${model.provider}/${model.model}`.replace(/[|`<>]/gu, " ");
      lines.push(
        `## ${label} (${arm})`,
        "",
        `Configuration: ${model.configuration}. Captured: ${model.capturedAt}.`,
        "",
        "| Group | Resolved | Denominator |",
        "| --- | ---: | ---: |",
        `| overall | ${metrics.resolved} | ${metrics.denominator} |`,
        ...metrics.groups.map((group) => `| ${group.id} | ${group.resolved} | ${group.denominator} |`),
        "",
        `Usage and counters: ${JSON.stringify(metrics.metrics)}.`,
        "",
        `Weighted provider cache-read share: ${metrics.cacheShare ?? "unavailable"}.`,
        "",
        `Solve wall time in ms: ${JSON.stringify(metrics.wallMs)}.`,
        "",
      );
    }
  lines.push(
    "Null counters are unavailable, not measured zero. Checker time is stored separately per case.",
    "",
    "Later comparisons must pair this corpus, configuration, task and seed; show all concordant/discordant/unmatched counts.",
    "A lower resolved rate per model blocks the delta gate regardless of the sign-test probability.",
    "",
  );
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = argumentsOf(process.argv.slice(2));
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    if (args.has("--smoke")) return await smoke(args, abort.signal);
    if (args.has("--live")) return await live(args, abort.signal);
    if (args.has("--fixture")) {
      allowed(args, ["--out"]);
      phase = "fixture";
      const report = await runCodingFixture(CORPUS, {
        signal: abort.signal,
        onCase(row) {
          console.log(JSON.stringify(row));
        },
      });
      if (args.has("--out")) await publish(required(args, "--out"), JSON.stringify(report, null, 2) + "\n");
      console.log(JSON.stringify({ evidence: report.evidence, checked: report.checked, passed: report.passed }));
      if (!report.passed) process.exitCode = 1;
      return;
    }
    if (args.has("--compare")) {
      allowed(args, ["--out", "--baseline", "--candidate", "--baseline-arm", "--candidate-arm"]);
      phase = "comparison";
      const comparison = compareCodingReports(
        await documentAt(required(args, "--baseline")),
        await documentAt(required(args, "--candidate")),
        args.get("--baseline-arm"),
        args.get("--candidate-arm"),
      );
      const safe = parseCodingComparison(createRedactor().value(comparison));
      await publish(required(args, "--out"), JSON.stringify(safe, null, 2) + "\n");
      console.log(JSON.stringify({ gate: safe.gate, models: safe.models.length }));
      if (safe.gate !== "not-regressed") process.exitCode = 1;
      return;
    }
    if (args.has("--render-baseline")) {
      allowed(args, ["--report", "--out"]);
      phase = "baseline-render";
      const report = parseCodingLiveReport(
        JSON.parse(publicCodingReport(await documentAt(required(args, "--report")), [])),
      );
      await publish(required(args, "--out"), baselineMarkdown(report));
      console.log(JSON.stringify({ status: "rendered", cases: report.cases.length }));
      return;
    }
    if (args.has("--merge")) {
      allowed(args, ["--reports", "--out"]);
      phase = "merge";
      const paths: unknown = JSON.parse(required(args, "--reports"));
      if (
        !Array.isArray(paths) ||
        !paths.length ||
        paths.length > 32 ||
        paths.some((path) => typeof path !== "string" || !path)
      )
        throw new Error("coding report list refused");
      const reports = [];
      for (const path of paths) reports.push(await documentAt(path as string));
      await publish(required(args, "--out"), publicCodingReport(mergeCodingReports(reports), []));
      console.log(JSON.stringify({ status: "merged", reports: reports.length }));
      return;
    }
    allowed(args, args.has("--scan") ? ["--report", "--log"] : []);
    const home = homeOf();
    phase = "eval-home";
    if (args.has("--cleanup")) await cleanupCodingHome(home);
    else if (args.has("--setup")) await setupCodingSecrets(home, modelsOf(), process.env);
    else {
      const files = [required(args, "--log")];
      if (args.has("--report")) files.unshift(required(args, "--report"));
      await scanCodingPublications(home, modelsOf(), files);
    }
    console.log(JSON.stringify({ status: "completed" }));
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

await main().catch(() => {
  // Foreign SDK/compiler exceptions may contain credentials or source. Emit only a coordinator-owned phase.
  console.error(JSON.stringify({ status: "failed", phase }));
  process.exitCode = 1;
});
