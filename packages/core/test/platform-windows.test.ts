// securePath on Windows (ruling S11): an icacls grant for the user SID and SYSTEM with inheritance removed. The win32
// branch is reached everywhere through injected `platform`/`execFile`; the last test runs the real icacls on Windows.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlatformCapabilities, platformCapabilities, parseWhoamiSid } from "../src/platform.ts";

const SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";
const WHOAMI = `"desktop-p1b\\bernd","${SID}"\r\n`;

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "p1b-plat-win-")); const f = join(dir, "t"); writeFileSync(f, "x");
  return f;
}

function recorder(fail?: (file: string) => boolean) {
  const calls: Array<[string, readonly string[]]> = [];
  const warnings: Array<[string, Record<string, unknown> | undefined]> = [];
  const execFile = (file: string, args: readonly string[]): string => {
    calls.push([file, args]);
    if (fail?.(file)) throw Object.assign(new Error(`${file} failed`), { status: 5 });
    return file === "whoami" ? WHOAMI : "processed 1 file\r\n";
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

  it("securePath grants the user SID and SYSTEM, removes inheritance, and memoises the SID", () => {
    const r = recorder();
    const p = createPlatformCapabilities({ platform: "win32", execFile: r.execFile, logger: r.logger });
    const f = tempFile();
    assert.deepEqual(p.securePath(f), { applied: true, mechanism: "acl" });
    assert.deepEqual(p.securePath(f, { mode: 0o700 }), { applied: true, mechanism: "acl" });
    assert.deepEqual(r.calls, [
      ["whoami", ["/user", "/fo", "csv", "/nh"]],
      ["icacls", [f, "/inheritance:r", "/grant:r", `*${SID}:(F)`, "*S-1-5-18:(F)"]],
      ["icacls", [f, "/inheritance:r", "/grant:r", `*${SID}:(F)`, "*S-1-5-18:(F)"]],
    ]);
    assert.deepEqual(r.warnings, []);
  });

  it("a failing icacls is not applied and logs a warning", () => {
    const r = recorder((file) => file === "icacls");
    const p = createPlatformCapabilities({ platform: "win32", execFile: r.execFile, logger: r.logger });
    const f = tempFile();
    assert.deepEqual(p.securePath(f), { applied: false, reason: "acl-tool-unavailable" });
    assert.equal(r.warnings.length, 1);
    assert.equal(r.warnings[0]![1]?.reason, "icacls-failed");
    assert.equal(r.warnings[0]![1]?.path, f);
  });

  it("an unreadable whoami answer is not applied and never runs icacls", () => {
    const r = recorder((file) => file === "whoami");
    const p = createPlatformCapabilities({ platform: "win32", execFile: r.execFile, logger: r.logger });
    assert.deepEqual(p.securePath(tempFile()), { applied: false, reason: "acl-tool-unavailable" });
    assert.deepEqual(r.calls.map(([file]) => file), ["whoami"]);
    assert.equal(r.warnings[0]![1]?.reason, "icacls-failed");
  });

  it("a missing path or a pipe name is refused before any tool runs", () => {
    const r = recorder();
    const p = createPlatformCapabilities({ platform: "win32", execFile: r.execFile, logger: r.logger });
    assert.deepEqual(p.securePath(join(tmpdir(), "p1b-no-such-file-xyz")), { applied: false, reason: "missing" });
    assert.deepEqual(p.securePath("relative/path"), { applied: false, reason: "not-a-filesystem-path" });
    assert.deepEqual(r.calls, []);
  });
});

describe("platform (Windows host)", () => {
  it("securePath applies an icacls grant on Windows", { skip: process.platform !== "win32" }, () => {
    const f = tempFile();
    assert.deepEqual(platformCapabilities.securePath(f), { applied: true, mechanism: "acl" });
    const sid = parseWhoamiSid(execFileSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" }));
    assert.ok(sid, "whoami named no SID");
    // /save writes the DACL as SDDL (UTF-16LE): SIDs and well-known aliases, independent of the display language.
    const saved = join(mkdtempSync(join(tmpdir(), "p1b-acl-")), "acl.txt");
    execFileSync("icacls", [f, "/save", saved], { stdio: "ignore" });
    const sddl = readFileSync(saved).toString("utf16le").replace(/^﻿/, "");
    assert.match(sddl, /D:P/, `inheritance not removed: ${sddl}`);
    assert.ok(sddl.includes(`;;;${sid})`), `user SID missing: ${sddl}`);
    assert.ok(sddl.includes(";;;SY)"), `SYSTEM missing: ${sddl}`);
    for (const other of ["WD", "BU", "AU", "S-1-1-0", "S-1-5-32-545", "S-1-5-11"]) {
      assert.ok(!sddl.includes(`;;;${other})`), `${other} still granted: ${sddl}`);
    }
  });
});
