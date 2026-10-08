// The Windows launcher: PowerShell does not start without PSModulePath, but the server's declared environment is an
// allowlist. Pure functions, so this runs on every OS.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { windowsLauncherEnv } from "../../src/mcp/windows-job.ts";

describe("windows launcher environment", () => {
  it("adds PSModulePath for the launcher from the host, and touches nothing else", () => {
    const env = { SYSTEMROOT: "D:\\Win", TEMP: "D:\\t" };
    const out = windowsLauncherEnv({ PSModulePath: "X:\\mods" }, env);
    assert.deepEqual(out, { ...env, PSModulePath: "X:\\mods" });
    assert.equal("PSModulePath" in env, false, "the input is not mutated");
  });
  it("falls back to the standard module paths when the host has none", () => {
    const out = windowsLauncherEnv({}, { SYSTEMROOT: "D:\\Win", PROGRAMFILES: "D:\\PF" });
    assert.match(out.PSModulePath!, /PF.WindowsPowerShell.Modules;.*Win.System32.WindowsPowerShell.v1\.0.Modules$/);
  });
  it("keeps a PSModulePath the definition declared, whatever its case", () => {
    const env = { psmodulepath: "mine" };
    assert.equal(windowsLauncherEnv({ PSModulePath: "host" }, env), env);
  });
});
