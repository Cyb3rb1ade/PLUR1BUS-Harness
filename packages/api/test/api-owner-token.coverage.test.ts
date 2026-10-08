import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs, { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UntrustedRunDir } from "@plur1bus/module-api";
import { ensureOwnerToken, OWNER_TOKEN_FILE, ownerTokenPath } from "../src/owner-token.ts";

const posixOnly = { skip: process.platform === "win32" && "nur POSIX" };
const dirs: string[] = [];
function home(mode = 0o700): string {
  const h = mkdtempSync(join(tmpdir(), "ot-")); dirs.push(h);
  mkdirSync(join(h, "run"), { mode }); chmodSync(join(h, "run"), mode);
  return h;
}
afterEach(() => {
  for (const d of dirs.splice(0)) { try { chmodSync(join(d, "run"), 0o700); } catch { /* gone */ } rmSync(d, { recursive: true, force: true }); }
});

describe("owner token", () => {
  it("names the file api-owner.token inside run/", () => {
    assert.equal(OWNER_TOKEN_FILE, "api-owner.token");
    assert.equal(ownerTokenPath("/x/y"), join("/x/y", "run", "api-owner.token"));
  });

  it("creates 64 lower-case hex characters plus a newline, then returns the same value", () => {
    const h = home();
    const t = ensureOwnerToken(h);
    assert.match(t, /^[0-9a-f]{64}$/);
    assert.equal(readFileSync(ownerTokenPath(h), "utf8"), `${t}\n`);
    assert.equal(ensureOwnerToken(h), t);
    assert.equal(ensureOwnerToken(h), t);
  });

  it("tolerates surrounding whitespace in an existing valid file", { ...posixOnly }, () => {
    const h = home(); const t = "ab".repeat(32);
    writeFileSync(ownerTokenPath(h), `  \n${t}\r\n\n`, { mode: 0o600 });
    assert.equal(ensureOwnerToken(h), t);
  });

  const junk: Array<[string, string]> = [
    ["empty", ""], ["too short", "a".repeat(63)], ["too long", "a".repeat(65)], ["upper case", "A".repeat(64)], ["non-hex", "g".repeat(64)],
    ["two lines", `${"a".repeat(64)}\n${"b".repeat(64)}`], ["embedded space", `${"a".repeat(32)} ${"a".repeat(31)}`],
  ];
  for (const [label, content] of junk) it(`refuses a file that is ${label}, without replacing it`, posixOnly, () => {
    const h = home();
    writeFileSync(ownerTokenPath(h), content, { mode: 0o600 });
    assert.throws(() => ensureOwnerToken(h), /does not hold a 64-character hex token/);
    assert.equal(readFileSync(ownerTokenPath(h), "utf8"), content);
  });

  it("refuses group/other access in every combination of mode bits", posixOnly, () => {
    const h = home(); ensureOwnerToken(h);
    for (const mode of [0o640, 0o604, 0o660, 0o606, 0o666, 0o644, 0o601]) {
      chmodSync(ownerTokenPath(h), mode);
      assert.throws(() => ensureOwnerToken(h), /must be owned by this user and not accessible by group or others/, mode.toString(8));
    }
    chmodSync(ownerTokenPath(h), 0o400);
    assert.match(ensureOwnerToken(h), /^[0-9a-f]{64}$/, "owner read-only is fine");
  });

  it("refuses a directory and a symlink in place of the file", posixOnly, () => {
    const h = home();
    mkdirSync(ownerTokenPath(h));
    assert.throws(() => ensureOwnerToken(h), /is not a regular file/);
    rmSync(ownerTokenPath(h), { recursive: true });
    symlinkSync(join(h, "nowhere"), ownerTokenPath(h));
    assert.throws(() => ensureOwnerToken(h), /is not a regular file/, "dangling symlink");
  });

  it("refuses a file owned by someone else (simulated through the effective uid)", posixOnly, () => {
    const h = home(); ensureOwnerToken(h);
    const real = process.geteuid!();
    const fakeEuid = real + 1;
    const lstat = () => ({ isDirectory: () => true, isSymbolicLink: () => false, isSocket: () => false, uid: fakeEuid, mode: 0o40700 });
    assert.throws(() => ensureOwnerToken(h, { euid: fakeEuid, lstat }), /must be owned by this user/);
  });

  it("refuses a missing, symlinked, loose or foreign run/ before it creates anything", posixOnly, () => {
    const missing = mkdtempSync(join(tmpdir(), "ot-")); dirs.push(missing);
    assert.throws(() => ensureOwnerToken(missing), /ENOENT/);
    const loose = home(0o777);
    assert.throws(() => ensureOwnerToken(loose), (e: unknown) => e instanceof UntrustedRunDir && /writable by group or others/.test(e.message));
    assert.throws(() => readFileSync(ownerTokenPath(loose)), /ENOENT/);
    const target = home(); const linked = mkdtempSync(join(tmpdir(), "ot-")); dirs.push(linked);
    symlinkSync(join(target, "run"), join(linked, "run"));
    assert.throws(() => ensureOwnerToken(linked), (e: unknown) => e instanceof UntrustedRunDir && /symlink/.test(e.message));
    const h = home();
    assert.throws(() => ensureOwnerToken(h, { euid: process.geteuid!() + 1 }), UntrustedRunDir);
  });

  it("rethrows a non-ENOENT error from inspecting the file", { skip: process.platform === "win32" || process.geteuid?.() === 0 ? "nur POSIX, nicht als root" : false }, () => {
    const h = home();
    chmodSync(join(h, "run"), 0o000);
    assert.throws(() => ensureOwnerToken(h), (e: unknown) => (e as NodeJS.ErrnoException).code === "EACCES");
  });

  it("on win32 semantics the mode bits are not checked (platform option)", posixOnly, () => {
    const h = home(); const t = "cd".repeat(32);
    writeFileSync(ownerTokenPath(h), t, { mode: 0o666 }); chmodSync(ownerTokenPath(h), 0o666);
    assert.equal(ensureOwnerToken(h, { platform: "win32" }), t);
  });

  it("with the win32 platform option a new token is created without the POSIX mode check (real platform is not win32)", posixOnly, () => {
    const h = home();
    const t = ensureOwnerToken(h, { platform: "win32" });
    assert.match(t, /^[0-9a-f]{64}$/);
    assert.equal(statSync(ownerTokenPath(h)).mode & 0o777, 0o600);
  });

  it("two homes get different tokens", () => {
    assert.notEqual(ensureOwnerToken(home()), ensureOwnerToken(home()));
  });

  it("a lost start race uses the winner's token (file appears between check and write)", posixOnly, (t) => {
    const h = home(); const winner = "ef".repeat(32);
    const realLstat = fs.lstatSync; let first = true;
    t.mock.method(fs, "lstatSync", (p: string, ...rest: unknown[]) => {
      if (first && String(p).endsWith(OWNER_TOKEN_FILE)) {
        first = false;
        writeFileSync(p, `${winner}\n`, { mode: 0o600 });
        const e: NodeJS.ErrnoException = new Error("ENOENT"); e.code = "ENOENT"; throw e;
      }
      return (realLstat as Any)(p, ...rest);
    });
    syncBuiltinESMExports();
    try { assert.equal(ensureOwnerToken(h), winner); } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  });

  it("another write error is rethrown and leaves no file", posixOnly, (t) => {
    const h = home();
    t.mock.method(fs, "writeFileSync", () => { const e: NodeJS.ErrnoException = new Error("EIO"); e.code = "EIO"; throw e; });
    syncBuiltinESMExports();
    try { assert.throws(() => ensureOwnerToken(h), (e: unknown) => (e as NodeJS.ErrnoException).code === "EIO"); } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    assert.throws(() => readFileSync(ownerTokenPath(h)), /ENOENT/);
  });
});

type Any = any;
