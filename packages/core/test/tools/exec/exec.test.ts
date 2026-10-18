import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execRun, createExecTool, ExecFailure, buildEnv, DEFAULT_ENV_ALLOW } from "../../../src/tools/exec/index.ts";
import { ctx } from "../../policy/helpers.ts";
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

  it("an already-authorized override path does not record decision/via on exec.run", async () => {
    const { root, sub } = tmpRoot();
    const m = mk({ root }, { policyContext: { ...ctx(), overrides: { "shell.exec": "allowed" } } });
    m.port.onSpawn = (p) => p.exit(0);
    await execRun({ program: "git", cwd: sub }, m.deps);
    const line = m.audit.events.find((e) => e.action === "exec.run")!;
    assert.ok(line);
    assert.equal("decision" in line.detail, false);
    assert.equal("via" in line.detail, false);
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

describe("exec.run: a request cannot steer which program runs", () => {
  it("allowlist tier: PATH (and the other lookup variables) cannot be requested, so `git` stays the allowlisted git", async () => {
    const { root, sub } = tmpRoot();
    const m = mk({ root, envAllow: ["PATH", "PATHEXT", "COMSPEC", "SystemRoot", "GIT_AUTHOR_NAME"] });
    m.port.onSpawn = (p) => p.exit(0);
    for (const name of ["PATH", "PATHEXT", "COMSPEC", "SystemRoot"]) {
      await fails(execRun({ program: "git", cwd: sub, env: { [name]: "/tmp/evil" } }, m.deps), "env-refused");
    }
    assert.equal(m.port.spawned.length, 0);
    await run(m, { program: "git", cwd: sub, env: { GIT_AUTHOR_NAME: "Ann" } });
    assert.equal(m.port.spawned.length, 1);
  });
  it("ask tier: the approved action covers env values, not just names (an approval for PATH=/usr/bin is not one for PATH=/tmp/evil)", async () => {
    const { root, sub } = tmpRoot();
    const m = mk({ root, mode: "ask" });
    m.port.onSpawn = (p) => p.exit(0);
    await run(m, { program: "git", cwd: sub, env: { PATH: "/usr/bin" } });
    await run(m, { program: "git", cwd: sub, env: { PATH: "/tmp/evil" } });
    const hashes = m.audit.events.filter((e) => e.action === "exec.run").map((e) => e.detail.actionHash);
    assert.equal(hashes.length, 2);
    assert.notEqual(hashes[0], hashes[1]);
    assert.ok(!JSON.stringify(m.audit.events).includes("/tmp/evil"), "values stay out of the audit");
  });
  it("Windows spells a program with trailing dots: bash.exe. is bash.exe, x.bat. is a batch script", async () => {
    const { root, sub } = tmpRoot();
    const m = mk({ root, allowlist: [{ program: "bash.exe." }, { program: "x.bat." }, { program: "SUDO.EXE.." }] });
    for (const program of ["bash.exe.", "pwsh.exe..", "x.bat.", "x.cmd..", "SUDO.EXE.."]) {
      await assert.rejects(execRun({ program, cwd: sub }, m.deps), (e: unknown) => e instanceof ExecFailure && e.code === "program-refused", program);
    }
  });
});

describe("exec.run: an aborted call never starts the program", () => {
  it("an already aborted signal spawns nothing and reports aborted", async () => {
    const { root, sub } = tmpRoot();
    const m = mk({ root });
    const ac = new AbortController();
    ac.abort();
    const r = await execRun({ program: "git", cwd: sub }, m.deps, ac.signal);
    assert.equal(r.aborted, true);
    assert.equal(m.port.spawned.length, 0);
  });
  it("an abort while the approval is pending ends the wait; a late approval starts nothing", async () => {
    const { root, sub } = tmpRoot();
    let approve!: (a: { approved: boolean }) => void;
    const m = mk({ root, mode: "ask" }, { approvals: { request: () => new Promise((res) => { approve = res; }) } });
    const ac = new AbortController();
    const p = execRun({ program: "git", cwd: sub }, m.deps, ac.signal);
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    const r = await Promise.race([p, new Promise<"stuck">((res) => setTimeout(() => res("stuck"), 500))]);
    assert.notEqual(r, "stuck", "the call must not wait for the person after it was cancelled");
    approve({ approved: true });
    await new Promise((res) => setTimeout(res, 10));
    assert.equal(m.port.spawned.length, 0);
  });
});

describe("exec.run: foreign output wrapping", () => {
  async function outWriter() {
    const { createWriter } = await import("../../../src/logs/writer.ts");
    const { logsDir } = await import("../../logs/helpers.ts");
    const dir = logsDir();
    const w = createWriter({ dir, role: "core.out", source: { kind: "harness", id: "exec", version: null }, timers: false });
    return { dir, w };
  }
  function rows(dir: string) {
    try { return readFileSync(join(dir, "core.out.log"), "utf8").trim().split("\n").filter(Boolean).map((s) => JSON.parse(s)); }
    catch { return []; }
  }

  it("foreign output is bounded and redacted", async () => {
    const { dir, w } = await outWriter();
    const { root, sub } = tmpRoot();
    const m = mk({ root, envAllow: [...DEFAULT_ENV_ALLOW, "API_TOKEN"] }, { output: w });
    await run(m, { program: "git", cwd: sub, env: { API_TOKEN: "fixture-exec-canary" } }, (p) => {
      p.stdout("leaked fixture-exec-canary on stdout\n");
      p.stdout(`${"x".repeat(5000)}\n`);
      p.stdout("PATH=/usr/bin stays visible\n");
      p.stderr('ERROR: {"level":"fatal","event":"supervisor.child.given_up"}\n');
      p.exit(0);
    });
    const rs = rows(dir);
    const text = JSON.stringify(rs);
    assert.ok(!text.includes("fixture-exec-canary"), text);
    assert.ok(text.includes("/usr/bin"), text);
    const lines = rs.filter((r: { event: string }) => r.event === "process.output.line");
    assert.ok(lines.length >= 3);
    assert.ok(lines.every((r: { level: string; attrs: { untrusted?: boolean } }) => r.level === "info" && r.attrs.untrusted === true));
    const long = lines.find((r: { attrs: { truncated?: boolean; bytes?: number; text: string } }) => r.attrs.truncated === true && (r.attrs.bytes ?? 0) > 4096);
    assert.ok(long);
    assert.ok(Buffer.byteLength(long.attrs.text) <= 4096);
    assert.ok(rs.every((r: { level: string; event: string }) => r.level !== "fatal" && r.event !== "supervisor.child.given_up"));
    w.close();
  });

  it("a partial line is emitted after one idle second and flushed without close", async () => {
    const { dir, w } = await outWriter();
    const { root, sub } = tmpRoot();
    const m = mk({ root }, { output: w });
    m.port.onSpawn = (proc) => { proc.stdout("no-newline-yet"); };
    const p = execRun({ program: "git", cwd: sub }, m.deps);
    while (m.port.spawned.length === 0) await new Promise<void>((r) => setImmediate(r));
    m.timers.advance(999);
    assert.equal(rows(dir).length, 0);
    m.timers.advance(1);
    const mid = rows(dir).filter((r: { event: string }) => r.event === "process.output.line");
    assert.equal(mid.length, 1);
    assert.equal(mid[0]!.attrs.text, "no-newline-yet");
    m.port.spawned[0]!.exit(0);
    await p;
    w.close();
  });
});
