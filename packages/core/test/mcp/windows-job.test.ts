// The Windows launcher: Windows PowerShell does not start under the server's minimal allowlisted environment, so the
// launcher runs under the host's and strips everything the server did not declare. Pure functions: every OS runs this.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { windowsJobCommand, windowsLauncherEnv } from "../../src/mcp/windows-job.ts";

describe("windows launcher environment", () => {
  it("overlays the declared environment on the host's, and the declared value wins whatever the case", () => {
    const base = { Path: "host-path", PSModulePath: "host-mods", windir: "C:\\Windows", HOSTONLY: "1" };
    const env = { PATH: "child-path", SYSTEMROOT: "C:\\Windows" };
    const out = windowsLauncherEnv(env, base);
    assert.deepEqual(out, { PSModulePath: "host-mods", windir: "C:\\Windows", HOSTONLY: "1", PATH: "child-path", SYSTEMROOT: "C:\\Windows" });
    assert.equal(Object.keys(out).filter((k) => k.toLowerCase() === "path").length, 1, "no duplicate under another case");
  });
  it("tells the launcher script which variables to keep", () => {
    const l = windowsJobCommand("C:\\node.exe", ["x.js"], {}, ["PATH", "FIXTURE_WEDGE"]);
    const script = Buffer.from(l.args.at(-1)!, "base64").toString("utf16le");
    const m = /\$keep=\[Text\.Encoding\]::UTF8\.GetString\(\[Convert\]::FromBase64String\('([^']*)'\)\)/.exec(script);
    assert.ok(m, "the script reads a keep list");
    assert.equal(Buffer.from(m[1]!, "base64").toString("utf8"), "PATH\nFIXTURE_WEDGE");
    assert.ok(script.indexOf("SetEnvironmentVariable") < script.indexOf("[McpJob]::Run"), "the strip happens before the server starts");
  });
});
