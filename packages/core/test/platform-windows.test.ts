// securePath on Windows (ruling S11): an icacls grant for the user SID and SYSTEM with inheritance removed. The win32
// branch is reached everywhere through injected `platform`/`execFile`; the last test runs the real icacls on Windows.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlatformCapabilities, platformCapabilities, parseWhoamiSid, systemTool } from "../src/platform.ts";

const SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";
const WHOAMI = `"desktop-p1b\\bernd","${SID}"\r\n`;
const ROOT = "D:\\Win";
const WHOAMI_EXE = "D:\\Win\\System32\\whoami.exe";
const ICACLS_EXE = "D:\\Win\\System32\\icacls.exe";

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "p1b-plat-win-")); const f = join(dir, "t"); writeFileSync(f, "x");
  return f;
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "p1b-plat-win-dir-"));
}

function recorder(fail?: (file: string) => boolean) {
  const calls: Array<[string, readonly string[]]> = [];
  const warnings: Array<[string, Record<string, unknown> | undefined]> = [];
  const execFile = (file: string, args: readonly string[]): string => {
    calls.push([file, args]);
    if (fail?.(file)) throw Object.assign(new Error(`${file} failed`), { status: 5 });
    return file === WHOAMI_EXE ? WHOAMI : "processed 1 file\r\n";
  };
  const logger = { warn: (msg: string, fields?: Record<string, unknown>) => { warnings.push([msg, fields]); } };
  return { calls, warnings, execFile, logger };
}

describe("platform (win32 branch)", () => {
  it("parseWhoamiSid reads the SID column of whoami /user /fo csv /nh", () => {
    assert.equal(parseWhoamiSid(WHOAMI), SID);
    assert.equal(parseWhoamiSid('"NT AUTHORITY\\SYSTEM","S-1-5-18"\n'), "S-1-5-18");
    assert.equal(parseWhoamiSid("no sid here"), null);
  });

  it("the tools run by absolute path under SystemRoot, C:\\Windows without it", () => {
    assert.equal(systemTool("icacls.exe", "D:\\Win"), ICACLS_EXE);
    assert.equal(systemTool("whoami.exe", ""), "C:\\Windows\\System32\\whoami.exe");
  });

  it("securePath grants the user SID and SYSTEM, removes inheritance, and memoises the SID", () => {
    const r = recorder();
    const p = createPlatformCapabilities({ platform: "win32", execFile: r.execFile, logger: r.logger, systemRoot: ROOT });
    const f = tempFile();
    assert.deepEqual(p.securePath(f), { applied: true, mechanism: "acl" });
    assert.deepEqual(p.securePath(f, { mode: 0o700 }), { applied: true, mechanism: "acl" });
    assert.deepEqual(r.calls, [
      [WHOAMI_EXE, ["/user", "/fo", "csv", "/nh"]],
      [ICACLS_EXE, [f, "/inheritance:r", "/grant:r", `*${SID}:(F)`, "*S-1-5-18:(F)"]],
      [ICACLS_EXE, [f, "/inheritance:r", "/grant:r", `*${SID}:(F)`, "*S-1-5-18:(F)"]],
    ]);
    assert.deepEqual(r.warnings, []);
  });

  it("a directory gets an inherited grant, so files created in it later are owner-only (H3-R15)", () => {
    const r = recorder();
    const p = createPlatformCapabilities({ platform: "win32", execFile: r.execFile, logger: r.logger, systemRoot: ROOT });
    const d = tempDir();
    assert.deepEqual(p.securePath(d, { mode: 0o700 }), { applied: true, mechanism: "acl" });
    assert.deepEqual(r.calls[1], [ICACLS_EXE, [d, "/inheritance:r", "/grant:r", `*${SID}:(OI)(CI)(F)`, "*S-1-5-18:(OI)(CI)(F)"]]);
  });

  it("a failing icacls is not applied and logs a warning", () => {
    const r = recorder((file) => file === ICACLS_EXE);
    const p = createPlatformCapabilities({ platform: "win32", execFile: r.execFile, logger: r.logger, systemRoot: ROOT });
    const f = tempFile();
    assert.deepEqual(p.securePath(f), { applied: false, reason: "acl-tool-unavailable" });
    assert.equal(r.warnings.length, 1);
    assert.equal(r.warnings[0]![1]?.reason, "icacls-failed");
    assert.equal(r.warnings[0]![1]?.path, f);
  });

  it("a failed whoami is not applied, never runs icacls, and is not asked again", () => {
    const r = recorder((file) => file === WHOAMI_EXE);
    const p = createPlatformCapabilities({ platform: "win32", execFile: r.execFile, logger: r.logger, systemRoot: ROOT });
    assert.deepEqual(p.securePath(tempFile()), { applied: false, reason: "acl-tool-unavailable" });
    assert.deepEqual(p.securePath(tempFile()), { applied: false, reason: "acl-tool-unavailable" });
    assert.deepEqual(r.calls.map(([file]) => file), [WHOAMI_EXE]);
    assert.equal(r.warnings.length, 2);
    assert.equal(r.warnings[0]![1]?.reason, "icacls-failed");
  });

  it("a missing path or a pipe name is refused before any tool runs", () => {
    const r = recorder();
    const p = createPlatformCapabilities({ platform: "win32", execFile: r.execFile, logger: r.logger, systemRoot: ROOT });
    assert.deepEqual(p.securePath(join(tmpdir(), "p1b-no-such-file-xyz")), { applied: false, reason: "missing" });
    assert.deepEqual(p.securePath("relative/path"), { applied: false, reason: "not-a-filesystem-path" });
    assert.deepEqual(r.calls, []);
  });
});

/** A file's DACL as SDDL through `icacls /save` (UTF-16LE): SIDs and aliases, independent of the display language. */
function savedSddl(target: string): string {
  const saved = join(mkdtempSync(join(tmpdir(), "p1b-acl-")), "acl.txt");
  execFileSync(systemTool("icacls.exe"), [target, "/save", saved], { stdio: "ignore" });
  return readFileSync(saved).toString("utf16le").replace(/^\uFEFF/, "");
}

describe("platform (Windows host)", () => {
  it("securePath applies an icacls grant on Windows", { skip: process.platform !== "win32" }, () => {
    const f = tempFile();
    assert.deepEqual(platformCapabilities.securePath(f), { applied: true, mechanism: "acl" });
    const sid = parseWhoamiSid(execFileSync(systemTool("whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" }));
    assert.ok(sid, "whoami named no SID");
    const sddl = savedSddl(f);
    assert.match(sddl, /D:P/, `inheritance not removed: ${sddl}`);
    assert.ok(sddl.includes(`;;;${sid})`), `user SID missing: ${sddl}`);
    assert.ok(sddl.includes(";;;SY)"), `SYSTEM missing: ${sddl}`);
    for (const other of ["WD", "BU", "AU", "S-1-1-0", "S-1-5-32-545", "S-1-5-11"]) {
      assert.ok(!sddl.includes(`;;;${other})`), `${other} still granted: ${sddl}`);
    }
  });

  it("a file created later in a secured directory inherits the owner-only grant", { skip: process.platform !== "win32" }, () => {
    const d = mkdtempSync(join(tmpdir(), "p1b-plat-win-dir-"));
    assert.deepEqual(platformCapabilities.securePath(d, { mode: 0o700 }), { applied: true, mechanism: "acl" });
    const f = join(d, "later"); writeFileSync(f, "x");
    const sid = parseWhoamiSid(execFileSync(systemTool("whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" }));
    const sddl = savedSddl(f);
    assert.ok(sddl.includes(`;;;${sid})`), `user SID not inherited: ${sddl}`);
    for (const other of ["WD", "BU", "AU", "S-1-1-0", "S-1-5-32-545", "S-1-5-11"]) {
      assert.ok(!sddl.includes(`;;;${other})`), `${other} granted on a new file: ${sddl}`);
    }
  });
});
