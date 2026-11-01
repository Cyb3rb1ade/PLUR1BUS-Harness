/** Team corpus contracts, extensible arm identities and complete per-task planning limits. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  loadTeamTasks,
  parseTeamTask,
  evaluationArms,
  planArm,
  planComparison,
  missingArmCapabilities,
  localCapacityTrials,
  canonicalArmId,
  createEvaluationArmRegistry,
  EvaluationArmError,
} from "../../src/collab/team-eval.ts";
import type { ComparisonBudget } from "../../src/collab/team-eval.ts";
const task = { budgets: { tokens: 8192, maxRounds: 12, wallMs: 6000 } };
const fixtureRoot = new URL("../../../../tests/bench/coding/team/", import.meta.url);

test("arm identity comes from family and JSON parameters, independent of object key order", () => {
  const first = { family: "team", params: { workers: 4, routing: { effort: "highest", review: true } } };
  const reordered = { family: "team", params: { routing: { review: true, effort: "highest" }, workers: 4 } };
  assert.equal(canonicalArmId(first), canonicalArmId(reordered));
  assert.notEqual(canonicalArmId(first), canonicalArmId({ ...first, params: { ...first.params, workers: 2 } }));
  assert.notEqual(canonicalArmId(first), canonicalArmId({ ...first, family: "best-of-n" }));
  assert.match(canonicalArmId(first), /^[a-z][a-z0-9-]{0,63}$/);
  assert.equal(canonicalArmId({ family: "single", params: {} }), "single");
});

test("the team tier has twelve decomposable and six coupled tasks across four languages", async () => {
  const tasks = await loadTeamTasks(fixtureRoot);
  assert.equal(tasks.length, 18);
  assert.equal(tasks.filter((task) => task.kind === "decomposable").length, 12);
  assert.equal(tasks.filter((task) => task.kind === "coupled").length, 6);
  assert.deepEqual([...new Set(tasks.map((task) => task.language))].sort(), ["go", "python", "rust", "typescript"]);
  assert.equal(new Set(tasks.map((task) => task.id)).size, 18);
  for (const task of tasks) {
    assert.equal(task.license, "MIT");
    assert.equal(task.tier, "team");
    assert.ok(task.budgets.tokens > 0 && task.budgets.maxRounds > 0 && task.budgets.wallMs > 0);
    assert.equal(new Set(task.seeds).size, 3);
    assert.ok(task.packages.length >= 3 && task.packages.length <= 5);
  }
});

test("initial arm definitions keep future team and best-of-n execution unavailable", () => {
  const arms = evaluationArms();
  assert.deepEqual(
    arms.map(({ family, params }) => ({ family, params })),
    [
      { family: "single", params: {} },
      { family: "single", params: { effort: "highest" } },
      { family: "single", params: { review: true } },
      { family: "explore+single", params: {} },
    ],
  );
  for (const arm of arms) assert.equal(arm.id, canonicalArmId(arm));
  assert.equal(arms.find((arm) => arm.params.effort === "highest")!.family, "single");
  assert.ok(arms.find((arm) => arm.family === "explore+single")!.requires.includes("async-consult"));
  for (const id of ["team", "best-of-n"])
    assert.throws(
      () => planArm(task, id, { regime: "matched" }),
      (error: unknown) => error instanceof EvaluationArmError && error.code === "arm-not-executable",
    );
});

test("matched budgets include all roles and never multiply the task cap by worker count", () => {
  for (const arm of evaluationArms()) {
    const plan = planArm(task, arm.id, { regime: "matched" });
    assert.equal(plan.budget.tokens, 8192);
    assert.equal(plan.budget.accounting, "all-model-calls");
    assert.equal(plan.budget.pool, "shared-task");
  }
  assert.throws(
    () => planArm({ budgets: { ...task.budgets, tokens: 0 } }, "single", { regime: "matched" }),
    /positive/,
  );
  assert.throws(
    () => planArm({ budgets: { ...task.budgets, tokens: NaN } }, "single", { regime: "matched" }),
    /positive/,
  );
});

test("local capacity measurements describe concurrency one, two and four without invented results", () => {
  assert.deepEqual(localCapacityTrials(), { requestConcurrency: [1, 2, 4], writerCapacityMultipliers: [1, 1.5, 2] });
});

test("a comparison owns one matched cap; natural caps must be supplied for every arm", () => {
  const plans = planComparison(
    task,
    [
      { family: "single", params: {} },
      { family: "explore+single", params: {} },
    ],
    { regime: "matched" },
  );
  assert.deepEqual(
    plans.map((plan) => plan.budget.tokens),
    [8192, 8192],
  );
  const review = { family: "single", params: { review: true } };
  const reviewId = canonicalArmId(review);
  const natural = planComparison(task, ["single", review], {
    regime: "natural",
    caps: {
      single: { tokens: 4096, maxRounds: 6, wallMs: 3000 },
      [reviewId]: { tokens: 6144, maxRounds: 7, wallMs: 4000 },
    },
  });
  assert.deepEqual(
    natural.map((plan) => plan.budget.tokens),
    [4096, 6144],
  );
  assert.throws(
    () =>
      planComparison(task, ["single", review], {
        regime: "natural",
        caps: { single: { tokens: 4096, maxRounds: 6, wallMs: 3000 } },
      }),
    /missing natural budget/,
  );
  assert.throws(() => planComparison(task, ["single", "single"], { regime: "matched" }), /distinct/);
  const typo = {
    regime: "natural",
    caps: {
      single: { tokens: 4096, maxRounds: 6, wallMs: 3000 },
      "single+reveiw": { tokens: 6144, maxRounds: 7, wallMs: 4000 },
    },
  } as unknown as ComparisonBudget;
  assert.throws(() => planComparison(task, ["single"], typo), /unknown natural budget arm/);
});

test("a fixture root must be an explicit file directory URL", async () => {
  await assert.rejects(loadTeamTasks(new URL(fixtureRoot.href.slice(0, -1))), /directory file URL/);
  await assert.rejects(loadTeamTasks(new URL("https://example.invalid/team/")), /directory file URL/);
});

test("matched comparisons derive all axes from the task and reject caller-owned overrides", () => {
  const forged = { regime: "matched", caps: { single: 1 } } as unknown as ComparisonBudget;
  assert.throws(() => planComparison(task, ["single"], forged), /fields/);
  assert.throws(() => planArm(task, "single", { regime: "matched", capTokens: 1 } as never), /fields/);
  const plan = planArm(task, "single", { regime: "matched" });
  assert.deepEqual(plan.budget, {
    ...task.budgets,
    regime: "matched",
    accounting: "all-model-calls",
    pool: "shared-task",
  });
  assert.throws(() => planArm({ budgets: { ...task.budgets, maxRounds: 0 } }, "single", { regime: "matched" }));
  assert.throws(() => planArm({ budgets: { ...task.budgets, wallMs: NaN } }, "single", { regime: "matched" }));
});

test("capabilities distinguish declared exploration from an executable binding", () => {
  const arm = evaluationArms().find((arm) => arm.family === "explore+single")!;
  assert.deepEqual(missingArmCapabilities(arm, new Set()), ["b1-runner", "async-consult"]);
  assert.deepEqual(missingArmCapabilities(arm, new Set(["b1-runner"])), ["async-consult"]);
  assert.deepEqual(missingArmCapabilities(arm, new Set(["b1-runner", "async-consult"])), []);
  const returned = evaluationArms();
  returned[0]!.requires = [];
  (returned[1]!.params as Record<string, unknown>).effort = "changed";
  assert.deepEqual(evaluationArms()[0]!.requires, ["b1-runner"]);
  assert.deepEqual(evaluationArms()[1]!.params, { effort: "highest" });
});

test("task manifests reject traversal, duplicate seeds, unknown fields and future dependencies", async () => {
  const original = (await loadTeamTasks(fixtureRoot))[0]!;
  for (const modify of [
    (task: typeof original) => {
      task.instruction = "../private";
    },
    (task: typeof original) => {
      task.seedGenerator = "*.mjs";
    },
    (task: typeof original) => {
      task.seeds = [1, 1, 2];
    },
    (task: typeof original) => {
      task.packages[0]!.dependsOn = [task.packages[1]!.id];
    },
    (task: typeof original) => {
      task.packages[0]!.owns = ["src/*"];
    },
    (task: typeof original) => {
      task.packages[0]!.owns = [task.packages[1]!.entry];
    },
    (task: typeof original) => {
      task.packages[1]!.entry = task.packages[0]!.entry;
      task.packages[1]!.owns = [task.packages[0]!.entry];
    },
    (task: typeof original) => {
      task.packages[0]!.entry = "src/group.__SEED__.py";
      task.packages[0]!.owns = [task.packages[0]!.entry];
    },
    (task: typeof original) => {
      (task as unknown as Record<string, unknown>).extra = true;
    },
    (task: typeof original) => {
      (task as unknown as Record<string, unknown>).language = ["go"];
    },
  ]) {
    const task = structuredClone(original);
    modify(task);
    assert.throws(() => parseTeamTask(task));
  }
  const coupled = structuredClone((await loadTeamTasks(fixtureRoot)).find((task) => task.kind === "coupled")!);
  coupled.packages[1]!.entry = "src/other.__SEED__.ts";
  coupled.packages[1]!.owns = [coupled.packages[1]!.entry];
  assert.throws(() => parseTeamTask(coupled), /share an entry/);
});

test("canonical arm IDs distinguish array order, JSON types, exact strings and slug-alias families", () => {
  const id = (params: Record<string, unknown>) => canonicalArmId({ family: "future-control", params } as never);
  assert.notEqual(id({ route: ["a", "b"] }), id({ route: ["b", "a"] }));
  assert.notEqual(id({ review: true }), id({ review: "true" }));
  assert.notEqual(id({ separator: "\r\n" }), id({ separator: "\n" }));
  assert.notEqual(
    canonicalArmId({ family: "explore+single", params: {} }),
    canonicalArmId({ family: "explore-single", params: {} }),
  );
  assert.equal(canonicalArmId({ family: "a".repeat(31), params: { workers: 4 } }).length, 64);
  for (const family of ["", "Uppercase", "../single", "a".repeat(32)])
    assert.throws(() => canonicalArmId({ family, params: {} }), /definition/);
});

test("non-JSON arm parameters fail before assigning an identity", () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const sparse = Array(2);
  const extra = [1];
  Object.assign(extra, { extra: true });
  let accessed = false;
  const getter = Object.defineProperty({}, "secret", {
    enumerable: true,
    get() {
      accessed = true;
      return "not data";
    },
  });
  for (const value of [
    NaN,
    Infinity,
    undefined,
    () => {},
    Symbol("x"),
    1n,
    new Date(0),
    new Map(),
    cycle,
    sparse,
    extra,
    getter,
  ]) {
    assert.throws(() => canonicalArmId({ family: "single", params: { value } } as never), /arm parameters?/);
  }
  assert.equal(accessed, false);
  for (const params of [null, [], "not an object"])
    assert.throws(() => canonicalArmId({ family: "single", params } as never), /definition/);
});

test("plans resolve structured descriptors and reject duplicate canonical identities or forged metadata", () => {
  const review = { family: "single", params: { review: true } };
  const forged = { ...review, id: "single", requires: [], roles: [] };
  const plan = planArm(task, forged, { regime: "matched" });
  assert.equal(plan.arm.id, canonicalArmId(review));
  assert.ok(plan.arm.requires.includes("independent-review"));
  assert.deepEqual(plan.arm.roles, ["writer", "reviewer"]);
  assert.throws(
    () => planComparison(task, ["single", { family: "single", params: {} }], { regime: "matched" }),
    /distinct/,
  );
  assert.throws(
    () => planArm(task, { family: "team", params: { workers: 4 } }, { regime: "matched" }),
    (error: unknown) => error instanceof EvaluationArmError && error.code === "arm-not-executable",
  );
  assert.throws(
    () => planArm(task, { family: "best-of-n", params: { n: 4 } }, { regime: "matched" }),
    (error: unknown) => error instanceof EvaluationArmError && error.code === "arm-not-executable",
  );
});

test("canonical arm IDs have portable stable vectors for the initial controls", () => {
  assert.deepEqual(
    evaluationArms().map((arm) => arm.id),
    [
      "single",
      "single-5be7d61d3b2f49413c4d430dfaaf5687",
      "single-bff1d9a24fe367a959440318b427f08a",
      "explore-single-941e9c8ec727e2d5fd29d1b15d2e64ed",
    ],
  );
});

test("canonicalization bounds repeated-reference expansion while allowing ordinary shared data", () => {
  const shared = { effort: "highest" };
  assert.equal(
    canonicalArmId({ family: "team", params: { a: shared, b: shared } }),
    canonicalArmId({ family: "team", params: { a: { effort: "highest" }, b: { effort: "highest" } } }),
  );
  let expanded: unknown = { value: 1 };
  for (let depth = 0; depth < 20; depth++) expanded = [expanded, expanded];
  assert.throws(() => canonicalArmId({ family: "team", params: { expanded } } as never), /node limit/);
});

test("future packages register caller-owned arm definitions without changing a family, role or capability union", () => {
  const registry = createEvaluationArmRegistry();
  assert.throws(
    () => registry.resolve("unrecognized"),
    (error: unknown) => error instanceof EvaluationArmError && error.code === "arm-unknown",
  );
  const definition = { family: "team", params: { writers: 4 }, roles: ["lead", "writer"], requires: ["team-runtime"] };
  const id = registry.registerArm(definition);
  assert.equal(id, canonicalArmId(definition));
  assert.throws(() => registry.registerArm(definition), /duplicate/);
  assert.equal(planArm(task, definition, { regime: "matched" }, registry).arm.id, id);
  definition.params.writers = 2;
  definition.roles.length = 0;
  assert.deepEqual(registry.resolve(id).params, { writers: 4 });
  assert.deepEqual(registry.resolve(id).roles, ["lead", "writer"]);
  assert.throws(
    () => registry.resolve(definition),
    (error: unknown) => error instanceof EvaluationArmError && error.code === "arm-not-executable",
  );
  assert.throws(
    () => createEvaluationArmRegistry().resolve(id),
    (error: unknown) => error instanceof EvaluationArmError && error.code === "arm-unknown",
  );
  assert.throws(() => registry.registerArm({ family: "custom", params: {}, roles: [], requires: ["runtime"] }));
});

test("arm identities match K2's byte bound and never invoke descriptor getters or an inherited array iterator", () => {
  let invoked = false;
  const forged = Object.defineProperty({ params: {} }, "family", {
    get() {
      invoked = true;
      return "single";
    },
  });
  assert.throws(() => canonicalArmId(forged as never), /definition/);
  assert.equal(invoked, false);
  class ArrayWithIterator extends Array<number> {
    *[Symbol.iterator](): ArrayIterator<number> {
      invoked = true;
      yield 9;
    }
  }
  assert.equal(
    canonicalArmId({ family: "custom", params: { items: new ArrayWithIterator(1, 2) } }),
    canonicalArmId({ family: "custom", params: { items: [1, 2] } }),
  );
  assert.equal(invoked, false);
  assert.throws(() => canonicalArmId({ family: "custom", params: { text: "x".repeat(16384) } }), /byte limit/);
});
