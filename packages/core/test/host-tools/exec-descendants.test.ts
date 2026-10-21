import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createNodeExec, systemClock, type ExecResult } from "../../src/host-tools/index.ts";

const posix = process.platform !== "win32";
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (check: () => boolean, ms = 8000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return true; await new Promise((r) => setTimeout(r, 25)); }
  return check();
};
const sleepers = "setInterval(() => {}, 1000)";
/** The leader starts a grandchild in its own session that inherits stdout, so only the grandchild keeps the pipe open. */
const daemon = (leaderStays: boolean): string =>
  `const { spawn } = require("child_process"); const g = spawn(process.execPath, ["-e", ${JSON.stringify(sleepers)}], { detached: true, stdio: ["ignore", "inherit", "inherit"] }); g.unref(); console.log("grandchild " + g.pid);${leaderStays ? ` ${sleepers}` : ""}`;
const pidOf = (stdout: string): number => Number(/grandchild (\d+)/.exec(stdout)![1]);

describe("host exec: a descendant that keeps stdout open does not keep the call running", () => {
  it("returns at the time limit with timedOut set, although a detached grandchild still holds the pipe", { skip: !posix }, async () => {
    const exec = createNodeExec(systemClock);
    let pid = 0;
    try {
      const started = Date.now();
      const r = (await exec.run({ program: process.execPath, args: ["-e", daemon(true)], timeoutMs: 3000 })) as ExecResult;
      pid = pidOf(r.stdout);
      assert.equal(r.timedOut, true);
      assert.ok(Date.now() - started < 8000, `took ${Date.now() - started} ms`);
    } finally {
      if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    }
  });

  it("returns when the leader exits, with the output it wrote, although a detached grandchild still holds the pipe", { skip: !posix }, async () => {
    const exec = createNodeExec(systemClock);
    let pid = 0;
    try {
      const started = Date.now();
      const r = (await exec.run({ program: process.execPath, args: ["-e", daemon(false)], timeoutMs: 20000 })) as ExecResult;
      pid = pidOf(r.stdout);
      assert.equal(r.exitCode, 0);
      assert.equal(r.timedOut, false);
      assert.ok(Date.now() - started < 8000, `took ${Date.now() - started} ms`);
    } finally {
      if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    }
  });

  it("the time limit ends the leader's whole process group, not only the leader", { skip: !posix }, async () => {
    const exec = createNodeExec(systemClock);
    const script = `const { spawn } = require("child_process"); const g = spawn(process.execPath, ["-e", ${JSON.stringify(sleepers)}], { stdio: "ignore" }); console.log("grandchild " + g.pid); ${sleepers}`;
    const r = (await exec.run({ program: process.execPath, args: ["-e", script], timeoutMs: 3000 })) as ExecResult;
    const pid = pidOf(r.stdout);
    try {
      assert.equal(r.timedOut, true);
      assert.ok(await until(() => !alive(pid)), "the grandchild outlived the time limit");
    } finally {
      try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    }
  });

  it("keeps the complete output of an ordinary command", async () => {
    const exec = createNodeExec(systemClock);
    const r = (await exec.run({ program: process.execPath, args: ["-e", 'process.stdout.write("x".repeat(100000)); process.stderr.write("e")'], maxOutputBytes: 200000 })) as ExecResult;
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout.length, 100000);
    assert.equal(r.stderr, "e");
  });
});
