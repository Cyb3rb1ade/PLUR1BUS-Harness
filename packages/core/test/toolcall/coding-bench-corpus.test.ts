/** Original B1 corpus invariants, seeded public trees, and hostile manifest refusal. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { realTempDir } from "../helpers/real-temp-dir.ts";
import { fileURLToPath } from "node:url";
import { loadCodingCorpus, parseCodingTask, renderCodingTask } from "../../src/toolcall/coding-bench-corpus.ts";

const root = fileURLToPath(new URL("../../../../tests/bench/coding/", import.meta.url));

test("the original set has 24 balanced tasks, five languages, and three canonical seeds", async () => {
  const corpus = await loadCodingCorpus(root);
  assert.equal(corpus.tasks.length, 24);
  for (const tier of ["easy", "medium", "hard"]) {
    assert.equal(corpus.tasks.filter((t) => t.meta.tier === tier).length, 8);
  }
  assert.equal(corpus.tasks.filter((t) => t.meta.kind === "repository").length, 12);
  assert.equal(new Set(corpus.tasks.map((t) => t.meta.language)).size, 5);
  assert.deepEqual(corpus.seeds, [11, 29, 47]);
  assert.match(corpus.fingerprint, /^[a-f0-9]{64}$/u);
});

test("each seeded public tree changes names and contains neither checker nor reference material", async () => {
  const corpus = await loadCodingCorpus(root);
  for (const task of corpus.tasks) {
    const names = new Set<string>();
    for (const seed of corpus.seeds) {
      const instance = await renderCodingTask(task, seed, "start");
      names.add(instance.variant.entry);
      assert.ok(instance.files.has(instance.variant.entry));
      assert.ok(instance.files.has("README.md"));
      for (const [name, file] of instance.files) {
        assert.ok(!/checker|reference|task\.json/u.test(name));
        assert.ok(!file.text.includes("BENCH_FN") && !file.text.includes("BENCH_ENTRY"));
      }
      assert.ok(instance.instruction.includes(instance.variant.entry));
    }
    assert.equal(names.size, 3);
  }
});

test("seeding is deterministic and invalid seeds cannot create paths", async () => {
  const corpus = await loadCodingCorpus(root);
  const task = corpus.tasks[0]!;
  assert.deepEqual(await renderCodingTask(task, 11, "start"), await renderCodingTask(task, 11, "start"));
  for (const seed of [-1, 0.1, NaN, 0x1_0000_0000]) {
    await assert.rejects(renderCodingTask(task, seed, "start"));
  }
});

test("manifest boundaries refuse unknown keys, escaping paths and missing budgets", () => {
  const value = JSON.parse(readFileSync(root + "/easy-rust-window/task.json", "utf8"));
  assert.equal(parseCodingTask(value).id, "easy-rust-window");
  for (const bad of [
    { ...value, extra: true },
    { ...value, entry: "../outside.rs" },
    { ...value, entry: "/outside.rs" },
    { ...value, entry: "src\\outside.rs" },
    { ...value, network: true },
    { ...value, license: "unknown" },
    { ...value, budgets: { ...value.budgets, tokens: 0 } },
    { ...value, budgets: { ...value.budgets, extra: 1 } },
    { ...value, origin: "upstream" },
  ])
    assert.throws(() => parseCodingTask(bad));
});

test("the reserved top-level team corpus cannot alter B1 tasks, limits or fingerprint", async () => {
  const temporary = await realTempDir("p1b-coding-team-boundary-");
  try {
    const directory = join(temporary, "coding");
    await cp(root, directory, { recursive: true });
    const before = await loadCodingCorpus(directory);
    await mkdir(join(directory, "team"));
    await writeFile(join(directory, "team", "task.json"), "invalid independent team metadata");
    await writeFile(join(directory, "team", "large.bin"), Buffer.alloc(1_048_577));
    const after = await loadCodingCorpus(directory);
    assert.equal(after.fingerprint, before.fingerprint);
    assert.deepEqual(
      after.tasks.map((task) => task.meta),
      before.tasks.map((task) => task.meta),
    );
    assert.deepEqual(after.seeds, before.seeds);
    const task = before.tasks[0]!;
    const entry = join(directory, task.meta.id, "start", task.meta.entry);
    await writeFile(entry, (await readFile(entry, "utf8")) + "\n");
    assert.notEqual((await loadCodingCorpus(directory)).fingerprint, before.fingerprint);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
