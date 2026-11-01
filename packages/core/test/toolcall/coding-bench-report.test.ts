/** Structural report fixtures exercise validation only; none are live evidence or a committed benchmark baseline. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadCodingCorpus } from "../../src/toolcall/coding-bench-corpus.ts";
import {
  compareCodingReports,
  mergeCodingReports,
  parseCodingLiveReport,
  publicCodingReport,
  type CodingLiveReport,
} from "../../src/toolcall/coding-bench-report.ts";
import { defineCodingArm } from "../../src/toolcall/coding-bench-arms.ts";
import { secretFormsIn } from "../../src/logs/redact.ts";

async function structuralReport(): Promise<CodingLiveReport> {
  const corpus = await loadCodingCorpus(fileURLToPath(new URL("../../../../tests/bench/coding/", import.meta.url)));
  const configuration = "a".repeat(64);
  const date = new Date().toISOString();
  return {
    schema: "plur1bus.coding-bench/1",
    evidence: "live",
    generatedAt: date,
    corpus: corpus.fingerprint,
    revision: "b".repeat(40),
    comparison: null,
    environment: { platform: "linux", node: "24.21.0", rust: "1.95.0", go: "1.27.1", python: "3.14.7", rpc: "1.15.0" },
    tasks: corpus.tasks.map(({ meta: { id, tier, language, kind } }) => ({ id, tier, language, kind })),
    seeds: corpus.seeds,
    models: [{ provider: "fixture", model: "structural-test", configuration, capturedAt: date }],
    arms: [{ id: "single", family: "single", params: {} }],
    cases: corpus.tasks.flatMap((task) =>
      corpus.seeds.map((seed) => ({
        arm: "single",
        configuration,
        taskId: task.meta.id,
        seed,
        resolved: false,
        subject: "completed" as const,
        checker: "unresolved" as const,
        wallMs: 1,
        verificationMs: 1,
        metrics: {
          rounds: 1,
          toolCalls: 0,
          toolErrors: 0,
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheCreated: 0,
          totalInput: 10,
          cacheShare: 0,
          syntaxRefusals: null,
          offloads: null,
          steers: null,
          rewinds: null,
        },
      })),
    ),
  };
}

test("reports refuse fixture evidence, unknown fields, missing pairs and duplicate pairs", async () => {
  const report = await structuralReport();
  assert.equal(parseCodingLiveReport(report).cases.length, 72);
  assert.throws(() => parseCodingLiveReport({ ...report, evidence: "fixture-selftest" }));
  assert.throws(() => parseCodingLiveReport({ ...report, transcript: "private" }));
  assert.throws(() => parseCodingLiveReport({ ...report, cases: report.cases.slice(1) }));
  assert.throws(() => parseCodingLiveReport({ ...report, cases: [...report.cases.slice(1), report.cases[1]] }));
});

test("unknown usage stays unknown and inconsistent buckets or a false success refuse", async () => {
  const report = await structuralReport();
  report.cases[0]!.metrics.totalInput = 5;
  assert.throws(() => parseCodingLiveReport(report));
  report.cases[0]!.metrics.totalInput = 10;
  report.cases[0]!.resolved = true;
  assert.throws(() => parseCodingLiveReport(report));
});

test("a single paired loss blocks the resolved-rate gate even when its sign probability is one", async () => {
  const baseline = await structuralReport();
  baseline.cases[0]!.resolved = true;
  baseline.cases[0]!.checker = "passed";
  const candidate = await structuralReport();
  const result = compareCodingReports(baseline, candidate);
  assert.equal(result.models[0]!.pairs.regressed, 1);
  assert.equal(result.models[0]!.pairs.signP, 1);
  assert.equal(result.gate, "regressed");
  candidate.models[0]!.configuration = "c".repeat(64);
  candidate.cases.forEach((row) => {
    row.configuration = "c".repeat(64);
  });
  assert.equal(compareCodingReports(baseline, candidate).gate, "incomparable");
});

test("the public boundary removes runtime canary forms and emits no endpoints or extra fields", async () => {
  const report = await structuralReport();
  const canary = randomBytes(24).toString("base64url");
  report.models[0]!.model = Buffer.from(canary).toString("base64");
  const output = publicCodingReport(report, [canary]);
  assert.equal(
    secretFormsIn([canary]).some((form) => output.includes(form)),
    false,
  );
  assert.equal(parseCodingLiveReport(JSON.parse(output)).cases.length, 72);
  assert.throws(() => publicCodingReport({ ...report, endpoint: "http://127.0.0.1:1" }, [canary]));
});

test("merging model captures preserves their dates and refuses duplicates or mixed environments", async () => {
  const first = await structuralReport();
  const second = await structuralReport();
  second.models[0]!.configuration = "c".repeat(64);
  second.cases.forEach((row) => {
    row.configuration = "c".repeat(64);
  });
  const merged = mergeCodingReports([first, second]);
  assert.equal(merged.cases.length, 144);
  assert.deepEqual(
    merged.models.map((model) => model.capturedAt),
    [first.models[0]!.capturedAt, second.models[0]!.capturedAt],
  );
  assert.throws(() => mergeCodingReports([first, first]));
  second.environment.go = "1.22.0";
  assert.throws(() => mergeCodingReports([first, second]));
  second.models[0]!.configuration = first.models[0]!.configuration;
  second.cases.forEach((row) => {
    row.configuration = first.models[0]!.configuration;
  });
  assert.equal(compareCodingReports(first, second).gate, "incomparable");
});

test("an embedded comparison cannot contradict the candidate's actual outcomes", async () => {
  const report = await structuralReport();
  report.comparison = compareCodingReports(report, report);
  assert.equal(parseCodingLiveReport(report).comparison!.gate, "not-regressed");
  const pairs = report.comparison.models[0]!.pairs;
  pairs.bothResolved = 2;
  pairs.bothUnresolved -= 2;
  assert.throws(() => parseCodingLiveReport(report));
});

test("reports bind every arm ID to its complete family and parameters", async () => {
  const report = await structuralReport();
  const arm = defineCodingArm({ family: "single", params: { effort: "highest" } });
  report.arms = [arm];
  report.cases.forEach((row) => {
    row.arm = arm.id;
  });
  assert.equal(parseCodingLiveReport(report).cases.length, 72);
  assert.throws(() => parseCodingLiveReport({ ...report, arms: [arm.id] }));
  assert.throws(() => parseCodingLiveReport({ ...report, arms: [{ ...arm, id: "single" }] }));
  assert.throws(() => parseCodingLiveReport({ ...report, arms: [{ ...arm, params: {} }] }));
  const baseline = await structuralReport();
  const comparison = compareCodingReports(baseline, report, "single", arm.id);
  assert.equal(comparison.gate, "not-regressed");
  report.comparison = comparison;
  assert.equal(parseCodingLiveReport(report).comparison!.candidateArm, arm.id);
});

test("the shared environment boundary is closed and normalizes field order", async () => {
  const report = await structuralReport();
  const order = ["platform", "node", "rust", "go", "python", "rpc"];
  const environment = Object.fromEntries(Object.entries(report.environment).reverse());
  const parsed = parseCodingLiveReport({ ...report, environment });
  assert.deepEqual(Object.keys(parsed.environment), order);
  for (const bad of [
    { ...environment, endpoint: "private" },
    { ...environment, platform: "darwin" },
    { ...environment, node: "v24.21.0" },
    { ...environment, rpc: "1.15" },
  ]) {
    assert.throws(() => parseCodingLiveReport({ ...report, environment: bad }));
  }
});

test("model captures with equivalent parameter key orders merge without changing arm identities", async () => {
  const first = await structuralReport();
  const second = await structuralReport();
  const arm = defineCodingArm({ family: "single", params: { review: true, effort: "highest" } });
  first.arms = [arm];
  second.arms = [{ ...arm, params: { effort: "highest", review: true } }];
  first.cases.forEach((row) => {
    row.arm = arm.id;
  });
  second.models[0]!.configuration = "c".repeat(64);
  second.cases.forEach((row) => {
    row.arm = arm.id;
    row.configuration = "c".repeat(64);
  });
  assert.equal(mergeCodingReports([first, second]).cases.length, 144);
});
