// Tests against real processes, on every platform (the tree test ends the tree with `taskkill /T /F` on Windows
// and a process-group kill elsewhere). Short real timeouts, hard test timeouts.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execRun, createNodeProcessPort, systemTimers, ExecFailure, type ExecConfig } from "../../../src/tools/exec/index.ts";
import { memoryAuditSink } from "../../../src/rbac/audit.ts";
import { ctx, FakeClock, MemoryGrants } from "../../policy/helpers.ts";
import { tmpRoot } from "./helpers.ts";

function real(root: string, extra: Record<string, unknown> = {}, cfg: Partial<ExecConfig> = {}) {
  return {
    config: { mode: "allowlist" as const, roots: [{ id: "r", path: root }], allowlist: [{ program: process.execPath }], envAllow: ["PATH"], ...cfg },
    process: createNodeProcessPort(), timers: systemTimers, audit: memoryAuditSink(),
    policy: { grants: new MemoryGrants([]), clock: new FakeClock(Date.now()) },
    baseEnv: { PATH: process.env.PATH, SECRET_TOKEN: "leak-me", HOME: "/h" }, policyContext: ctx(), ...extra,
  };
}

describe("exec.run against real processes", { timeout: 30_000 }, () => {
  it("passes injection-shaped arguments literally and leaks no inherited secret", async () => {
    const { root, sub } = tmpRoot();
    const script = join(sub, "show.mjs");
    // Exact names, not /HOME/: Windows itself adds HOMEDRIVE and HOMEPATH to every child, which is not an inherited
    // value; what must never arrive is the base environment's SECRET_TOKEN and HOME.
    writeFileSync(script, "console.log(JSON.stringify({ argv: process.argv.slice(2), env: Object.keys(process.env).filter((k) => /^(SECRET_TOKEN|HOME)$/i.test(k)) }));");
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
  it("on timeout ends the child and its grandchild", async () => {
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

/** A program that proves it ran by creating a file; a refused call must leave no file. */
function marker(sub: string, name: string): { script: string; file: string } {
  const script = join(sub, `mark-${name}.mjs`);
  const file = join(sub, `ran-${name}`);
  writeFileSync(script, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(file)}, "x");`);
  return { script, file };
}
const refusedWith = (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (e: unknown) => e instanceof ExecFailure && e.code === code, `expected ${code}`);

describe("exec.run tiers against real processes", { timeout: 60_000 }, () => {
  it("deny (the default) and an unknown mode start nothing", async () => {
    const { root, sub } = tmpRoot();
    const m = marker(sub, "deny");
    await refusedWith(execRun({ program: process.execPath, args: [m.script], cwd: sub }, real(root, {}, { mode: "deny" })), "disabled");
    await refusedWith(execRun({ program: process.execPath, args: [m.script], cwd: sub }, real(root, {}, { mode: "yolo" as never })), "disabled");
    assert.ok(!existsSync(m.file));
  });

  it("allowlist: an unlisted program, a path spelling of a bare entry and an argument outside argPattern start nothing; a listed call runs", async () => {
    const { root, sub } = tmpRoot();
    const m = marker(sub, "allow");
    const other = { allowlist: [{ program: "git" }] };
    await refusedWith(execRun({ program: process.execPath, args: [m.script], cwd: sub }, real(root, {}, other)), "not-allowlisted");
    // A bare entry matches the bare name only, never a path that happens to end in it.
    await refusedWith(execRun({ program: process.execPath, args: [m.script], cwd: sub }, real(root, {}, { allowlist: [{ program: "node" }] })), "not-allowlisted");
    const pinned = { allowlist: [{ program: process.execPath, argPattern: "^(-p|1\\+1)$" }] };
    await refusedWith(execRun({ program: process.execPath, args: [m.script], cwd: sub }, real(root, {}, pinned)), "not-allowlisted");
    assert.ok(!existsSync(m.file));
    const ok = await execRun({ program: process.execPath, args: ["-p", "1+1"], cwd: sub }, real(root, {}, pinned));
    assert.equal(ok.exitCode, 0);
    assert.equal(ok.stdout.trim(), "2");
  });

  it("ask: approval runs it; refusal, a throwing or missing approval port and a headless run start nothing", async () => {
    const { root, sub } = tmpRoot();
    const yes = marker(sub, "yes");
    const asked: unknown[] = [];
    const approve = { approvals: { request: async (r: unknown) => { asked.push(r); return { approved: true }; } } };
    const r = await execRun({ program: process.execPath, args: [yes.script], cwd: sub }, real(root, approve, { mode: "ask" }));
    assert.equal(r.exitCode, 0);
    assert.equal(asked.length, 1);
    assert.ok(existsSync(yes.file));

    const no = marker(sub, "no");
    const refuse = { approvals: { request: async () => ({ approved: false }) } };
    await refusedWith(execRun({ program: process.execPath, args: [no.script], cwd: sub }, real(root, refuse, { mode: "ask" })), "approval-denied");
    const boom = { approvals: { request: async () => { throw new Error("x"); } } };
    await refusedWith(execRun({ program: process.execPath, args: [no.script], cwd: sub }, real(root, boom, { mode: "ask" })), "approval-denied");
    await refusedWith(execRun({ program: process.execPath, args: [no.script], cwd: sub }, real(root, { approvals: undefined }, { mode: "ask" })), "approval-denied");
    const base = real(root, approve, { mode: "ask" });
    const headless = real(root, { ...approve, policyContext: { ...base.policyContext, headless: { jobId: "j" } } }, { mode: "ask" });
    await refusedWith(execRun({ program: process.execPath, args: [no.script], cwd: sub }, headless), "approval-denied");
    assert.equal(asked.length, 1, "a headless run never asks");
    assert.ok(!existsSync(no.file));
  });

  it("policy deny (tools.deny) wins over the allowlist, and a cwd outside every root starts nothing", async () => {
    const { root, sub } = tmpRoot();
    const m = marker(sub, "policy");
    const base = real(root);
    await refusedWith(execRun({ program: process.execPath, args: [m.script], cwd: sub }, real(root, { policyContext: { ...base.policyContext, toolsDeny: ["shell.*"] } })), "policy-denied");
    const outside = tmpRoot();
    await refusedWith(execRun({ program: process.execPath, args: [m.script], cwd: outside.sub }, real(root)), "cwd-refused");
    assert.ok(!existsSync(m.file));
  });
});
