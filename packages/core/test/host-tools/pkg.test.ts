import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runHostTool } from "../../src/host-tools/index.ts";
import { makeCtx, ok } from "./helpers.ts";

describe("pkg.*", () => {
  it("detects brew on macOS, winget on Windows, apt on Linux", async () => {
    const mac = ok<{ managers: string[] }>(await runHostTool("pkg.detect", {}, makeCtx("darwin").ctx));
    assert.ok(mac.managers.includes("brew"));
    const win = ok<{ managers: string[] }>(await runHostTool("pkg.detect", {}, makeCtx("win32").ctx));
    assert.ok(win.managers.includes("winget"));
    const lin = ok<{ managers: string[] }>(await runHostTool("pkg.detect", {}, makeCtx("linux").ctx));
    assert.ok(lin.managers.includes("apt"));
  });

  it("search, list-installed and info are read-only execs", async () => {
    const { ctx, exec } = makeCtx("darwin");
    const search = ok<{ results: Array<{ name: string }> }>(await runHostTool("pkg.search", { query: "ripgrep" }, ctx));
    assert.ok(search.results.some((r) => r.name.includes("ripgrep") || r.name === "rg"));
    const list = ok<{ packages: Array<{ name: string; version?: string }> }>(await runHostTool("pkg.list-installed", {}, ctx));
    assert.ok(list.packages.some((p) => p.name === "ripgrep"));
    const info = ok<{ name: string }>(await runHostTool("pkg.info", { name: "ripgrep" }, ctx));
    assert.match(info.name, /ripgrep/i);
    assert.ok(exec.calls.every((c) => !/install|uninstall|remove|upgrade/i.test(c.args.join(" "))));
  });

  it("install and remove return a plan and never execute it", async () => {
    const { ctx, exec } = makeCtx("darwin");
    exec.calls.length = 0;
    const ins = ok<{ plan: { program: string; args: string[]; riskClass: string; capability: string } }>(
      await runHostTool("pkg.install", { name: "ripgrep" }, ctx),
    );
    assert.equal(ins.plan.program, "brew");
    assert.deepEqual(ins.plan.args, ["install", "ripgrep"]);
    assert.equal(ins.plan.riskClass, "high");
    assert.equal(ins.plan.capability, "pkg.change");
    const rm = ok<{ plan: { program: string; args: string[] } }>(await runHostTool("pkg.remove", { name: "ripgrep" }, ctx));
    assert.equal(rm.plan.program, "brew");
    assert.ok(rm.plan.args.includes("ripgrep"));
    assert.ok(!rm.plan.args.includes("install"));
    assert.ok(exec.calls.every((c) => c.args[0] !== "install" && c.args[0] !== "uninstall" && c.args[0] !== "remove"));
  });
});
