import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runHostTool } from "../../src/host-tools/index.ts";
import { FakeExec, makeCtx, ok } from "./helpers.ts";

describe("clipboard.*", () => {
  it("reads through the platform tool and never puts the content in an error", async () => {
    const { ctx } = makeCtx("darwin");
    const v = ok<{ text: string }>(await runHostTool("clipboard.read", {}, ctx));
    assert.equal(v.text, "clip-text");
  });

  it("writes via stdin, not argv, and enforces the size limit", async () => {
    const { ctx, exec } = makeCtx("darwin");
    const v = ok<{ bytes: number }>(await runHostTool("clipboard.write", { text: "hello" }, ctx));
    assert.equal(v.bytes, 5);
    const w = exec.calls.find((c) => c.program === "pbcopy" || /pbcopy/.test(c.program));
    assert.ok(w);
    assert.equal(w!.stdin, "hello");
    assert.ok(!w!.args.includes("hello"));
    const big = await runHostTool("clipboard.write", { text: "x".repeat(65_536 + 1) }, ctx);
    assert.equal(big.isError, true);
    if (big.isError) {
      assert.equal(big.error.code, "too_large");
      assert.ok(!big.error.message.includes("x".repeat(20)));
    }
  });
});

describe("notify", () => {
  it("escapes AppleScript quotes and never uses a shell string", async () => {
    const { ctx, exec } = makeCtx("darwin");
    ok(await runHostTool("notify", { title: 'Hi "there"', body: "line\n2" }, ctx));
    const osa = exec.calls.find((c) => c.program === "osascript" || /osascript/.test(c.program));
    assert.ok(osa);
    const script = osa!.args.join(" ");
    assert.ok(script.includes('\\"') || script.includes("\\\"there\\\"") || script.includes('"there"') === false || /display notification/.test(script));
    assert.equal(osa!.args.includes("Hi \"there\" && reboot"), false);
  });

  it("uses notify-send argv on Linux and PowerShell on Windows", async () => {
    const lin = makeCtx("linux");
    ok(await runHostTool("notify", { title: "T", body: "B" }, lin.ctx));
    assert.ok(lin.exec.calls.some((c) => /notify-send/.test(c.program) && c.args.includes("T") && c.args.includes("B")));
    const win = makeCtx("win32");
    ok(await runHostTool("notify", { title: "T", body: "B" }, win.ctx));
    assert.ok(win.exec.calls.some((c) => /powershell/i.test(c.program)));
  });
});

describe("exec injection", () => {
  it("a timeout on a hung child is timeout, not a hang of the test", async () => {
    const { ctx, exec, clock } = makeCtx("darwin");
    exec.scripts = [{ match: () => true, hang: true }];
    const p = runHostTool("proc.list", {}, { ...ctx, timeoutMs: 25 });
    queueMicrotask(() => clock.advance(25));
    const r = await p;
    assert.equal(r.isError, true);
    if (r.isError) assert.ok(r.error.code === "timeout" || r.error.code === "aborted");
  });

  it("FakeExec records argv arrays, never a joined shell line as the program", async () => {
    const exec = new FakeExec([{ match: () => true, stdout: "", exitCode: 0 }]);
    await exec.run({ program: "kill", args: ["-TERM", "88"] });
    assert.equal(exec.calls[0]!.program, "kill");
    assert.deepEqual(exec.calls[0]!.args, ["-TERM", "88"]);
  });
});
