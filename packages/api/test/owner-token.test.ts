import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSecurePath, runDir } from "@plur1bus/module-api";
import { ensureOwnerToken, ownerTokenPath } from "../src/owner-token.ts";

function home(): string {
  const h = mkdtempSync(join(tmpdir(), "api-home-"));
  mkdirSync(join(h, "run"), { mode: 0o700 }); chmodSync(join(h, "run"), 0o700);
  return h;
}

test("the owner token is created once (64 hex chars, mode 0600) and then reused", () => {
  const h = home();
  try {
    const t = ensureOwnerToken(h);
    assert.match(t, /^[0-9a-f]{64}$/);
    if (process.platform === "win32") {
      // No POSIX mode bits: the private DACL (user + SYSTEM only) is the equivalent. Re-applying it succeeds only when the
      // read-back DACL holds exactly those two, so `applied` proves the file is private (or covered by run/'s ACL).
      assert.equal(createSecurePath({ runDir: runDir(h) })(ownerTokenPath(h)).applied, true);
    } else {
      assert.equal(statSync(ownerTokenPath(h)).mode & 0o777, 0o600);
    }
    assert.equal(ensureOwnerToken(h), t);
    assert.equal(readFileSync(ownerTokenPath(h), "utf8").trim(), t);
    const other = home(); try { assert.notEqual(ensureOwnerToken(other), t); } finally { rmSync(other, { recursive: true, force: true }); }
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test("a token file readable by others, a symlink, or holding junk is refused, never trusted or silently replaced", { skip: process.platform === "win32" }, () => {
  const h = home();
  try {
    ensureOwnerToken(h);
    chmodSync(ownerTokenPath(h), 0o644);
    assert.throws(() => ensureOwnerToken(h), /not accessible by group or others/);
    chmodSync(ownerTokenPath(h), 0o600); writeFileSync(ownerTokenPath(h), "junk\n");
    assert.throws(() => ensureOwnerToken(h), /64-character hex/);
    rmSync(ownerTokenPath(h)); writeFileSync(join(h, "elsewhere"), "a".repeat(64)); symlinkSync(join(h, "elsewhere"), ownerTokenPath(h));
    assert.throws(() => ensureOwnerToken(h), /not a regular file/);
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test("a run/ that is writable by others, or missing, is refused: no token is made", { skip: process.platform === "win32" }, () => {
  const h = mkdtempSync(join(tmpdir(), "api-home-"));
  try {
    assert.throws(() => ensureOwnerToken(h), /ENOENT/);
    mkdirSync(join(h, "run")); chmodSync(join(h, "run"), 0o777);
    assert.throws(() => ensureOwnerToken(h), /writable by group or others/);
  } finally { rmSync(h, { recursive: true, force: true }); }
});
