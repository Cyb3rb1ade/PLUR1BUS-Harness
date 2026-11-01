/** End-state checking executes real seeded TS code and refuses unavailable live isolation. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { realTempDir } from "../helpers/real-temp-dir.ts";
import { rm } from "node:fs/promises";
import { loadCodingCorpus, renderCodingTask } from "../../src/toolcall/coding-bench-corpus.ts";
import { verifyCodingTask } from "../../src/toolcall/coding-bench-checker.ts";
import type { CodingImage } from "../../src/toolcall/coding-bench-workspace.ts";

const root = fileURLToPath(new URL("../../../../tests/bench/coding/", import.meta.url));
const image = (files: Map<string, { text: string; mode: number }>): CodingImage =>
  new Map([...files].map(([name, file]) => [name, { data: Buffer.from(file.text), mode: file.mode }]));
const runtime = {
  node: process.execPath,
  rustc: "",
  rustRoot: "",
  go: "",
  goRoot: "",
  python: "",
  shell: "",
  cache: "",
  versions: { node: process.versions.node, rust: "", go: "", python: "" },
  close: async () => {},
};

test("the same hidden checker rejects the seeded starter and accepts the real reference", async () => {
  const corpus = await loadCodingCorpus(root);
  const task = corpus.tasks.find((t) => t.meta.id === "easy-ts-tags")!;
  for (const seed of corpus.seeds) {
    const start = await renderCodingTask(task, seed, "start");
    const reference = await renderCodingTask(task, seed, "reference");
    const options = { mode: "fixture" as const, runtimes: runtime, signal: new AbortController().signal };
    const rejected = await verifyCodingTask(task, start.variant, image(start.files), options);
    const accepted = await verifyCodingTask(task, reference.variant, image(reference.files), options);
    assert.equal(rejected.passed, false);
    assert.equal(accepted.passed, process.platform !== "win32");
    assert.equal(accepted.unavailable, process.platform === "win32");
  }
});

test("missing live isolation never falls back to trusted fixture execution", async () => {
  const corpus = await loadCodingCorpus(root);
  const task = corpus.tasks.find((t) => t.meta.id === "easy-ts-tags")!;
  const reference = await renderCodingTask(task, 11, "reference");
  let calls = 0;
  const result = await verifyCodingTask(task, reference.variant, image(reference.files), {
    mode: "live",
    runtimes: runtime,
    signal: new AbortController().signal,
    verifier: {
      async run() {
        calls++;
        return { ok: false, exitCode: null, reason: "sandbox-unavailable", output: "" };
      },
    },
    async provision() {
      const root = await realTempDir("p1b-coding-check-unavailable-");
      return { root, close: () => rm(root, { recursive: true, force: true }) };
    },
  });
  assert.equal(result.passed, false);
  assert.equal(result.unavailable, true);
  assert.equal(calls, process.platform === "linux" ? 1 : 0);
});

test("unexpected verifier failures remain infrastructure errors and still close its provisioned root", async () => {
  const corpus = await loadCodingCorpus(root);
  const task = corpus.tasks.find((t) => t.meta.id === "easy-ts-tags")!;
  const instance = await renderCodingTask(task, 11, "reference");
  const failure = new Error("trusted verifier failed");
  let closed = false;
  const result = verifyCodingTask(task, instance.variant, image(instance.files), {
    mode: "live",
    runtimes: runtime,
    signal: new AbortController().signal,
    verifier: {
      async run() {
        throw failure;
      },
    },
    async provision() {
      const path = await realTempDir("p1b-coding-infrastructure-");
      return {
        root: path,
        async close() {
          closed = true;
          await rm(path, { recursive: true, force: true });
        },
      };
    },
  });
  if (process.platform === "linux") {
    await assert.rejects(result, (error) => error === failure);
    assert.equal(closed, true);
  } else {
    assert.equal((await result).reason, "unavailable");
    assert.equal(closed, false);
  }
});

test("the worker checker rejects fixed batching that leaves a slot idle behind a blocked first item", async () => {
  const corpus = await loadCodingCorpus(root);
  const task = corpus.tasks.find((t) => t.meta.id === "hard-ts-workers")!;
  const instance = await renderCodingTask(task, 11, "reference");
  const candidate = image(instance.files);
  candidate.set(instance.variant.entry, {
    mode: 0o600,
    data: Buffer.from(`
export async function ${instance.variant.symbol}(items, limit, worker, signal) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("invalid concurrency");
  if (signal.aborted) throw signal.reason;
  const values = [];
  for (let first = 0; first < items.length; first += limit) {
    const batch = await Promise.allSettled(items.slice(first, first + limit)
      .map((item, offset) => worker(item, first + offset, signal)));
    const failure = batch.find(result => result.status === "rejected");
    if (failure) throw failure.reason;
    if (signal.aborted) throw signal.reason;
    values.push(...batch.map(result => result.value));
  }
  return values;
}`),
  });
  const result = await verifyCodingTask(task, instance.variant, candidate, {
    mode: "fixture",
    runtimes: runtime,
    signal: new AbortController().signal,
  });
  assert.equal(result.reason, process.platform === "win32" ? "unavailable" : "unresolved");
});
