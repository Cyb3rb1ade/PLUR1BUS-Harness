/** Real Linux verifier acceptance for input-only execution; macOS/Windows assert the K2 live refusal instead. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { TEAM_ROOT, TEAM_TASKS, materializer, checker } from "./fixtures/team-support.ts";
import type { TeamCheck, TeamVerdict } from "./fixtures/team-support.ts";
const { createIsolation } = await import(new URL("_shared/isolation.mjs", TEAM_ROOT).href);
const { IsolationUnavailable } = await import(new URL("_shared/contract.mjs", TEAM_ROOT).href);

test("Linux isolation hides host PID/oracle paths and prevents outside writes; other live platforms refuse", async () => {
  const parent = await mkdtemp(join(tmpdir(), "p1b-team-live-proof-"));
  const root = join(parent, "workspace");
  const taskRoot = fileURLToPath(new URL("ts-calendar/", TEAM_ROOT));
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(root);
    if (process.platform !== "linux") {
      await assert.rejects(
        createIsolation({ mode: "live", root, taskRoot, signal: AbortSignal.timeout(10000) }),
        (error: unknown) =>
          error instanceof IsolationUnavailable && (error as { code: string }).code === "platform-unavailable",
      );
      await assert.rejects(access(join(root, "capture.mjs")));
      return;
    }
    const port = await createIsolation({ mode: "live", root, taskRoot, signal: AbortSignal.timeout(15000) });
    const run = (code: string) =>
      port.run({
        program: process.execPath,
        args: ["-e", code],
        cwd: root,
        env: { HOME: root, TMPDIR: root, PATH: "/usr/bin:/bin", CI: "1" },
        timeoutMs: 5000,
      });
    const ready = await run('process.stdout.write("ready")');
    assert.equal(ready.code, 0, JSON.stringify(ready));
    assert.equal(ready.stdout, "ready");
    const privateFile = join(parent, "host-only");
    const outsideWrite = join(parent, "escape");
    await writeFile(privateFile, "HOST_ORACLE_CANARY");
    const read = await run(`const fs = require("node:fs");
const cmd = fs.readFileSync("/proc/" + process.ppid + "/cmdline", "utf8");
if (cmd.includes("--seed") || cmd.includes("${taskRoot}")) throw Error("host command exposed");
for (const path of ${JSON.stringify([privateFile, join(taskRoot, "seed.mjs"), join(taskRoot, "task.json")])}) {
try { fs.readFileSync(path); process.stdout.write("exposed"); process.exit(1); } catch (error) {
if (error.code !== "ENOENT" && error.code !== "EACCES") throw error;
} }
process.stdout.write("hidden");`);
    assert.equal(read.code, 0);
    assert.equal(read.stdout, "hidden");
    const write = await run(`try { require("node:fs").writeFileSync(${JSON.stringify(outsideWrite)}, "escape");
process.stdout.write("written"); } catch { process.stdout.write("denied"); }`);
    assert.equal(write.code, 0);
    assert.equal(write.stdout, "denied");
    await assert.rejects(access(outsideWrite));
    const large = await port.run({
      program: process.execPath,
      args: ["-e", 'process.stdout.write("é".repeat(65536))'],
      cwd: root,
      env: { HOME: root, TMPDIR: root, PATH: "/usr/bin:/bin", CI: "1" },
      timeoutMs: 5000,
      digestOutput: true,
      maxOutputBytes: 1024 * 1024,
    });
    assert.equal(large.code, 0);
    assert.deepEqual(JSON.parse(large.stdout), {
      sha256: createHash("sha256").update("é".repeat(65536), "utf8").digest("hex"),
      bytes: 131072,
    });
    const descriptor = await readFile(join(root, "command.json"), "utf8");
    assert.doesNotMatch(descriptor, /"expected"|"seed"|"taskRoot"/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("an oracle-reading candidate loses behavioral grades instead of reading seed.mjs through its parent or repo", async () => {
  const parent = await mkdtemp(join(tmpdir(), "p1b-team-oracle-candidate-"));
  const task = TEAM_TASKS.find((task) => task.id === "ts-calendar")!;
  const taskRoot = fileURLToPath(new URL(`${task.id}/`, TEAM_ROOT));
  const root = join(parent, "candidate");
  try {
    await materializer.materialize(taskRoot, root, task.seeds[0], task.packages.length);
    const { tag } = JSON.parse(await readFile(join(root, "instance.json"), "utf8")) as { tag: string };
    for (const item of task.packages) {
      await writeFile(
        join(root, item.entry.replaceAll("__SEED__", tag)),
        `import { readFileSync } from "node:fs";
export async function ${item.symbol.replaceAll("__SEED__", tag)}(input: string): Promise<string> {
let command = "";
try { command = readFileSync("/proc/" + process.ppid + "/cmdline", "utf8"); } catch {}
const paths = [${JSON.stringify(join(taskRoot, "seed.mjs"))}, process.cwd() + "/seed.mjs"];
for (const path of paths) {
try {
const module = await import(path);
for (const seed of [17, 104729, 8675309]) {
const rows = module.casesForSeed(seed)[${JSON.stringify(item.id)}];
const match = rows.find((row: { input: string }) => row.input === input);
if (match) return match.expected;
}
} catch {}
}
return command.includes("--seed") ? "host-pid-exposed" : "oracle-hidden";
}
`,
      );
    }
    const checks: TeamCheck[] = [];
    const infrastructure: string[] = [];
    const result = (await checker.verify(taskRoot, root, task.seeds[0], "all", {
      mode: "live",
      onCheck: (check: TeamCheck) => checks.push(check),
      onInfrastructureFailure: (reason: string) => infrastructure.push(reason),
    })) as TeamVerdict;
    assert.equal(result.passed, false);
    if (process.platform === "linux") {
      assert.equal(result.reason, "unresolved", JSON.stringify({ result, infrastructure }));
      assert.deepEqual(infrastructure, []);
      assert.equal(checks.length, task.packages.length + 1);
      assert.ok(
        checks.every((check) => !check.passed && !check.reason),
        JSON.stringify(checks),
      );
    } else {
      assert.equal(result.reason, "unavailable");
      assert.deepEqual(infrastructure, ["platform-unavailable"]);
      assert.deepEqual(checks, []);
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
