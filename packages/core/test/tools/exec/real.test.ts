// Smoke tests against real processes (POSIX only for the tree test; the rest is portable). Short real timeouts, hard test timeouts.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execRun, createNodeProcessPort, systemTimers } from "../../../src/tools/exec/index.ts";
import { memoryAuditSink } from "../../../src/rbac/audit.ts";
import { ctx, FakeClock, MemoryGrants } from "../../policy/helpers.ts";
import { tmpRoot } from "./helpers.ts";

function real(root: string, extra: Record<string, unknown> = {}) {
  return {
    config: { mode: "allowlist" as const, roots: [{ id: "r", path: root }], allowlist: [{ program: process.execPath }], envAllow: ["PATH"] },
    process: createNodeProcessPort(), timers: systemTimers, audit: memoryAuditSink(),
    policy: { grants: new MemoryGrants([]), clock: new FakeClock(Date.now()) },
    baseEnv: { PATH: process.env.PATH, SECRET_TOKEN: "leak-me", HOME: "/h" }, policyContext: ctx(), ...extra,
  };
}

describe("exec.run against real processes", { timeout: 30_000 }, () => {
  it("passes injection-shaped arguments literally and leaks no inherited secret", async () => {
    const { root, sub } = tmpRoot();
    const script = join(sub, "show.mjs");
    writeFileSync(script, "console.log(JSON.stringify({ argv: process.argv.slice(2), env: Object.keys(process.env).filter((k) => /SECRET|HOME/.test(k)) }));");
    const args = ["; touch pwned", "$(touch pwned)", "`touch pwned`", "a && b", "*"];
    const r = await execRun({ program: process.execPath, args: [script, ...args], cwd: sub }, real(root));
    assert.equal(r.exitCode, 0);
    assert.deepEqual(JSON.parse(r.stdout), { argv: args, env: [] });
    assert.ok(!existsSync(join(sub, "pwned")));
  });
  it("truncates large real output and keeps the process from blocking", async () => {
    const { root, sub } = tmpRoot();
    const r = await execRun({ program: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(2_000_000))"], cwd: sub, maxOutputBytes: 1000 }, real(root));
    assert.equal(r.stdout.length, 1000);
    assert.equal(r.stdoutTruncated, true);
    assert.equal(r.exitCode, 0);
  });
  it("on timeout ends the child and its grandchild", { skip: process.platform === "win32" }, async () => {
    const { root, sub } = tmpRoot();
    const pidFile = join(sub, "grandchild.pid");
    const script = join(sub, "tree.mjs");
    writeFileSync(script, `
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });
      writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
      setInterval(() => {}, 1000);`);
    const r = await execRun({ program: process.execPath, args: [script], cwd: sub, timeoutMs: 1500 }, real(root));
    assert.equal(r.timedOut, true);
    const gpid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(gpid > 0);
    let alive = true;
    for (let i = 0; i < 50 && alive; i += 1) {
      try { process.kill(gpid, 0); await new Promise((res) => setTimeout(res, 50)); } catch { alive = false; }
    }
    assert.equal(alive, false, "grandchild must be gone");
  });
});

describe("node process port on Windows", () => {
  it("ends the tree with taskkill /T /F, once", async () => {
    const calls: string[][] = [];
    const port = createNodeProcessPort({ platform: "win32", taskkill: async (a) => { calls.push([...a]); } });
    const h = port.spawn({ program: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: process.cwd(), env: { PATH: process.env.PATH ?? "" } });
    await h.killTree(); await h.killTree();
    await h.wait().catch(() => undefined);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.slice(0, 1).concat(calls[0]!.slice(2)), ["/PID", "/T", "/F"]);
  });
});
