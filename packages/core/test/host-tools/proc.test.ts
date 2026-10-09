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
