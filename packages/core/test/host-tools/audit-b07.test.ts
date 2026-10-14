import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createNodeExec, runHostTool, systemClock, type ExecResult, type HostExec, type HostOutcome } from "../../src/host-tools/index.ts";
import { makeCtx, ok, FakeExec, platformScripts } from "./helpers.ts";

/** makeCtx only honours FakeExec instances, so wrap through a subclass. */
class WrapExec extends FakeExec {
  private readonly inner: HostExec;
  constructor(inner: HostExec) { super([]); this.inner = inner; }
  override run(req: Parameters<HostExec["run"]>[0], signal?: AbortSignal): Promise<ExecResult> { return this.inner.run(req, signal); }
}

const code = (r: HostOutcome): string => (r.isError ? r.error.code : "ok");

describe("b07 audit: apps.open", () => {
  it("applies the scheme allowlist regardless of an explicit kind", async () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      for (const kind of ["file", "app"] as const) {
        for (const target of ["ssh://host", "vnc://host", "smb://host/share", "file:///etc/passwd", "x-apple.systempreferences:com.apple.x"]) {
          const { ctx, exec } = makeCtx(platform);
          const r = await runHostTool("apps.open", { target, kind }, ctx);
          assert.equal(code(r), "denied_by_denylist", `${platform} ${kind} ${target}`);
          assert.equal(exec.calls.length, 0);
        }
      }
    }
  });

  it("rejects an unknown kind and targets that look like options", async () => {
    const { ctx, exec } = makeCtx("darwin");
    assert.equal(code(await runHostTool("apps.open", { target: "https://a.example", kind: "bogus" }, ctx)), "invalid_input");
    assert.equal(code(await runHostTool("apps.open", { target: "-a Terminal", kind: "file" }, ctx)), "invalid_input");
    assert.equal(code(await runHostTool("apps.open", { target: "--args", kind: "app" }, ctx)), "invalid_input");
    assert.equal(exec.calls.length, 0);
  });

  it("does not mistake a Windows drive letter for a URL scheme", async () => {
    const { ctx, exec } = makeCtx("win32");
    const r = await runHostTool("apps.open", { target: "C:\\Users\\alice\\notes.txt" }, ctx);
    assert.equal(r.isError, false);
    assert.equal(exec.calls.at(-1)?.program, "explorer.exe");
  });

  it("matches the deny-list after collapsing dot segments and expanding ~", async () => {
    const { ctx, exec } = makeCtx("darwin");
    for (const target of [
      "/Users/alice/Documents/../.aws/config",
      "/Users/alice/./Library/./Keychains/login.keychain-db",
      "/Users/alice/Documents/../../alice/.config/gh/hosts.yml",
      "~/.config/gh/hosts.yml",
      "~/.aws/config",
    ]) {
      assert.equal(code(await runHostTool("apps.open", { target, kind: "file" }, ctx)), "denied_by_denylist", target);
    }
    assert.equal(exec.calls.length, 0);
  });

  it("reports a failing opener instead of claiming success", async () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const { ctx } = makeCtx(platform, { exec: new FakeExec([], undefined) });
      const r = await runHostTool("apps.open", { target: "https://a.example", kind: "url" }, ctx);
      assert.equal(r.isError, true, platform);
    }
  });

  it("KNOWN GAP: apps.open can launch executables but is registered as sys.read/low (auto-allowed)", { todo: "needs an approval-class capability (e.g. shell.exec) plus an update of composition/tools.test.ts and catalog.test.ts pins" }, async () => {
    const { getHostTool } = await import("../../src/host-tools/index.ts");
    assert.notEqual(getHostTool("apps.open")!.capability, "sys.read");
  });
});

describe("b07 audit: clipboard and notify", () => {
  it("clipboard.write and notify fail when the backend exits non-zero", async () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const failing = new FakeExec(platformScripts(platform).map((s) => ({ ...s, exitCode: 1 })), undefined);
      const { ctx } = makeCtx(platform, { exec: failing });
      assert.equal((await runHostTool("clipboard.write", { text: "x" }, ctx)).isError, true, `write ${platform}`);
      assert.equal((await runHostTool("notify", { title: "t" }, ctx)).isError, true, `notify ${platform}`);
    }
  });

  it("clipboard.read refuses a truncated capture instead of returning a prefix", async () => {
    const base = new FakeExec(platformScripts("darwin"));
    const exec = new WrapExec({
      async run(req, signal) {
        const r = await base.run(req, signal);
        return req.program === "pbpaste" ? { ...r, stdout: "a".repeat(65536), truncated: true } : r;
      },
    });
    const { ctx } = makeCtx("darwin", { exec });
    assert.equal(code(await runHostTool("clipboard.read", {}, ctx)), "too_large");
  });

  it("notify-send receives title and body after an end-of-options marker", async () => {
    const { ctx, exec } = makeCtx("linux");
    ok(await runHostTool("notify", { title: "--icon=/etc/passwd", body: "-u critical" }, ctx));
    const call = exec.calls.find((c) => c.program === "notify-send")!;
    assert.deepEqual(call.args, ["--", "--icon=/etc/passwd", "-u critical"]);
  });

  it("windows notify escapes PowerShell typographic double quotes", async () => {
    const { ctx, exec } = makeCtx("win32");
    ok(await runHostTool("notify", { title: "a\u201D; calc; \u201Cb", body: "x\u201Ey" }, ctx));
    const cmd = exec.calls.find((c) => c.program === "powershell")!.args.at(-1)!;
    assert.ok(!/(?<!`)[\u201C\u201D\u201E]/.test(cmd), "unescaped typographic quote reaches PowerShell");
  });
});

describe("b07 audit: exec and error surface", () => {
  it("a child that exits without reading stdin does not crash the process", async () => {
    const exec = createNodeExec(systemClock);
    const r = await exec.run({ program: process.execPath, args: ["-e", "process.exit(0)"], stdin: "x".repeat(8 * 1024 * 1024) });
    assert.equal((r as ExecResult).exitCode, 0);
  });

  it("raw spawn errors do not leak program paths or classify as invalid_input", async () => {
    const exec = createNodeExec(systemClock);
    const { ctx } = makeCtx("linux", { exec: new WrapExec({ run: (req, s) => exec.run({ ...req, program: "/home/alice/.ssh/nope-bin" }, s) }) });
    const r = await runHostTool("clipboard.read", {}, ctx);
    assert.equal(r.isError, true);
    if (r.isError) {
      assert.ok(!r.error.message.includes("/home/alice"), r.error.message);
      assert.notEqual(r.error.code, "invalid_input");
    }
  });

  it("an unexpected exception is reported generically", async () => {
    const boom = new WrapExec({ run: async () => { throw new Error("EACCES: open '/Users/alice/.aws/credentials'"); } });
    const { ctx } = makeCtx("darwin", { exec: boom });
    const r = await runHostTool("proc.list", {}, ctx);
    assert.equal(r.isError, true);
    if (r.isError) assert.ok(!r.error.message.includes(".aws"), r.error.message);
  });
});

describe("b07 audit: proc truncation", () => {
  it("proc.kill and proc.list fail closed when the process table was truncated", async () => {
    const base = new FakeExec(platformScripts("linux"));
    const exec = new WrapExec({
      async run(req, signal) {
        const r = await base.run(req, signal);
        return req.program === "ps" ? { ...r, truncated: true } : r;
      },
    });
    const { ctx } = makeCtx("linux", { exec });
    assert.equal(code(await runHostTool("proc.list", {}, ctx)), "too_large");
    assert.equal(code(await runHostTool("proc.kill", { pid: 900 }, ctx)), "too_large");
    assert.equal(base.calls.some((c) => c.program === "kill"), false);
  });
});
