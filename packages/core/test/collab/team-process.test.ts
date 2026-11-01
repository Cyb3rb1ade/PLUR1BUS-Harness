/** K2 process ownership, cleaned command environments and explicit D123 Q6 platform refusal. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TEAM_ROOT } from "./fixtures/team-support.ts";
const { runOwnedCommand } = await import(new URL("_shared/process.mjs", TEAM_ROOT).href);
const { requirePlatform, IsolationUnavailable, executionEnvironment, K2_CONTRACT } = await import(
  new URL("_shared/contract.mjs", TEAM_ROOT).href
);

test("the published K2 platform and environment boundary is exact, with typed Windows refusal and no fallback", () => {
  assert.deepEqual(K2_CONTRACT.livePlatforms, ["linux"]);
  assert.deepEqual(K2_CONTRACT.fixturePlatforms, ["darwin", "linux"]);
  for (const mode of ["fixture", "live"]) {
    assert.throws(
      () => requirePlatform(mode, "win32"),
      (error: unknown) =>
        error instanceof IsolationUnavailable && (error as { code: string }).code === "platform-unavailable",
    );
  }
  assert.throws(() => requirePlatform("live", "darwin"), IsolationUnavailable);
  requirePlatform("live", "linux");
  assert.deepEqual(
    executionEnvironment({
      HOME: "/owned",
      PATH: "/bin",
      CI: "1",
      GOROOT: "/runtime/go",
      NODE_OPTIONS: "injected",
      AWS_SECRET_ACCESS_KEY: "canary",
      RUSTFLAGS: "injected",
      LC_ALL: "bad\u0000value",
    }),
    { HOME: "/owned", PATH: "/bin", CI: "1", GOROOT: "/runtime/go" },
  );
});

test("the process port escalates a SIGTERM trap to SIGKILL and bounds output", async () => {
  const root = await mkdtemp(join(tmpdir(), "p1b-team-term-"));
  try {
    if (process.platform === "win32") {
      assert.throws(
        () => runOwnedCommand({ program: process.execPath, args: [], cwd: root, env: {}, timeoutMs: 1000 }),
        IsolationUnavailable,
      );
      return;
    }
    const controller = new AbortController();
    const term = join(root, "term");
    const code = `const fs = require("node:fs");
process.on("SIGTERM", () => fs.writeFileSync(${JSON.stringify(term)}, "seen"));
process.stdout.write("ready");
setInterval(() => {}, 1000);`;
    const start = performance.now();
    const result = await runOwnedCommand({
      program: process.execPath,
      args: ["-e", code],
      cwd: root,
      env: {},
      timeoutMs: 5000,
      signal: controller.signal,
      onOutput: () => controller.abort(),
    });
    assert.equal(result.reason, "aborted");
    assert.equal(result.signal, "SIGKILL");
    assert.equal(await readFile(term, "utf8"), "seen");
    assert.ok(performance.now() - start < 4000);
    const capped = await runOwnedCommand({
      program: process.execPath,
      args: ["-e", "process.stdout.write(\"x\".repeat(100000)); setInterval(() => {}, 1000)"],
      cwd: root,
      env: {},
      timeoutMs: 5000,
      maxOutputBytes: 512,
    });
    assert.equal(capped.reason, "output-limit");
    assert.ok(Buffer.byteLength(capped.stdout) <= 512);
    const environment = await runOwnedCommand({
      program: process.execPath,
      args: ["-e", "process.stdout.write(process.env.PLUR1BUS_TEAM_ENV_CANARY ?? \"absent\")"],
      cwd: root,
      env: { NODE_OPTIONS: "--require /missing-loader", PLUR1BUS_TEAM_ENV_CANARY: "private" },
      timeoutMs: 5000,
    });
    assert.equal(environment.code, 0);
    assert.equal(environment.stdout, "absent");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("leader exit kills its orphaned descendant even when the descendant inherits stdout", async () => {
  const root = await mkdtemp(join(tmpdir(), "p1b-team-orphan-"));
  try {
    if (process.platform === "win32") {
      assert.throws(
        () => runOwnedCommand({ program: process.execPath, args: [], cwd: root, env: {}, timeoutMs: 1000 }),
        IsolationUnavailable,
      );
      return;
    }
    const pidFile = join(root, "descendant");
    const child = join(root, "child.cjs");
    await writeFile(
      child,
      `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.send("ready"); setInterval(() => {}, 1000);`,
    );
    const code = `const child = require("node:child_process").fork(${JSON.stringify(child)}, [], {
stdio: ["ignore", "inherit", "inherit", "ipc"] }); child.on("message", () => process.exit(0));`;
    const result = await runOwnedCommand({
      program: process.execPath,
      args: ["-e", code],
      cwd: root,
      env: {},
      timeoutMs: 5000,
    });
    assert.equal(result.code, 0);
    assert.equal(result.reason, undefined);
    const pid = (await readFile(pidFile, "utf8")).trim();
    let status = "";
    try {
      status = execFileSync("/bin/ps", ["-o", "stat=", "-p", pid], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      // A reaped descendant has no process-table entry. A zombie has exited and owns no running code or pipes.
    }
    assert.ok(!status.trim() || status.trim().startsWith("Z"), `descendant still running: ${status}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
