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
  it("silences PowerShell's own progress stream before anything can report progress", () => {
    // The server inherits the launcher's stderr, so a progress record (Windows PowerShell's first-run "Preparing modules
    // for first use.", serialised as #< CLIXML) would arrive as the server's own stderr lines (mcp/stderr-d111).
    const script = Buffer.from(windowsJobCommand("C:\\node.exe", [], {}).args.at(-1)!, "base64").toString("utf16le");
    assert.ok(script.startsWith("$ProgressPreference='SilentlyContinue';"), script.slice(0, 80));
  });
});

// Audit mcp (suspected): CreateProcess searches the current directory before PATH for a bare name, so a `node.exe` planted
// in a writable `cwd` would win over the real one. The command is resolved over PATH, never over the cwd, before the launcher
// sees it. The lookup is injected, so this runs on every OS.
describe("windows command resolution (no cwd planting)", () => {
  const commandLine = (l: { args: string[] }): string => {
    const script = Buffer.from(l.args.at(-1)!, "base64").toString("utf16le");
    const m = /\$command=\[Text\.Encoding\]::UTF8\.GetString\(\[Convert\]::FromBase64String\('([^']*)'\)\)/.exec(script);
    assert.ok(m, "the script reads a command line");
    return Buffer.from(m[1]!, "base64").toString("utf8");
  };
  const lookup = (present: string[]) => { const seen: string[] = []; return { seen, exists: (p: string) => { seen.push(p); return present.includes(p); } }; };
  const host = { Path: "C:\\Tools;C:\\Program Files\\nodejs", SystemRoot: "C:\\Windows" };

  it("launches a bare command by the absolute path found on PATH, not by its bare name", () => {
    const fs = lookup(["C:\\Program Files\\nodejs\\node.exe"]);
    const l = windowsJobCommand("node", ["server.js"], host, [], fs.exists);
    assert.equal(commandLine(l), '"C:\\Program Files\\nodejs\\node.exe" "server.js"');
    assert.deepEqual(fs.seen, ["C:\\Tools\\node.exe", "C:\\Program Files\\nodejs\\node.exe"], "PATH order, first hit wins");
  });
  it("never looks in the working directory, even through relative or empty PATH entries", () => {
    const fs = lookup(["C:\\work\\node.exe", ".\\node.exe", "node.exe", "C:\\Real\\node.exe"]);
    const l = windowsJobCommand("node", [], { PATH: ";.;..\\bin;C:\\Real", SystemRoot: "C:\\Windows" }, [], fs.exists);
    assert.equal(commandLine(l), '"C:\\Real\\node.exe"');
    assert.deepEqual(fs.seen, ["C:\\Real\\node.exe"], "only absolute PATH entries are probed");
  });
  it("fails closed when the command is not on PATH, rather than leaving the search to CreateProcess", () => {
    const fs = lookup(["C:\\work\\node.exe"]);
    assert.throws(() => windowsJobCommand("node", [], host, [], fs.exists), /not found on PATH/);
    assert.throws(() => windowsJobCommand("node", [], {}, [], fs.exists), /not found on PATH/);
  });
  it("passes an absolute path through, and a bare name with .exe is resolved the same way", () => {
    const fs = lookup(["C:\\Tools\\server.exe"]);
    assert.equal(commandLine(windowsJobCommand("C:\\Tools\\server.exe", ["a b"], host, [], () => false)), '"C:\\Tools\\server.exe" "a b"');
    assert.equal(commandLine(windowsJobCommand("server.exe", [], host, [], fs.exists)), '"C:\\Tools\\server.exe"');
  });
  it("refuses a relative path with a separator (it would resolve against the cwd)", () => {
    assert.throws(() => windowsJobCommand("bin\\node.exe", [], host, [], () => true), /absolute path or a bare/);
    assert.throws(() => windowsJobCommand(".\\node.exe", [], host, [], () => true), /absolute path or a bare/);
  });
  it("still refuses scripts and batch files", () => {
    assert.throws(() => windowsJobCommand("run.cmd", [], host, [], () => true), /native executable/);
  });
});
