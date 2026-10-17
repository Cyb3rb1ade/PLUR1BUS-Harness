import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/temp-dir.ts";

// These tests run src/bin.ts directly (type stripping + the `source` condition) and only exercise what happens before the
// core is created, so they need neither a build nor the engine.
const entry = fileURLToPath(new URL("../src/bin.ts", import.meta.url));
const pkgRoot = fileURLToPath(new URL("..", import.meta.url));
const NODE_ARGS = ["--experimental-strip-types", "--conditions=source", "--no-warnings=ExperimentalWarning"];

interface Run { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }
function run(args: string[], env: Record<string, string> = {}, onStderr?: (text: string, child: ReturnType<typeof spawn>) => void): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...NODE_ARGS, entry, ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`timeout; stderr: ${stderr}`)); }, 30_000);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; onStderr?.(stderr, child); });
    child.once("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}
/** A stack trace (`    at …`) or a repository path must never reach the operator's terminal or a supervisor's pipe. */
function assertNoStack(r: Run) {
  assert.doesNotMatch(r.stderr, /^\s+at /m, r.stderr);
  assert.equal(r.stderr.includes(pkgRoot), false, r.stderr);
  assert.equal(r.stdout, "", "stdout carries only the ready line");
}
const GUARD = { PLUR1BUS_ALLOW_TEST_INTERNALS: "1" };

describe("bin.ts argument handling (exit 2, one line, no stack)", () => {
  for (const [name, args] of [
    ["an unknown flag", ["--bogus"]],
    ["a positional argument", ["stray"]],
    ["--home without a value", ["--home"]],
    ["an empty --home=", ["--home="]],
    ["an empty --test-internals=", ["--test-internals="]],
    ["an empty --instance=", ["--instance="]],
    ["an empty --lifeline=", ["--lifeline="]],
  ] as const) {
    it(`${name} exits 2`, async () => {
      const r = await run([...args]);
      assert.equal(r.code, 2, r.stderr);
      assert.match(r.stderr, /^core: /m);
      assertNoStack(r);
    });
  }
});

describe("bin.ts fatal errors", () => {
  for (const variant of ["crash-reject", "crash-throw"]) {
    it(`${variant}: exit 1 with a one-line message, no stack`, async () => {
      const r = await run(["--home", tempDir("p1b-bin-entry-"), "--test-internals", variant], GUARD);
      assert.equal(r.code, 1, r.stderr);
      assert.match(r.stderr, /^core: (unhandled rejection|uncaught exception): Error: boom/m);
      assertNoStack(r);
    });
  }
});

describe("bin.ts signals", { skip: process.platform === "win32" && "POSIX signal semantics" }, () => {
  it("SIGINT exits 130 (CLI convention for an interrupted process)", async () => {
    const r = await run(["--home", tempDir("p1b-bin-entry-"), "--test-internals", "stall"], GUARD, (text, child) => { if (text.includes("stall armed") && !child.killed) child.kill("SIGINT"); });
    assert.equal(r.code, 130, r.stderr);
  });
  it("SIGTERM stays a clean stop: exit 0", async () => {
    const r = await run(["--home", tempDir("p1b-bin-entry-"), "--test-internals", "stall"], GUARD, (text, child) => { if (text.includes("stall armed") && !child.killed) child.kill("SIGTERM"); });
    assert.equal(r.code, 0, r.stderr);
  });
});
