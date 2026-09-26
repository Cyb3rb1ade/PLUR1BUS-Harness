// securePath on Windows (ruling S11): an icacls grant for the user SID and SYSTEM with inheritance removed. The win32
// branch is reached everywhere through injected `platform`/`execFile`; the last test runs the real icacls on Windows.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPlatformCapabilities, othersInDacl, parseSddlDacl, parseWhoamiSid, platformCapabilities, resolveSddlTrustee, savedSddlLine, systemTool,
} from "../src/platform.ts";
import { tempDir as newTempDir } from "./helpers/temp-dir.ts";

const SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";
const WHOAMI = `"desktop-p1b\\bernd","${SID}"\r\n`;
const ROOT = "D:\\Win";
const WHOAMI_EXE = "D:\\Win\\System32\\whoami.exe";
const ICACLS_EXE = "D:\\Win\\System32\\icacls.exe";

function tempFile(): string {
  const dir = newTempDir("p1b-plat-win-"); const f = join(dir, "t"); writeFileSync(f, "x");
  return f;
}

function tempDir(): string {
  return newTempDir("p1b-plat-win-dir-");
}

const OWNER_ONLY = `D:PAI(A;;FA;;;${SID})(A;;FA;;;SY)`;

/** `icacls /save` output as icacls writes it: UTF-16LE with a BOM, the name line, then the SDDL line. */
function saveFile(name: string, sddl: string): Buffer {
  return Buffer.from(`\uFEFF${name}\r\n${sddl}\r\n`, "utf16le");
}

/**
 * A fake whoami + icacls. `dacls` are what successive `/save` calls report (the last one repeats); `fail` makes a
 * tool throw. Calls are recorded with the `/save` target replaced by `<acl>`.
 */
function recorder(fail?: (file: string) => boolean, dacls: string[] = [OWNER_ONLY]) {
  const calls: Array<[string, readonly string[]]> = [];
  const warnings: Array<[string, Record<string, unknown> | undefined]> = [];
  let saves = 0;
  const execFile = (file: string, args: readonly string[]): string => {
    if (fail?.(file)) { calls.push([file, args]); throw Object.assign(new Error(`${file} failed`), { status: 5 }); }
    if (file === WHOAMI_EXE) { calls.push([file, args]); return WHOAMI; }
    if (args[1] === "/save") {
      calls.push([file, [args[0]!, "/save", "<acl>"]]);
      writeFileSync(args[2]!, saveFile("t", dacls[Math.min(saves++, dacls.length - 1)]!));
      return "processed 1 file\r\n";
    }
    calls.push([file, args]);
    return "processed 1 file\r\n";
  };
  const logger = { warn: (msg: string, fields?: Record<string, unknown>) => { warnings.push([msg, fields]); } };
  return { calls, warnings, execFile, logger };
}

const grant = (p: string, inherit = "") => [ICACLS_EXE, [p, "/inheritance:r", "/grant:r", `*${SID}:${inherit}(F)`, `*S-1-5-18:${inherit}(F)`]];
const save = (p: string) => [ICACLS_EXE, [p, "/save", "<acl>"]];

describe("SDDL helpers (alias-aware)", () => {
  const ADMIN = "S-1-5-21-1111111111-2222222222-3333333333-500";

  it("savedSddlLine finds the D: line of an icacls /save file", () => {
    assert.equal(savedSddlLine(saveFile("t", "D:PAI(A;;FA;;;SY)")), "D:PAI(A;;FA;;;SY)");
    assert.equal(savedSddlLine(Buffer.from("t\r\n", "utf16le")), null);
  });

  it("parseSddlDacl lists the ACEs of the DACL only", () => {
    assert.deepEqual(parseSddlDacl("O:BAD:PAI(A;OICI;FA;;;SY)(D;;FW;;;WD)S:(AU;SA;FA;;;WD)"), [
      { type: "A", flags: "OICI", rights: "FA", trustee: "SY" },
      { type: "D", flags: "", rights: "FW", trustee: "WD" },
    ]);
  });

  it("resolveSddlTrustee maps well-known and domain-relative aliases to SIDs", () => {
    assert.equal(resolveSddlTrustee("SY", ADMIN), "S-1-5-18");
    assert.equal(resolveSddlTrustee("BA", ADMIN), "S-1-5-32-544");
    assert.equal(resolveSddlTrustee("LA", ADMIN), ADMIN);
    assert.equal(resolveSddlTrustee("LA", SID), "S-1-5-21-1111111111-2222222222-3333333333-500");
    assert.equal(resolveSddlTrustee(SID, ADMIN), SID);
    assert.equal(resolveSddlTrustee("XX", ADMIN), null);
    assert.equal(resolveSddlTrustee("LA", "S-1-5-18"), null);
  });

  it("othersInDacl: the CI runner's DACL (user printed as LA) leaves only Administrators", () => {
    assert.deepEqual(othersInDacl("D:PAI(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;LA)", ADMIN), ["S-1-5-32-544"]);
    assert.deepEqual(othersInDacl("D:AI(A;ID;FA;;;SY)(A;ID;FA;;;LA)", ADMIN), []);
    assert.deepEqual(othersInDacl(`D:P(A;;FA;;;${SID})(A;;FA;;;SY)(A;;FR;;;WD)(A;;FA;;;XX)`, SID), ["S-1-1-0", "XX"]);
  });
});

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

  it("securePath grants the user SID and SYSTEM, removes inheritance, checks the result, and memoises the SID", () => {
    const r = recorder();
    const p = createPlatformCapabilities({ platform: "win32", execFile: r.execFile, logger: r.logger, systemRoot: ROOT });
    const f = tempFile();
    assert.deepEqual(p.securePath(f), { applied: true, mechanism: "acl" });
    assert.deepEqual(p.securePath(f, { mode: 0o700 }), { applied: true, mechanism: "acl" });
    assert.deepEqual(r.calls, [[WHOAMI_EXE, ["/user", "/fo", "csv", "/nh"]], grant(f), save(f), grant(f), save(f)]);
    assert.deepEqual(r.warnings, []);
  });

  it("a directory gets an inherited grant, so files created in it later are owner-only (H3-R15)", () => {
    const r = recorder();
    const p = createPlatformCapabilities({ platform: "win32", execFile: r.execFile, logger: r.logger, systemRoot: ROOT });
    const d = tempDir();
    assert.deepEqual(p.securePath(d, { mode: 0o700 }), { applied: true, mechanism: "acl" });
    assert.deepEqual(r.calls[1], grant(d, "(OI)(CI)"));
  });

  it("an explicit entry of another account that survives the grant is removed, then checked", () => {
    const r = recorder(undefined, [`D:PAI(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;${SID})(A;;FR;;;WD)`, OWNER_ONLY]);
    const p = createPlatformCapabilities({ platform: "win32", execFile: r.execFile, logger: r.logger, systemRoot: ROOT });
    const f = tempFile();
    assert.deepEqual(p.securePath(f), { applied: true, mechanism: "acl" });
    assert.deepEqual(r.calls.slice(1), [grant(f), save(f), [ICACLS_EXE, [f, "/remove", "*S-1-1-0", "*S-1-5-32-544"]], save(f)]);
    assert.deepEqual(r.warnings, []);
  });

  it("an entry that /remove cannot drop is not applied and logs a warning", () => {
    const r = recorder(undefined, ["D:PAI(A;;FA;;;SY)(A;;FA;;;BA)"]);
    const p = createPlatformCapabilities({ platform: "win32", execFile: r.execFile, logger: r.logger, systemRoot: ROOT });
    assert.deepEqual(p.securePath(tempFile()), { applied: false, reason: "acl-tool-unavailable" });
    assert.equal(r.warnings[0]![1]?.reason, "icacls-failed");
    assert.match(String(r.warnings[0]![1]?.err), /S-1-5-32-544/);
  });

  it("an unknown alias in the DACL is not applied and nothing is removed", () => {
    const r = recorder(undefined, [`D:PAI(A;;FA;;;SY)(A;;FA;;;${SID})(A;;FA;;;XX)`]);
    const p = createPlatformCapabilities({ platform: "win32", execFile: r.execFile, logger: r.logger, systemRoot: ROOT });
    assert.deepEqual(p.securePath(tempFile()), { applied: false, reason: "acl-tool-unavailable" });
    assert.ok(!r.calls.some(([, args]) => args[1] === "/remove"));
    assert.match(String(r.warnings[0]![1]?.err), /XX/);
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

/** A file's DACL as SDDL through `icacls /save`: SIDs and aliases, independent of the display language. */
function savedSddl(target: string): string {
  const saved = join(newTempDir("p1b-acl-"), "acl.txt");
  execFileSync(systemTool("icacls.exe"), [target, "/save", saved], { stdio: "ignore" });
  const sddl = savedSddlLine(readFileSync(saved));
  assert.ok(sddl, `icacls /save wrote no DACL for ${target}`);
  return sddl;
}

function realUserSid(): string {
  const sid = parseWhoamiSid(execFileSync(systemTool("whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" }));
  assert.ok(sid, "whoami named no SID");
  return sid;
}

/** Every ACE's trustee as a SID (aliases such as LA for the built-in Administrator resolved), each once. */
function trusteeSids(sddl: string, user: string): Set<string> {
  return new Set(parseSddlDacl(sddl).map((ace) => resolveSddlTrustee(ace.trustee, user) ?? ace.trustee));
}

describe("platform (Windows host)", () => {
  it("securePath applies an icacls grant on Windows", { skip: process.platform !== "win32" }, () => {
    const f = tempFile();
    assert.deepEqual(platformCapabilities.securePath(f), { applied: true, mechanism: "acl" });
    const user = realUserSid();
    const sddl = savedSddl(f);
    assert.match(sddl, /^D:P/, `inheritance not removed: ${sddl}`);
    assert.deepEqual(trusteeSids(sddl, user), new Set([user, "S-1-5-18"]), sddl);
    assert.deepEqual(othersInDacl(sddl, user), [], sddl);
  });

  it("a file created later in a secured directory inherits the owner-only grant", { skip: process.platform !== "win32" }, () => {
    const d = tempDir();
    assert.deepEqual(platformCapabilities.securePath(d, { mode: 0o700 }), { applied: true, mechanism: "acl" });
    const user = realUserSid();
    const dirSddl = savedSddl(d);
    assert.deepEqual(trusteeSids(dirSddl, user), new Set([user, "S-1-5-18"]), dirSddl);
    const f = join(d, "later"); writeFileSync(f, "x");
    const sddl = savedSddl(f);
    assert.deepEqual(trusteeSids(sddl, user), new Set([user, "S-1-5-18"]), sddl);
    assert.ok(!sddl.includes(";;;BA)"), `Administrators inherited: ${sddl}`);
  });
});
