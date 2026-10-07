import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execRun, createExecTool, ExecFailure, buildEnv, DEFAULT_ENV_ALLOW } from "../../../src/tools/exec/index.ts";
import { FakeProcess, mk, tmpRoot } from "./helpers.ts";

const fails = (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (e: unknown) => e instanceof ExecFailure && e.code === code, `expected ${code}`);

/** Runs a request against the fake port; `drive` plays the child. */
async function run(m: ReturnType<typeof mk>, req: Parameters<typeof execRun>[0], drive: (p: FakeProcess) => void = (p) => p.exit(0)) {
  m.port.onSpawn = drive;
  return execRun(req, m.deps);
}

describe("exec.run: deny is the default", () => {
  it("refuses everything in the default tier, spawns nothing and records the refusal", async () => {
    const { root, sub } = tmpRoot();
    const m = mk({ root, mode: "deny" });
    await fails(execRun({ program: "git", args: ["status"], cwd: sub }, m.deps), "disabled");
    assert.equal(m.port.spawned.length, 0);
    assert.equal(m.audit.events.length, 1);
    assert.equal(m.audit.events[0]!.action, "exec.refused");
  });
  it("an unknown mode string is treated as deny (fail closed)", async () => {
    const { root, sub } = tmpRoot();
    const m = mk({ root, mode: "yolo" as never });
    await fails(execRun({ program: "git", cwd: sub }, m.deps), "disabled");
  });
});

describe("exec.run: argument injection", () => {
  it("never reaches a shell: shells, privilege escalators, scripts and option-looking programs are refused", async () => {
    const { root, sub } = tmpRoot();
    const m = mk({ root, allowlist: [{ program: "sh" }, { program: "sudo" }] });
    for (const program of ["sh", "/bin/bash", "cmd.exe", "powershell", "pwsh", "sudo", "C:\\x\\run.bat", "a.CMD", "-rf", ""]) {
      await assert.rejects(execRun({ program, args: ["-c", "id"], cwd: sub }, m.deps), (e: unknown) => e instanceof ExecFailure && (e.code === "program-refused" || e.code === "invalid-input"), program);
    }
    assert.equal(m.port.spawned.length, 0);
  });
  it("passes metacharacters through as literal array elements", async () => {
    const { root, sub } = tmpRoot();
    const m = mk({ root });
    const args = ["; rm -rf /", "$(id)", "`id`", "a && b", "x | y", "--opt=a b", "*", "'q'", "\"d\"", "\n"];
    const r = await run(m, { program: "git", args, cwd: sub });
    assert.deepEqual(m.port.spawned[0]!.spec.args, args);
    assert.equal(r.exitCode, 0);
  });
  it("refuses a NUL in an argument, non-string arguments and a non-array args", async () => {
    const { root, sub } = tmpRoot();
    const m = mk({ root });
    await fails(execRun({ program: "git", args: ["a\0b"], cwd: sub }, m.deps), "invalid-input");
    await fails(execRun({ program: "git", args: [1 as never], cwd: sub }, m.deps), "invalid-input");
    await fails(execRun({ program: "git", args: "status -s" as never, cwd: sub }, m.deps), "invalid-input");
    assert.equal(m.port.spawned.length, 0);
  });
  it("allowlist: an unlisted program, a path spelling of a bare entry and an argument outside argPattern are refused", async () => {
    const { root, sub } = tmpRoot();
    const m = mk({ root, allowlist: [{ program: "git", argPattern: "^[a-z-]+$" }] });
    await fails(execRun({ program: "curl", cwd: sub }, m.deps), "not-allowlisted");
    await fails(execRun({ program: "/tmp/evil/git", cwd: sub }, m.deps), "not-allowlisted");
    await fails(execRun({ program: "git", args: ["status", "; id"], cwd: sub }, m.deps), "not-allowlisted");
    await run(m, { program: "git", args: ["status"], cwd: sub });
    assert.equal(m.port.spawned.length, 1);
  });
});

describe("exec.run: working directory", () => {
  it("must be an existing directory inside a root", async () => {
    const { root, sub } = tmpRoot();
    const other = tmpRoot();
    const m = mk({ root });
    await fails(execRun({ program: "git", cwd: other.sub }, m.deps), "cwd-refused");
    await fails(execRun({ program: "git", cwd: `${sub}/../..` }, m.deps), "cwd-refused");
    await fails(execRun({ program: "git", cwd: `${sub}/missing` }, m.deps), "cwd-refused");
    await fails(execRun({ program: "git", cwd: "relative" }, m.deps), "cwd-refused");
    assert.equal(m.port.spawned.length, 0);
    await run(m, { program: "git", cwd: sub });
    assert.equal(m.port.spawned[0]!.spec.cwd, sub);
  });
});

describe("exec.run: environment", () => {
  it("does not inherit secrets: only allowlisted names reach the child", async () => {
    const { root, sub } = tmpRoot();
    const m = mk({ root });
    await run(m, { program: "git", cwd: sub });
    assert.deepEqual(m.port.spawned[0]!.spec.env, { PATH: "/usr/bin" });
  });
  it("a secret-looking name is not inherited even when allowlisted, and requested names must be allowlisted", async () => {
    const { root, sub } = tmpRoot();
    const m = mk({ root, envAllow: ["PATH", "API_TOKEN", "GIT_AUTHOR_NAME"] });
    await run(m, { program: "git", cwd: sub, env: { GIT_AUTHOR_NAME: "Ann" } });
    assert.deepEqual(m.port.spawned[0]!.spec.env, { PATH: "/usr/bin", GIT_AUTHOR_NAME: "Ann" });
    await fails(execRun({ program: "git", cwd: sub, env: { AWS_SECRET_ACCESS_KEY: "x" } }, m.deps), "env-refused");
    await fails(execRun({ program: "git", cwd: sub, env: { "BAD=NAME": "x" } }, m.deps), "env-refused");
    await fails(execRun({ program: "git", cwd: sub, env: { GIT_AUTHOR_NAME: "a\0b" } }, m.deps), "env-refused");
  });
  it("Windows names are case-insensitive", () => {
    assert.deepEqual(buildEnv({ allow: DEFAULT_ENV_ALLOW, base: { Path: "C:\\x", systemroot: "C:\\Windows", Token: "t" }, windows: true }), { Path: "C:\\x", systemroot: "C:\\Windows" });
  });
  it("audit lines carry env names, never values or argument text", async () => {
    const { root, sub } = tmpRoot();
    const m = mk({ root, envAllow: ["PATH", "GIT_AUTHOR_NAME"] });
    await run(m, { program: "git", args: ["--password=hunter2"], cwd: sub, env: { GIT_AUTHOR_NAME: "Ann" } });
    const text = JSON.stringify(m.audit.events);
    assert.ok(!text.includes("hunter2") && !text.includes("Ann") && !text.includes("t0ps3cret"));
    assert.ok(text.includes("GIT_AUTHOR_NAME"));
  });
});

describe("exec.run: timeout, abort, tree cleanup", () => {
  it("kills the process tree when the timeout fires and reports timedOut", async () => {
    const { root, sub } = tmpRoot();
    const m = mk({ root });
    m.port.onSpawn = () => { m.timers.advance(5_000); };
    const r = await execRun({ program: "git", cwd: sub, timeoutMs: 5_000 }, m.deps);
    assert.equal(r.timedOut, true);
    assert.equal(r.signal, "SIGKILL");
    assert.ok(m.port.spawned[0]!.kills >= 1);
    assert.equal(m.audit.events.at(-1)!.detail.outcome, "timeout");
  });
  it("clamps the timeout to the maximum and ignores the timer when the process ends first", async () => {
    const { root, sub } = tmpRoot();
    const m = mk({ root, maxTimeoutMs: 1_000 });
    const r = await run(m, { program: "git", cwd: sub, timeoutMs: 9_999_999 }, (p) => { m.timers.advance(999); p.exit(0); });
    assert.equal(r.timedOut, false);
    assert.equal(m.port.spawned[0]!.kills, 0);
    await fails(execRun({ program: "git", cwd: sub, timeoutMs: 0 }, m.deps), "invalid-input");
  });
  it("an abort signal ends the tree", async () => {
    const { root, sub } = tmpRoot();
    const m = mk({ root });
    const ac = new AbortController();
    m.port.onSpawn = () => ac.abort();
    const r = await execRun({ program: "git", cwd: sub }, m.deps, ac.signal);
    assert.equal(r.aborted, true);
    assert.ok(m.port.spawned[0]!.kills >= 1);
  });
  it("a spawn failure becomes spawn-failed and the tree is cleaned", async () => {
    const { root, sub } = tmpRoot();
    const m = mk({ root });
    m.port.onSpawn = (p) => p.fail(new Error("ENOENT"));
    await fails(execRun({ program: "git", cwd: sub }, m.deps), "spawn-failed");
    assert.ok(m.port.spawned[0]!.kills >= 1);
  });
});

describe("exec.run: output limit", () => {
  it("keeps the first maxOutputBytes per stream and flags the cut", async () => {
    const { root, sub } = tmpRoot();
    const m = mk({ root });
    const r = await run(m, { program: "git", cwd: sub, maxOutputBytes: 100 }, (p) => {
      p.stdout("a".repeat(60)); p.stdout("b".repeat(60)); p.stdout("c".repeat(5_000)); p.stderr("e".repeat(10)); p.exit(0);
    });
    assert.equal(r.stdout.length, 100);
    assert.equal(r.stdout, "a".repeat(60) + "b".repeat(40));
    assert.equal(r.stdoutTruncated, true);
    assert.equal(r.stderr, "e".repeat(10));
    assert.equal(r.stderrTruncated, false);
  });
  it("a limit that cuts a multi-byte character yields replacement text, not an error", async () => {
    const { root, sub } = tmpRoot();
    const m = mk({ root });
    const r = await run(m, { program: "git", cwd: sub, maxOutputBytes: 4 }, (p) => { p.stdout("ab€"); p.exit(0); });
    assert.equal(r.stdoutTruncated, true);
    assert.ok(r.stdout.startsWith("ab"));
  });
});

describe("exec.run: policy, approval, audit", () => {
  it("ask tier: asks the person; approval runs it, refusal and a missing port do not", async () => {
    const { root, sub } = tmpRoot();
    const yes = mk({ root, mode: "ask" });
    await run(yes, { program: "git", cwd: sub });
    assert.equal(yes.asked.length, 1);
    assert.equal(yes.audit.events[0]!.detail.via, "approval");
    const no = mk({ root, mode: "ask" }, { approvals: { request: async () => ({ approved: false }) } });
    await fails(execRun({ program: "git", cwd: sub }, no.deps), "approval-denied");
    const none = mk({ root, mode: "ask" }, { approvals: undefined as never });
    await fails(execRun({ program: "git", cwd: sub }, none.deps), "approval-denied");
    assert.equal(no.port.spawned.length + none.port.spawned.length, 0);
  });
  it("ask tier: a throwing approval port is a refusal; a headless run parks and so refuses", async () => {
    const { root, sub } = tmpRoot();
    const boom = mk({ root, mode: "ask" }, { approvals: { request: async () => { throw new Error("x"); } } });
    await fails(execRun({ program: "git", cwd: sub }, boom.deps), "approval-denied");
    const base = mk({ root, mode: "ask" });
    const headless = mk({ root, mode: "ask" }, { policyContext: { ...base.deps.policyContext, headless: { jobId: "j" } } });
    await fails(execRun({ program: "git", cwd: sub }, headless.deps), "approval-denied");
    assert.equal(headless.asked.length, 0);
  });
  it("policy deny (tools.deny, sub-agent without scope) wins over the allowlist", async () => {
    const { root, sub } = tmpRoot();
    const base = mk({ root });
    const denied = mk({ root }, { policyContext: { ...base.deps.policyContext, toolsDeny: ["shell.*"] } });
    await fails(execRun({ program: "git", cwd: sub }, denied.deps), "policy-denied");
    const sub2 = mk({ root }, { policyContext: { ...base.deps.policyContext, subject: { kind: "subagent", agentId: "s" } } });
    await fails(execRun({ program: "git", cwd: sub }, sub2.deps), "policy-denied");
    assert.equal(denied.port.spawned.length + sub2.port.spawned.length, 0);
  });
  it("writes the decision line before spawning and a result line after; no run when the audit sink fails", async () => {
    const { root, sub } = tmpRoot();
    const m = mk({ root });
    let seenBeforeSpawn = 0;
    m.port.onSpawn = (p) => { seenBeforeSpawn = m.audit.events.length; p.exit(3); };
    const r = await execRun({ program: "git", cwd: sub }, m.deps);
    assert.equal(seenBeforeSpawn, 1);
    assert.deepEqual(m.audit.events.map((e) => e.action), ["exec.run", "exec.result"]);
    assert.equal(r.exitCode, 3);
    assert.equal(m.audit.events[1]!.detail.exitCode, 3);
    const broken = mk({ root }, { audit: { append() { throw new Error("disk full"); } } });
    await fails(execRun({ program: "git", cwd: sub }, broken.deps), "audit-failed");
    assert.equal(broken.port.spawned.length, 0);
  });
});

describe("exec.run tool spec", () => {
  it("returns failures as results, rejects unknown properties and non-objects", async () => {
    const { root, sub } = tmpRoot();
    const m = mk({ root, mode: "deny" });
    const tool = createExecTool(m.deps);
    assert.equal(tool.name, "exec.run");
    assert.deepEqual(await tool.execute({ program: "git", cwd: sub }), { isError: true, code: "disabled", message: "exec.run is disabled (mode: deny)" });
    assert.equal(((await tool.execute({ program: "git", cwd: sub, shell: true })) as { code: string }).code, "invalid-input");
    assert.equal(((await tool.execute("git status")) as { code: string }).code, "invalid-input");
    const live = mk({ root });
    live.port.onSpawn = (p) => { p.stdout("hi"); p.exit(0); };
    const ok = (await createExecTool(live.deps).execute({ program: "git", cwd: sub })) as { isError: boolean; value: { stdout: string } };
    assert.equal(ok.isError, false);
    assert.equal(ok.value.stdout, "hi");
  });
});
