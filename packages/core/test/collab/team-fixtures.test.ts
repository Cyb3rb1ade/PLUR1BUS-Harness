/** Corpus determinism, neutral prompts and materializer validation, independent of installed language compilers. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile, cp, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { TEAM_ROOT, TEAM_TASKS, materializer, checker } from "./fixtures/team-support.ts";

async function digest(directory: string): Promise<string> {
  const hash = createHash("sha256");
  for (const file of await materializer.sourceFiles(directory)) {
    hash
      .update(file)
      .update("\0")
      .update(await readFile(join(directory, file)))
      .update("\0");
  }
  return hash.digest("hex");
}

test("every one of the 108 task/seed/start-or-reference variants has identical paths and bytes on a second run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p1b-team-determinism-"));
  let variants = 0;
  try {
    for (const task of TEAM_TASKS) {
      const taskRoot = fileURLToPath(new URL(`${task.id}/`, TEAM_ROOT));
      for (const seed of task.seeds) {
        for (const stages of [0, task.packages.length]) {
          const left = join(directory, "left");
          const right = join(directory, "right");
          await materializer.materialize(taskRoot, left, seed, stages);
          await materializer.materialize(taskRoot, right, seed, stages);
          assert.equal(await digest(left), await digest(right), `${task.id}/${seed}/${stages}`);
          await rm(left, { recursive: true });
          await rm(right, { recursive: true });
          variants++;
        }
      }
    }
    assert.equal(variants, 108);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("manifests alone contain task classes; names, public frame logic and task allocations vary", async () => {
  const sizes = new Set(TEAM_TASKS.map((task) => task.packages.length));
  assert.deepEqual([...sizes].sort(), [3, 4, 5]);
  assert.ok(new Set(TEAM_TASKS.map((task) => JSON.stringify(task.budgets))).size > 5);
  const { seedValues } = await import(new URL("_shared/seed.mjs", TEAM_ROOT).href);
  assert.equal(new Set(TEAM_TASKS[0]!.seeds.map((seed) => seedValues(seed).profile)).size, 3);
  for (const task of TEAM_TASKS) {
    const prompt = await readFile(new URL(`${task.id}/${task.instruction}`, TEAM_ROOT), "utf8");
    assert.doesNotMatch(prompt, /decomposable|coupled|independently|sequential change|File:|Function:/i);
    assert.ok(task.packages.every((item) => item.symbol.includes("__SEED__")));
    if (task.kind === "coupled") {
      assert.deepEqual(
        task.packages.at(-1)!.dependsOn,
        task.packages.slice(0, -1).map((item) => item.id),
      );
    }
  }
});

test("both tools reject invalid task paths or symbols before using the generator or creating a destination", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p1b-team-invalid-"));
  try {
    const task = TEAM_TASKS[0]!;
    const taskRoot = join(directory, "task");
    await cp(fileURLToPath(new URL(`${task.id}/`, TEAM_ROOT)), taskRoot, { recursive: true });
    for (const mutate of [
      (value: typeof task) => {
        value.start = "../private";
      },
      (value: typeof task) => {
        value.packages[0]!.symbol = "solve();bad()";
      },
    ]) {
      const invalid = structuredClone(task);
      mutate(invalid);
      await writeFile(join(taskRoot, "task.json"), JSON.stringify(invalid));
      await assert.rejects(materializer.materialize(taskRoot, join(directory, "candidate"), task.seeds[0]));
      await assert.rejects(checker.verify(taskRoot, join(directory, "missing"), task.seeds[0]));
      await assert.rejects(access(join(directory, "candidate")));
    }
    await writeFile(join(taskRoot, "task.json"), JSON.stringify(task));
    await cp(fileURLToPath(new URL("_shared", TEAM_ROOT)), join(directory, "_shared"), { recursive: true });
    const destination = join(directory, "candidate");
    await assert.rejects(materializer.materialize(taskRoot, destination, NaN), /uint32/);
    // Directory junctions exercise the same link refusal without requiring Windows symlink privileges.
    await symlink(directory, join(taskRoot, "start", "escape"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(materializer.materialize(taskRoot, destination, task.seeds[0]), /without links/);
    await assert.rejects(access(destination));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("host case validation refuses empty or malformed cases, including duplicate IDs", () => {
  for (const cases of [
    {},
    { a: [] },
    { a: [{ id: "x", input: "", expected: 3 }] },
    {
      a: [
        { id: "x", input: "", expected: "" },
        { id: "x", input: "", expected: "" },
      ],
    },
  ]) {
    assert.throws(() => checker.validateCases(cases, ["a"]));
  }
  checker.validateCases({ a: [{ id: "nul", input: "\0", expected: "" }] }, ["a"]);
});
