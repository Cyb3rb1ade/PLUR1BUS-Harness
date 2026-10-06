import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { runDir } from "@plur1bus/module-api";
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
    const st = lstatSync(ownerTokenPath(h));
    assert.ok(st.isFile() && !st.isSymbolicLink(), "a regular file, never a link");
    if (process.platform === "win32") {
      // No POSIX modes on Windows: the product writes the token (mode ignored) into `run/`, whose user-only ACL the core
      // applies, and trusts that directory. So what holds here is where the token lives, not st.mode.
      assert.equal(dirname(ownerTokenPath(h)), runDir(h), "the token sits directly in the private run/ directory");
    } else {
      assert.equal(st.mode & 0o777, 0o600);
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
