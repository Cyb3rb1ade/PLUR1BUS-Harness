/** Runtime compatibility and infrastructure/candidate distinction using authored adversarial fixtures only. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir, symlink, open, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { watch } from "node:fs/promises";
import { TEAM_ROOT, TEAM_TASKS, materializer, verifyFixture } from "./fixtures/team-support.ts";
import type { TeamTask } from "../../src/collab/team-eval.ts";

async function candidate(taskId: string, run: (task: TeamTask, root: string, tag: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "p1b-team-contract-"));
  const task = TEAM_TASKS.find((task) => task.id === taskId)!;
  const root = join(directory, "candidate");
  try {
    await materializer.materialize(
      fileURLToPath(new URL(`${task.id}/`, TEAM_ROOT)),
      root,
      task.seeds[0],
      task.packages.length,
    );
    const instance = JSON.parse(await readFile(join(root, "instance.json"), "utf8")) as { tag: string };
    await run(task, root, instance.tag);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function unsupported(report: Awaited<ReturnType<typeof verifyFixture>>): boolean {
  if (process.platform !== "win32") return false;
  assert.equal(report.result.reason, "unavailable");
  assert.deepEqual(report.infrastructure, ["platform-unavailable"]);
  assert.deepEqual(report.checks, []);
  return true;
}

test("valid TypeScript enum syntax and a Python neighbor module pass the declared runtime contract", async () => {
  for (const taskId of ["ts-calendar", "py-document-index"]) {
    await candidate(taskId, async (task, root, tag) => {
      const entry = join(root, task.packages[0]!.entry.replaceAll("__SEED__", tag));
      const original = await readFile(entry, "utf8");
      if (task.language === "typescript") {
        await writeFile(entry, `enum Mode { Normal = 0 }\n${original}\nvoid Mode.Normal;\n`);
      } else {
        await writeFile(join(root, "src", "neighbor.py"), original);
        await writeFile(entry, `from neighbor import ${task.packages[0]!.symbol.replaceAll("__SEED__", tag)}\n`);
      }
      const report = await verifyFixture(task, root, task.seeds[0]!);
      if (!unsupported(report)) assert.equal(report.result.passed, true, JSON.stringify(report));
    });
  }
});

test("candidate compiler and module configuration is ignored; broken siblings retain separate compiled grades", async () => {
  for (const taskId of ["rs-range-set", "go-file-manifest"]) {
    await candidate(taskId, async (task, root, tag) => {
      await writeFile(join(root, "rust-toolchain.toml"), "[toolchain]\nchannel = \"missing-custom-channel\"\n");
      await writeFile(join(root, "go.mod"), "invalid toolchain/replace module data\n");
      const before = await verifyFixture(task, root, task.seeds[0]!);
      if (unsupported(before)) return;
      assert.equal(before.result.passed, true, JSON.stringify(before));
      await writeFile(join(root, task.packages[0]!.entry.replaceAll("__SEED__", tag)), "deliberately invalid source\n");
      const after = await verifyFixture(task, root, task.seeds[0]!);
      assert.equal(after.result.unavailable, false);
      assert.deepEqual(
        after.checks.map((check) => check.passed),
        [false, true, true, false],
      );
    });
  }
});

test("missing or broken toolchains fail the known-good preflight before any candidate is graded", async () => {
  await candidate("py-document-index", async (task, root) => {
    for (const program of [join(root, "missing-tool"), process.execPath]) {
      const report = await verifyFixture(task, root, task.seeds[0]!, { runtimes: { python: { program } } });
      if (unsupported(report)) continue;
      assert.equal(report.result.reason, "unavailable");
      assert.deepEqual(report.infrastructure, ["toolchain-unavailable"]);
      assert.deepEqual(report.checks, []);
    }
  });
});

test("a Rust candidate deleting its executable is unresolved, never an infrastructure exclusion", async () => {
  await candidate("rs-range-set", async (task, root, tag) => {
    const entry = join(root, task.packages[0]!.entry.replaceAll("__SEED__", tag));
    const symbol = task.packages[0]!.symbol.replaceAll("__SEED__", tag);
    await writeFile(
      entry,
      `pub fn ${symbol}(_raw: &str) -> String {
let _ = std::fs::remove_file(std::env::current_exe().unwrap()); "wrong".into()
}\n`,
    );
    const report = await verifyFixture(task, root, task.seeds[0]!);
    if (unsupported(report)) return;
    assert.equal(report.result.reason, "unresolved");
    assert.equal(report.result.unavailable, false);
    assert.deepEqual(report.infrastructure, []);
    assert.equal(report.checks[0]!.reason, "candidate-error");
    assert.ok(report.checks[0]!.failures.length > 1);
  });
});

test("one overall task deadline terminates a trapping candidate without multiplying the limit by cases or scopes", async () => {
  await candidate("ts-event-ledger", async (task, root, tag) => {
    const entry = join(root, task.packages[0]!.entry.replaceAll("__SEED__", tag));
    const symbol = task.packages[0]!.symbol.replaceAll("__SEED__", tag);
    await writeFile(
      entry,
      `export function ${symbol}(_raw: string): string {
process.on("SIGTERM", () => {}); for (;;) {} }
`,
    );
    const began = performance.now();
    const report = await verifyFixture(task, root, task.seeds[0]!, { timeoutMs: 2000 });
    if (unsupported(report)) return;
    assert.equal(report.result.reason, "unresolved");
    assert.equal(report.result.unavailable, false);
    assert.equal(report.checks.length, task.packages.length + 1);
    assert.ok(report.checks.every((check) => !check.passed));
    assert.ok(performance.now() - began < 8000);
  });
});

test("a later coupled stage needs the actual preceding implementation as well as its standalone contract", async () => {
  await candidate("ts-schema-migration", async (task, root, tag) => {
    const entry = join(root, task.packages[0]!.entry.replaceAll("__SEED__", tag));
    const text = await readFile(entry, "utf8");
    await writeFile(
      entry,
      text.replace(/function impl_decode\(raw: string\): string \{/, (match) => `${match}\nreturn "unimplemented";`),
    );
    const report = await verifyFixture(task, root, task.seeds[0]!);
    if (unsupported(report)) return;
    assert.equal(report.result.passed, false);
    for (const check of report.checks.slice(1, -1)) {
      assert.equal(check.passed, false);
      assert.ok(
        check.failures.some((id) => id.includes("prefix")),
        JSON.stringify(check),
      );
      assert.ok(check.failures.length < check.cases, "standalone cases still prove that the later code works");
    }
  });
});

test("the host CLI emits only the K2 verdict when candidate compilation contains a diagnostic canary", async () => {
  await candidate("rs-range-set", async (task, root, tag) => {
    const canary = "TM2_PRIVATE_COMPILER_DIAGNOSTIC_CANARY";
    await writeFile(join(root, task.packages[0]!.entry.replaceAll("__SEED__", tag)), `invalid Rust ${canary}\n`);
    const script = fileURLToPath(new URL(`${task.id}/check.mjs`, TEAM_ROOT));
    const execution = await new Promise<{ code: number | string | undefined; stdout: string; stderr: string }>(
      (resolve) => {
        execFile(
          process.execPath,
          [
            "--experimental-strip-types",
            script,
            "--candidate",
            root,
            "--seed",
            String(task.seeds[0]),
            "--scope",
            "all",
            "--fixture",
          ],
          { timeout: 30000, encoding: "utf8" },
          (error, stdout, stderr) => resolve({ code: error?.code ?? undefined, stdout, stderr }),
        );
      },
    );
    assert.equal(execution.code, 1);
    assert.ok(!`${execution.stdout}${execution.stderr}`.includes(canary));
    const result = JSON.parse(execution.stdout) as { passed: boolean; reason: string };
    assert.deepEqual(Object.keys(result).sort(), ["passed", "reason", "unavailable", "wallMs"]);
    assert.equal(result.passed, false);
    assert.equal(result.reason, process.platform === "win32" ? "unavailable" : "unresolved");
  });
});

test("SIGTERM of the host CLI reaps a trapping candidate and removes its private snapshot", async () => {
  await candidate("ts-event-ledger", async (task, root, tag) => {
    if (process.platform === "win32") {
      const report = await verifyFixture(task, root, task.seeds[0]!);
      assert.equal(unsupported(report), true);
      return;
    }
    const ready = join(root, "ready");
    const source = `import { writeFileSync, renameSync } from "node:fs";
export function ${task.packages[0]!.symbol.replaceAll("__SEED__", tag)}(_raw: string): string {
process.on("SIGTERM", () => {});
writeFileSync(${JSON.stringify(ready + ".tmp")}, JSON.stringify({ pid: process.pid, cwd: process.cwd() }));
renameSync(${JSON.stringify(ready + ".tmp")}, ${JSON.stringify(ready)});
for (;;) {}
}`;
    await writeFile(join(root, task.packages[0]!.entry.replaceAll("__SEED__", tag)), source);
    const controller = new AbortController();
    const events = watch(root, { signal: controller.signal });
    const script = fileURLToPath(new URL(`${task.id}/check.mjs`, TEAM_ROOT));
    let child: ReturnType<typeof execFile> | undefined;
    const ended = new Promise<{ code: number | string | undefined; stdout: string }>((resolve) => {
      child = execFile(
        process.execPath,
        [
          "--experimental-strip-types",
          script,
          "--candidate",
          root,
          "--seed",
          String(task.seeds[0]),
          "--scope",
          "all",
          "--fixture",
        ],
        { timeout: 15000, encoding: "utf8" },
        (error, stdout) => resolve({ code: error?.code ?? undefined, stdout }),
      );
    });
    const observed = (async () => {
      for await (const event of events) {
        if (event.filename === "ready")
          return JSON.parse(await readFile(ready, "utf8")) as { pid: number; cwd: string };
      }
      throw new Error("candidate readiness was not observed");
    })();
    let descendant: { pid: number; cwd: string } | undefined;
    try {
      descendant = await Promise.race([
        observed,
        ended.then(() => {
          throw new Error("CLI exited before candidate readiness");
        }),
      ]);
      child!.kill("SIGTERM");
      const result = await ended;
      assert.equal(result.code, 1);
      assert.equal((JSON.parse(result.stdout) as { reason: string }).reason, "aborted");
      await assert.rejects(readFile(join(descendant.cwd, "instance.json")));
      assert.throws(() => process.kill(descendant!.pid, 0), /ESRCH/);
    } finally {
      controller.abort();
      child?.kill("SIGKILL");
      if (descendant) {
        try {
          process.kill(-descendant.pid, "SIGKILL");
        } catch {}
      }
    }
  });
});

test("candidate-controlled instance metadata cannot turn an unresolved candidate into an infrastructure exclusion", async () => {
  await candidate("ts-event-ledger", async (task, root) => {
    await writeFile(join(root, "instance.json"), "invalid JSON");
    const report = await verifyFixture(task, root, task.seeds[0]!);
    if (unsupported(report)) return;
    assert.equal(report.result.reason, "unresolved");
    assert.equal(report.result.unavailable, false);
    assert.deepEqual(report.infrastructure, []);
    assert.equal(report.checks.length, task.packages.length + 1);
    assert.ok(report.checks.every((check) => check.reason === "candidate-error" && !check.passed));
  });
});

test("unrelated build, Git, large-file and cache-link artifacts outside src do not affect a correct solution", async () => {
  await candidate("ts-event-ledger", async (task, root) => {
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git", "config"), "unrelated data");
    await mkdir(join(root, "cache-target"));
    await symlink(join(root, "cache-target"), join(root, "cache"), process.platform === "win32" ? "junction" : "dir");
    const large = await open(join(root, "build-output"), "w");
    try {
      await large.truncate(17 * 1024 * 1024);
    } finally {
      await large.close();
    }
    const report = await verifyFixture(task, root, task.seeds[0]!);
    if (!unsupported(report)) assert.equal(report.result.passed, true, JSON.stringify(report));
  });
});

test("provided contract edits and document symlinks are candidate failures with no infrastructure exclusion", async () => {
  for (const target of ["contract", "document"]) {
    await candidate("ts-event-ledger", async (task, root, tag) => {
      if (target === "contract") {
        await writeFile(join(root, "src", `contracts.${tag}.ts`), "replaced public interface");
      } else if (process.platform !== "win32") {
        await unlink(join(root, "TASK.md"));
        await symlink(fileURLToPath(new URL(`${task.id}/seed.mjs`, TEAM_ROOT)), join(root, "TASK.md"));
      }
      const report = await verifyFixture(task, root, task.seeds[0]!);
      if (unsupported(report)) return;
      assert.equal(report.result.reason, "unresolved");
      assert.deepEqual(report.infrastructure, []);
      assert.ok(report.checks.every((check) => check.reason === "candidate-error"));
    });
  }
});
