/** B1's closed, transcript-free live report boundary and paired regression evidence. */
import type { CodingLanguage, CodingTier } from "./coding-bench-corpus.ts";
import type { CodingMetrics, CodingSubjectResult } from "./coding-bench-subject.ts";
import { createRedactor, secretFormsIn } from "../logs/redact.ts";
import { comparePairedOutcomes, exactPairedSignP, type PairComparison } from "./coding-bench-stats.ts";

/** Only complete paired evidence may pass; statistical significance never overrides the resolved-rate gate. */
export type CodingComparisonGate = "incomparable" | "regressed" | "not-regressed";
/** Paired counts accompany every nightly candidate; the owner's first capture has no previous baseline. */
export interface CodingComparison {
  schema: "plur1bus.coding-comparison/1";
  gatedRate: "resolved";
  baselineArm: string;
  candidateArm: string;
  baselineCorpus: string;
  baselineRevision: string;
  differentDay: boolean;
  sameRuntime: boolean;
  gate: CodingComparisonGate;
  models: (CodingReportModel & { pairs: PairComparison; measured: boolean; gate: CodingComparisonGate })[];
}

/** Only public task classification, never hidden checker paths or expected answers. */
export interface CodingReportTask {
  id: string;
  tier: CodingTier;
  language: CodingLanguage;
  kind: "repository" | "terminal";
}
/** An endpoint-free identity; configuration hashes the complete approved, credential-free provider definition. */
export interface CodingReportModel {
  provider: string;
  model: string;
  configuration: string;
  capturedAt: string;
}
/** Each task/seed/model/arm contributes exactly one observation. */
export interface CodingLiveCase {
  arm: string;
  configuration: string;
  taskId: string;
  seed: number;
  resolved: boolean;
  subject: CodingSubjectResult["outcome"];
  checker: "passed" | "unresolved" | "unavailable" | "aborted" | "invalid-image";
  wallMs: number;
  verificationMs: number;
  metrics: CodingMetrics;
}
/** A real run's complete matrix. Fixture-selftest documents deliberately have a different schema. */
export interface CodingLiveReport {
  schema: "plur1bus.coding-bench/1";
  evidence: "live";
  generatedAt: string;
  corpus: string;
  revision: string;
  environment: { platform: "linux"; node: string; rust: string; go: string; python: string; rpc: string };
  tasks: CodingReportTask[];
  seeds: number[];
  models: CodingReportModel[];
  arms: string[];
  cases: CodingLiveCase[];
  comparison: CodingComparison | null;
}
/** Refuse unknown fields, incomplete/duplicate matrices, invalid counts or impossible resolved outcomes. */
export function parseCodingLiveReport(value: unknown): CodingLiveReport {
  const root = closed(value, [
    "schema",
    "evidence",
    "generatedAt",
    "corpus",
    "revision",
    "environment",
    "tasks",
    "seeds",
    "models",
    "arms",
    "cases",
    "comparison",
  ]);
  if (root.schema !== "plur1bus.coding-bench/1" || root.evidence !== "live") invalid();
  const date = Date.parse(string(root.generatedAt, 32));
  if (!Number.isFinite(date) || date > Date.now() + 60_000) invalid();
  hash(root.corpus);
  revision(root.revision);
  const environment = closed(root.environment, ["platform", "node", "rust", "go", "python", "rpc"]);
  if (environment.platform !== "linux") invalid();
  for (const name of ["node", "rust", "go", "python", "rpc"]) {
    if (!/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(string(environment[name], 32))) invalid();
  }
  validateTaskMatrix(root);
  if (root.comparison !== null)
    validateCandidateComparison(value as CodingLiveReport, parseCodingComparison(root.comparison));
  return value as CodingLiveReport;
}
/** Redact before publication, validate the sanitized shape again, and scan every registered secret encoding. */
export function publicCodingReport(value: unknown, secrets: Iterable<string>): string {
  const known = [...secrets];
  const report = parseCodingLiveReport(value);
  const sanitized = parseCodingLiveReport(createRedactor({ secrets: known }).value(report));
  const text = JSON.stringify(sanitized, null, 2) + "\n";
  if (secretFormsIn(known).some((form) => text.includes(form))) throw new Error("coding publication refused");
  return text;
}
/** Pair explicitly selected arms; incomplete evidence is incomparable and p-values never waive a rate regression. */
export function compareCodingReports(
  before: unknown,
  after: unknown,
  baselineArm = "single",
  candidateArm = "single",
): CodingComparison {
  const baseline = parseCodingLiveReport(before);
  const candidate = parseCodingLiveReport(after);
  if (!baseline.arms.includes(baselineArm) || !candidate.arms.includes(candidateArm)) invalid();
  const identity = (model: CodingReportModel) => JSON.stringify([model.provider, model.model, model.configuration]);
  const sameRuntime = (["platform", "node", "rust", "go", "python"] as const).every(
    (key) => baseline.environment[key] === candidate.environment[key],
  );
  const identities = new Map([...baseline.models, ...candidate.models].map((model) => [identity(model), model]));
  const models = [...identities.values()].map((model) => {
    const select = (report: CodingLiveReport, arm: string) =>
      report.models.some((m) => identity(m) === identity(model))
        ? report.cases.filter((row) => row.configuration === model.configuration && row.arm === arm)
        : [];
    const oldRows = select(baseline, baselineArm);
    const newRows = select(candidate, candidateArm);
    const outcomes = (rows: CodingLiveCase[], report: CodingLiveReport) =>
      rows.map((row) => ({
        key: JSON.stringify([report.corpus, identity(model), row.taskId, row.seed]),
        resolved: row.resolved,
      }));
    const pairs = comparePairedOutcomes(outcomes(oldRows, baseline), outcomes(newRows, candidate));
    const comparable =
      sameRuntime &&
      pairs.paired > 0 &&
      pairs.unmatchedBaseline === 0 &&
      pairs.unmatchedCandidate === 0 &&
      oldRows.every(measured) &&
      newRows.every(measured);
    return {
      ...model,
      pairs,
      measured: oldRows.every(measured) && newRows.every(measured),
      gate: !comparable
        ? ("incomparable" as const)
        : pairs.deltaResolved < 0
          ? ("regressed" as const)
          : ("not-regressed" as const),
    };
  });
  const gate = models.some((model) => model.gate === "incomparable")
    ? "incomparable"
    : models.some((model) => model.gate === "regressed")
      ? "regressed"
      : "not-regressed";
  return {
    schema: "plur1bus.coding-comparison/1",
    gatedRate: "resolved",
    baselineArm,
    candidateArm,
    baselineCorpus: baseline.corpus,
    baselineRevision: baseline.revision,
    sameRuntime,
    differentDay: baseline.models.some((previous) => {
      const current = candidate.models.find((model) => identity(model) === identity(previous));
      return current && current.capturedAt.slice(0, 10) !== previous.capturedAt.slice(0, 10);
    }),
    gate,
    models,
  };
}

function invalid(): never {
  throw new Error("invalid coding live report");
}
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || Object.keys(row).some((key) => !keys.includes(key))) invalid();
  return row;
}
function string(value: unknown, max: number): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > max ||
    /[\x00-\x1f\x7f]/u.test(value) ||
    !value.isWellFormed()
  )
    return invalid();
  return value;
}
function hash(value: unknown): string {
  const result = string(value, 64);
  if (!/^[a-f0-9]{64}$/u.test(result)) invalid();
  return result;
}
function revision(value: unknown): void {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(string(value, 64))) invalid();
}
function count(value: unknown, max = 1_000_000_000): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) return invalid();
  return value as number;
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || !value.length || value.length > max) return invalid();
  return value;
}
function unique(values: readonly unknown[]): void {
  if (new Set(values).size !== values.length) invalid();
}

function validateTaskMatrix(root: Record<string, unknown>): void {
  const tasks = array(root.tasks, 24).map((value) => {
    const task = closed(value, ["id", "tier", "language", "kind"]);
    if (!/^[a-z][a-z0-9-]+$/u.test(string(task.id, 64))) invalid();
    if (
      !["easy", "medium", "hard"].includes(task.tier as string) ||
      !["rust", "typescript", "python", "go", "shell"].includes(task.language as string) ||
      !["repository", "terminal"].includes(task.kind as string)
    )
      invalid();
    return task;
  });
  unique(tasks.map((task) => task.id));
  if (
    ["easy", "medium", "hard"].some((tier) => tasks.filter((task) => task.tier === tier).length !== 8) ||
    tasks.filter((task) => task.kind === "repository").length !== 12 ||
    new Set(tasks.map((task) => task.language)).size !== 5
  )
    invalid();
  const seeds = array(root.seeds, 3).map((value) => count(value, 0xffff_ffff));
  if (seeds.length !== 3) invalid();
  unique(seeds);
  const models = array(root.models, 32).map((value) => {
    const model = closed(value, ["provider", "model", "configuration", "capturedAt"]);
    if (!/^[a-zA-Z0-9_.-]{1,64}$/u.test(string(model.provider, 64))) invalid();
    string(model.model, 256);
    hash(model.configuration);
    const captured = Date.parse(string(model.capturedAt, 32));
    if (!Number.isFinite(captured) || captured > Date.parse(root.generatedAt as string)) invalid();
    return model;
  });
  unique(models.map((model) => model.configuration));
  const arms = array(root.arms, 8).map((value) => string(value, 64));
  if (arms.some((arm) => !/^[a-z][a-z0-9-]{0,63}$/u.test(arm))) invalid();
  unique(arms);
  const cases = array(root.cases, 24 * 3 * 32 * 8);
  if (cases.length !== tasks.length * seeds.length * models.length * arms.length) invalid();
  const keys = cases.map((value) => validateCase(value, tasks, seeds, models, arms));
  unique(keys);
}

function validateCase(
  value: unknown,
  tasks: Record<string, unknown>[],
  seeds: number[],
  models: Record<string, unknown>[],
  arms: string[],
): string {
  const row = closed(value, [
    "arm",
    "configuration",
    "taskId",
    "seed",
    "resolved",
    "subject",
    "checker",
    "wallMs",
    "verificationMs",
    "metrics",
  ]);
  if (
    !arms.includes(row.arm as string) ||
    !models.some((model) => model.configuration === row.configuration) ||
    !tasks.some((task) => task.id === row.taskId) ||
    !seeds.includes(row.seed as number) ||
    typeof row.resolved !== "boolean" ||
    !["completed", "budget", "aborted", "provider-error"].includes(row.subject as string) ||
    !["passed", "unresolved", "unavailable", "aborted", "invalid-image"].includes(row.checker as string)
  )
    invalid();
  count(row.wallMs, 3_600_000);
  count(row.verificationMs, 3_600_000);
  validateMetrics(row.metrics);
  if (row.resolved && (row.subject !== "completed" || row.checker !== "passed")) invalid();
  return JSON.stringify([row.arm, row.configuration, row.taskId, row.seed]);
}

function validateMetrics(value: unknown): void {
  const row = closed(value, [
    "rounds",
    "toolCalls",
    "toolErrors",
    "input",
    "output",
    "cacheRead",
    "cacheCreated",
    "totalInput",
    "cacheShare",
    "syntaxRefusals",
    "offloads",
    "steers",
    "rewinds",
  ]);
  for (const key of ["rounds", "toolCalls", "toolErrors"]) count(row[key]);
  for (const key of ["syntaxRefusals", "offloads", "steers", "rewinds"]) if (row[key] !== null) count(row[key]);
  const usage = ["input", "output", "cacheRead", "cacheCreated", "totalInput"];
  if (usage.every((key) => row[key] === null)) {
    if (row.cacheShare !== null) invalid();
    return;
  }
  usage.forEach((key) => count(row[key]));
  const total = (row.input as number) + (row.cacheRead as number) + (row.cacheCreated as number);
  if (total !== row.totalInput || row.cacheShare !== (total ? (row.cacheRead as number) / total : null)) invalid();
}

function measured(row: CodingLiveCase): boolean {
  return (
    !["provider-error", "aborted"].includes(row.subject) &&
    !["unavailable", "aborted"].includes(row.checker) &&
    row.metrics.totalInput !== null
  );
}

function validateCandidateComparison(report: CodingLiveReport, comparison: CodingComparison): void {
  if (!report.arms.includes(comparison.candidateArm)) invalid();
  const identity = (model: CodingReportModel) => JSON.stringify([model.provider, model.model, model.configuration]);
  for (const model of report.models) {
    const paired = comparison.models.find((entry) => identity(entry) === identity(model));
    if (!paired) invalid();
    const rows = report.cases.filter(
      (row) => row.arm === comparison.candidateArm && row.configuration === model.configuration,
    );
    if (paired.pairs.paired + paired.pairs.unmatchedCandidate !== rows.length) invalid();
    if (
      !paired.pairs.unmatchedCandidate &&
      paired.pairs.bothResolved + paired.pairs.improved !== rows.filter((row) => row.resolved).length
    )
      invalid();
  }
}

/** Validate a standalone paired report as strictly as its embedded live-report form. */
export function parseCodingComparison(value: unknown): CodingComparison {
  const row = closed(value, [
    "schema",
    "gatedRate",
    "baselineArm",
    "candidateArm",
    "baselineCorpus",
    "baselineRevision",
    "differentDay",
    "sameRuntime",
    "gate",
    "models",
  ]);
  if (
    row.schema !== "plur1bus.coding-comparison/1" ||
    row.gatedRate !== "resolved" ||
    typeof row.differentDay !== "boolean" ||
    typeof row.sameRuntime !== "boolean"
  )
    invalid();
  hash(row.baselineCorpus);
  revision(row.baselineRevision);
  for (const key of ["baselineArm", "candidateArm"]) {
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(string(row[key], 64))) invalid();
  }
  const models = array(row.models, 64).map((value) => {
    const model = closed(value, ["provider", "model", "configuration", "capturedAt", "pairs", "measured", "gate"]);
    string(model.provider, 64);
    string(model.model, 256);
    hash(model.configuration);
    if (!Number.isFinite(Date.parse(string(model.capturedAt, 32)))) invalid();
    if (typeof model.measured !== "boolean") invalid();
    const pairs = closed(model.pairs, [
      "bothResolved",
      "bothUnresolved",
      "improved",
      "regressed",
      "unmatchedBaseline",
      "unmatchedCandidate",
      "paired",
      "deltaResolved",
      "signP",
    ]);
    for (const key of [
      "bothResolved",
      "bothUnresolved",
      "improved",
      "regressed",
      "unmatchedBaseline",
      "unmatchedCandidate",
      "paired",
    ])
      count(pairs[key], 1_000_000);
    if (
      pairs.paired !==
        (pairs.bothResolved as number) +
          (pairs.bothUnresolved as number) +
          (pairs.improved as number) +
          (pairs.regressed as number) ||
      pairs.deltaResolved !== (pairs.improved as number) - (pairs.regressed as number) ||
      pairs.signP !== exactPairedSignP(pairs.improved as number, pairs.regressed as number)
    )
      invalid();
    const gate =
      !row.sameRuntime || !model.measured || !pairs.paired || pairs.unmatchedBaseline || pairs.unmatchedCandidate
        ? "incomparable"
        : (pairs.deltaResolved as number) < 0
          ? "regressed"
          : "not-regressed";
    if (model.gate !== gate) invalid();
    return model;
  });
  unique(models.map((model) => JSON.stringify([model.provider, model.model, model.configuration])));
  const gate = models.some((model) => model.gate === "incomparable")
    ? "incomparable"
    : models.some((model) => model.gate === "regressed")
      ? "regressed"
      : "not-regressed";
  if (row.gate !== gate) invalid();
  return value as CodingComparison;
}

/** Combine model captures without dropping dates or accepting mixed corpora, revisions, runtimes or arms. */
export function mergeCodingReports(values: readonly unknown[]): CodingLiveReport {
  if (!values.length || values.length > 32) invalid();
  const reports = values.map(parseCodingLiveReport);
  const first = reports[0]!;
  for (const report of reports) {
    if (
      report.comparison !== null ||
      report.corpus !== first.corpus ||
      report.revision !== first.revision ||
      JSON.stringify(report.environment) !== JSON.stringify(first.environment) ||
      JSON.stringify(report.tasks) !== JSON.stringify(first.tasks) ||
      JSON.stringify(report.seeds) !== JSON.stringify(first.seeds) ||
      JSON.stringify(report.arms) !== JSON.stringify(first.arms)
    )
      invalid();
  }
  return parseCodingLiveReport({
    ...first,
    generatedAt: reports
      .map((report) => report.generatedAt)
      .sort()
      .at(-1),
    models: reports.flatMap((report) => report.models),
    cases: reports.flatMap((report) => report.cases),
  });
}

/** Denominators, tiers/languages, sums and timing quantiles; unknown usage never silently becomes zero. */
export function summarizeCodingRows(report: CodingLiveReport, rows: readonly CodingLiveCase[] = report.cases) {
  const rate = (selected: readonly CodingLiveCase[]) => ({
    resolved: selected.filter((row) => row.resolved).length,
    denominator: selected.length,
  });
  const groups = [...["easy", "medium", "hard"], ...["rust", "typescript", "python", "go", "shell"]].map((id) => {
    const taskIds = new Set(
      report.tasks.filter((task) => task.tier === id || task.language === id).map((task) => task.id),
    );
    return { id, ...rate(rows.filter((row) => taskIds.has(row.taskId))) };
  });
  const sums = Object.fromEntries(
    Object.keys(rows[0]?.metrics ?? {})
      .filter((key) => key !== "cacheShare")
      .map((key) => {
        const values = rows.map((row) => row.metrics[key as keyof CodingMetrics]);
        return [
          key,
          values.every((value) => value !== null) ? values.reduce<number>((sum, value) => sum + value!, 0) : null,
        ];
      }),
  );
  const times = rows.map((row) => row.wallMs).sort((a, b) => a - b);
  return {
    ...rate(rows),
    measured: rows.filter(measured).length,
    groups,
    metrics: sums,
    cacheShare:
      typeof sums.cacheRead === "number" && typeof sums.totalInput === "number" && sums.totalInput > 0
        ? sums.cacheRead / sums.totalInput
        : null,
    wallMs: {
      sum: times.reduce((sum, value) => sum + value, 0),
      p50: times[Math.max(0, Math.ceil(times.length * 0.5) - 1)] ?? null,
      p95: times[Math.max(0, Math.ceil(times.length * 0.95) - 1)] ?? null,
    },
  };
}
