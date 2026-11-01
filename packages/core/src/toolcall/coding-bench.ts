/** B1 original coding benchmark. Fixture evidence validates checkers and can never substitute for a live baseline. */
import { loadCodingCorpus, renderCodingTask } from "./coding-bench-corpus.ts";
import { verifyCodingTask } from "./coding-bench-checker.ts";
import { resolveCodingRuntimes } from "./coding-bench-runtime.ts";
import { stageCodingFixture, snapshotCodingSources } from "./coding-bench-workspace.ts";
import { runCodingLive, type CodingLiveOptions } from "./coding-bench-live.ts";
import type { CodingLiveReport } from "./coding-bench-report.ts";

/** Owner-only live entry point; fixture mode never calls or substitutes for this path. */
export async function runCodingBench(root: string, options: CodingLiveOptions): Promise<CodingLiveReport> {
  return runCodingLive(root, options);
}

/** One checker-validity pair, with no source text, diagnostics, credentials or model transcript. */
export interface CodingFixtureCase {
  taskId: string;
  seed: number;
  startRejected: boolean;
  referencePassed: boolean;
  unavailable: boolean;
}
/** Only the actual owner live run may produce the separate live report/baseline format. */
export interface CodingFixtureReport {
  schema: "plur1bus.coding-fixture/1";
  evidence: "fixture-selftest";
  corpus: string;
  generatedAt: string;
  passed: boolean;
  checked: number;
  cases: CodingFixtureCase[];
}
/** Fixture-only progress and local diagnostic seams; never used for a live model subject. */
export interface CodingFixtureOptions {
  signal: AbortSignal;
  onCase?: (row: CodingFixtureCase) => void;
  onFixtureFailure?: (where: { taskId: string; seed: number; stage: string }, error: unknown) => void;
}

/** All 24 × 3 original pairs in fresh trusted copies. No model, Git worktree or live sandbox grant is involved. */
export async function runCodingFixture(root: string, options: CodingFixtureOptions): Promise<CodingFixtureReport> {
  const corpus = await loadCodingCorpus(root);
  const runtimes = await resolveCodingRuntimes(false, options.signal);
  const cases: CodingFixtureCase[] = [];
  try {
    for (const task of corpus.tasks)
      for (const seed of corpus.seeds) {
        const results = [];
        for (const stage of ["start", "reference"] as const) {
          if (options.signal.aborted) throw new Error("coding fixture aborted");
          const instance = await renderCodingTask(task, seed, stage);
          const workspace = await stageCodingFixture(instance.files, options.signal);
          try {
            const image = await snapshotCodingSources(workspace.tree);
            results.push(
              await verifyCodingTask(task, instance.variant, image, {
                mode: "fixture",
                runtimes,
                signal: options.signal,
                ...(options.onFixtureFailure
                  ? {
                      onFixtureFailure: (error: unknown) =>
                        options.onFixtureFailure!({ taskId: task.meta.id, seed, stage }, error),
                    }
                  : {}),
              }),
            );
          } finally {
            await workspace.close();
          }
        }
        const row: CodingFixtureCase = {
          taskId: task.meta.id,
          seed,
          startRejected: results[0]!.reason === "unresolved",
          referencePassed: results[1]!.passed,
          unavailable: results.some((result) => result.unavailable),
        };
        cases.push(row);
        options.onCase?.(row);
      }
  } finally {
    await runtimes.close();
  }
  return {
    schema: "plur1bus.coding-fixture/1",
    evidence: "fixture-selftest",
    corpus: corpus.fingerprint,
    generatedAt: new Date().toISOString(),
    checked: cases.length,
    cases,
    passed: cases.length === 72 && cases.every((row) => row.startRejected && row.referencePassed && !row.unavailable),
  };
}
