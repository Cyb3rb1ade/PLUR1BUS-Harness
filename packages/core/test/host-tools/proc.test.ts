import { createSecretRedaction } from "../../src/secrets/redaction.ts";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runHostTool } from "../../src/host-tools/index.ts";
import { makeCtx, ok, platformScripts } from "./helpers.ts";

describe("proc.*", () => {
  it("list returns pid, name, user, cpu, mem and redacts secret args", async () => {
    const { ctx } = makeCtx("darwin");
    const v = ok<{ processes: Array<{ pid: number; name: string; user: string; cpu: number; mem: number; command?: string }> }>(
      await runHostTool("proc.list", {}, ctx),
    );
    const safari = v.processes.find((p) => p.pid === 88);
    assert.ok(safari);
    assert.equal(safari!.user, "alice");
    assert.equal(safari!.name, "Safari");
    const node = v.processes.find((p) => p.pid === 424);
    assert.ok(node);
    assert.ok(!String(node!.command ?? "").includes("sk-live"));
    assert.ok(!String(node!.command ?? "").includes(".ssh"));
  });

  it("info looks up a pid and not_found for a missing one", async () => {
    const { ctx } = makeCtx("linux");
    const v = ok<{ pid: number; name: string; user: string }>(await runHostTool("proc.info", { pid: 900 }, ctx));
    assert.equal(v.pid, 900);
    assert.match(v.name, /firefox/i);
    const miss = await runHostTool("proc.info", { pid: 40404 }, ctx);
    assert.equal(miss.isError, true);
    if (miss.isError) assert.equal(miss.error.code, "not_found");
  });

  it("kill refuses pid 1, the harness tree and another user's process", async () => {
    const { ctx, exec } = makeCtx("darwin");
    for (const pid of [1, 400, 424]) {
      const r = await runHostTool("proc.kill", { pid }, ctx);
      assert.equal(r.isError, true, `pid ${pid}`);
      if (r.isError) assert.equal(r.error.code, "permission_denied", `pid ${pid}`);
    }
    const other = await runHostTool("proc.kill", { pid: 512 }, ctx);
    assert.equal(other.isError, true);
    if (other.isError) assert.equal(other.error.code, "permission_denied");
    const kills = exec.calls.filter((c) => /kill|taskkill/i.test(c.program));
    assert.equal(kills.length, 0);
  });

  for (const platform of ["darwin", "linux", "win32"] as const) {
    it(`uses the report redactor only on visible process tables (${platform})`, async () => {
      const { ctx, exec } = makeCtx(platform);
      const registry = createSecretRedaction();
      registry.register("42424242");
      ctx.knownSecrets = () => registry.snapshot();
      const reads: Array<{ program: string; protectedOutput: boolean }> = [];
      ctx.exec = { async run(req, signal, knownSecrets) {
        reads.push({ program: req.program, protectedOutput: knownSecrets === ctx.knownSecrets });
        const result = await exec.run(req, signal);
        result.stdout = result.stdout.replaceAll("424", "42424242");
        if (knownSecrets) result.stdout = knownSecrets().matcher.maskText(result.stdout);
        return result;
      } };
      const programs = platform === "win32" ? ["tasklist", "wmic"] : ["ps"];
      const report = ok<{ processes: Array<{ pid: number }> }>(await runHostTool("proc.list", {}, ctx));
      assert.ok(report.processes.some(row => row.pid === 400));
      assert.ok(report.processes.every(row => row.pid !== 42424242));
      assert.deepEqual(reads.splice(0), programs.map(program => ({ program, protectedOutput: true })));
      for (const [name, args, code] of [
        ["proc.kill", { pid: 42424242 }, "permission_denied"],
        ["proc.wait", { pid: 42424242, timeoutMs: 10 }, "timeout"],
      ] as const) {
        const result = await runHostTool(name, args, ctx);
        assert.ok(result.isError);
        assert.equal(result.error.code, code);
        const identityReads = reads.splice(0);
        assert.deepEqual([...new Set(identityReads.map(read => read.program))], programs);
        assert.ok(identityReads.every(read => !read.protectedOutput));
      }
    });
  }

  it("kill of a foreign same-user process sends a fixed argv, never a shell string", async () => {
    const { ctx, exec } = makeCtx("darwin");
    const r = await runHostTool("proc.kill", { pid: 88, signal: "TERM" }, ctx);
    assert.equal(r.isError, false, r.isError ? JSON.stringify(r.error) : "");
    const kill = exec.calls.find((c) => c.program === "kill" || /kill/.test(c.program));
    assert.ok(kill);
    assert.deepEqual(kill!.args, ["-TERM", "88"]);
  });

  it("wait returns running then timed out when the pid stays alive", async () => {
    const { ctx } = makeCtx("linux", { timeoutMs: 50 });
    const r = await runHostTool("proc.wait", { pid: 900, timeoutMs: 10 }, ctx);
    assert.equal(r.isError, true);
    if (r.isError) assert.equal(r.error.code, "timeout");
  });

  it("wait succeeds when a later poll shows the pid gone", async () => {
    const { ctx, exec } = makeCtx("linux");
    let n = 0;
    exec.scripts = [
      ...platformScripts("linux").filter((s) => !s.match({ program: "ps", args: [] })),
      {
        match: (c) => c.program === "ps" || /ps$/.test(c.program),
        get stdout() {
          n += 1;
          return n < 2 ? "  900     1 alice     1.1  3.2 /usr/lib/firefox/firefox\n" : "";
        },
      },
    ];
    const v = ok<{ pid: number; exited: boolean }>(await runHostTool("proc.wait", { pid: 900, timeoutMs: 1000 }, ctx));
    assert.equal(v.pid, 900);
    assert.equal(v.exited, true);
  });
});
