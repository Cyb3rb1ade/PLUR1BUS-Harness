/** Shared authored-fixture proof. Live model candidates never use this explicit K2 fixture mode. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { loadTeamTasks } from "../../../src/collab/team-eval.ts";
import type { TeamLanguage, TeamTask } from "../../../src/collab/team-eval.ts";

/** Explicit private corpus root, independent of the shell's current directory. */
export const TEAM_ROOT = new URL("../../../../../tests/bench/coding/team/", import.meta.url);
/** Validated authored corpus; dynamic private helpers are exercised through their real boundaries. */
export const TEAM_TASKS = await loadTeamTasks(TEAM_ROOT);
/** Public-input materializer and source traversal. */
export const materializer = await import(new URL("_shared/materialize.mjs", TEAM_ROOT).href);
/** Host-only oracle checker and case validator. */
export const checker = await import(new URL("_shared/check.mjs", TEAM_ROOT).href);
/** Private case diagnostics, never an alternative benchmark report schema. */
export interface TeamCheck {
  scope: string;
  passed: boolean;
  cases: number;
  failures: string[];
  reason?: string;
}
/** K2 checker-result contract. */
export interface TeamVerdict {
  passed: boolean;
  unavailable: boolean;
  reason: "passed" | "unresolved" | "unavailable" | "aborted";
  wallMs: number;
}
/** Collect host diagnostics while preserving K2's exact public result shape. */
export async function verifyFixture(
  task: TeamTask,
  candidate: string,
  seed: number,
  options: Record<string, unknown> = {},
) {
  const checks: TeamCheck[] = [];
  const infrastructure: string[] = [];
  const result = (await checker.verify(fileURLToPath(new URL(`${task.id}/`, TEAM_ROOT)), candidate, seed, "all", {
    mode: "fixture",
    ...options,
    onCheck: (check: TeamCheck) => checks.push(check),
    onInfrastructureFailure: (reason: string) => infrastructure.push(reason),
  })) as TeamVerdict;
  return { result, checks, infrastructure };
}

function assertPlatform(result: Awaited<ReturnType<typeof verifyFixture>>): boolean {
  if (process.platform === "linux" || process.platform === "darwin") {
    assert.equal(result.result.unavailable, false, JSON.stringify(result));
    return true;
  }
  assert.deepEqual(result.infrastructure, ["platform-unavailable"]);
  assert.equal(result.result.reason, "unavailable");
  assert.equal(result.result.passed, false);
  assert.deepEqual(result.checks, []);
  return false;
}

async function assertOwnership(task: TeamTask, taskRoot: string) {
  const previous = new Map<string, string>();
  for (const file of await materializer.sourceFiles(join(taskRoot, task.start))) {
    previous.set(file, await readFile(join(taskRoot, task.start, file), "utf8"));
  }
  const paths: Set<string>[] = [];
  for (const item of task.packages) {
    const changed = new Set<string>();
    for (const file of await materializer.sourceFiles(join(taskRoot, item.reference))) {
      const text = await readFile(join(taskRoot, item.reference, file), "utf8");
      if (text !== previous.get(file)) changed.add(file);
      previous.set(file, text);
    }
    assert.ok(changed.size > 0);
    assert.ok(
      [...changed].every((file) => item.owns.includes(file)),
      "every reference change has an exact owner",
    );
    paths.push(changed);
  }
  for (let left = 0; left < paths.length; left++) {
    for (let right = left + 1; right < paths.length; right++) {
      assert.equal(
        [...paths[left]!].some((file) => paths[right]!.has(file)),
        task.kind === "coupled",
      );
    }
  }
}

async function partialProof(task: TeamTask, taskRoot: string, directory: string, options: Record<string, unknown>) {
  const stages = task.kind === "coupled" ? task.packages.length - 1 : task.packages.length;
  for (let index = 0; index < stages; index++) {
    const candidate = join(directory, `partial-${index}`);
    await materializer.materialize(taskRoot, candidate, task.seeds[0], task.kind === "coupled" ? index + 1 : 0);
    if (task.kind === "decomposable") {
      await materializer.applyTree(join(taskRoot, task.packages[index]!.reference), candidate, task.seeds[0]);
    }
    const report = await verifyFixture(task, candidate, task.seeds[0]!, options);
    if (assertPlatform(report)) {
      assert.deepEqual(
        report.checks.slice(0, task.packages.length).map((check) => check.passed),
        task.packages.map((_, slot) => (task.kind === "coupled" ? slot <= index : slot === index)),
        JSON.stringify(report),
      );
      assert.equal(report.checks.at(-1)!.passed, false);
    }
  }
}

/** Register one language's work in a separate shardable file; Windows proves the explicit fail-closed boundary. */
export function languageFixtureTests(language: TeamLanguage, taskIds?: readonly string[]): void {
  if (taskIds?.some((id) => !TEAM_TASKS.some((task) => task.language === language && task.id === id))) {
    throw new Error("unknown fixture test selection");
  }
  const cache = mkdtemp(join(tmpdir(), `p1b-team-${language}-cache-`));
  after(async () => rm(await cache, { recursive: true, force: true }));
  for (const task of TEAM_TASKS.filter(
    (task) => task.language === language && (!taskIds || taskIds.includes(task.id)),
  )) {
    test(
      `${task.id}: all seeds, authored start/reference, partial grades, ownership or K2 platform refusal`,
      async () => {
      const directory = await mkdtemp(join(tmpdir(), "p1b-team-fixture-"));
      const taskRoot = fileURLToPath(new URL(`${task.id}/`, TEAM_ROOT));
      const options = { runtimes: { go: { env: { GOCACHE: await cache } } } };
      const names = new Set<string>();
      try {
        for (const seed of task.seeds) {
          const start = join(directory, `${seed}-start`);
          const reference = join(directory, `${seed}-reference`);
          await materializer.materialize(taskRoot, start, seed);
          await materializer.materialize(taskRoot, reference, seed, task.packages.length);
          const files = (await materializer.sourceFiles(start)) as string[];
          assert.ok(files.includes("TASK.md") && files.includes("instance.json"));
          assert.ok(files.every((file) => !/reference|check\.mjs|seed\.mjs/.test(file)));
          assert.match(await readFile(join(start, "TASK.md"), "utf8"), /## How your code is run/);
          const entry = files.find((file) => file.startsWith("src/"))!;
          assert.ok(entry && !entry.includes("__SEED__") && !names.has(entry));
          names.add(entry);
          const before = await verifyFixture(task, start, seed, options);
          const after = await verifyFixture(task, reference, seed, options);
          if (assertPlatform(before) && assertPlatform(after)) {
            assert.equal(before.checks.length, task.packages.length + 1);
            assert.ok(
              before.checks.every((check) => !check.passed),
              JSON.stringify(before),
            );
            assert.ok(
              after.checks.every((check) => check.passed && check.cases >= 3),
              JSON.stringify(after),
            );
          }
          assert.deepEqual(await materializer.sourceFiles(start), files);
        }
        await partialProof(task, taskRoot, directory, options);
        await assertOwnership(task, taskRoot);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
}
