import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore } from "../src/account-store.ts";
import { ensureBootstrap, verifyBootstrap } from "../src/bootstrap.ts";
function rig(t: TestContext, now = Date.now()) {
  const home = mkdtempSync(join(tmpdir(), "bootstrap-private-")); mkdirSync(join(home, "run"), { mode: 0o700 }); chmodSync(join(home, "run"), 0o700);
  let clock = now; const accounts = new AccountStore({ path: join(home, "state", "accounts.db"), resolve: async userId => ({ userId, kind: "person", role: "owner", disabled: false, version: 1 }), now: () => clock });
  t.after(() => { accounts.close(); rmSync(home, { recursive: true, force: true }); });
  return { home, accounts, file: join(home, "run", "api-bootstrap.token"), expire: () => { clock = Date.now(); } };
}
test("bootstrap proof is private, persists pending startup, and cannot regenerate after account creation", async t => {
  const r = rig(t), clean = ensureBootstrap(r.home, r.accounts), proof = readFileSync(r.file, "utf8").trim();
  if (process.platform !== "win32") assert.equal(statSync(r.file).mode & 0o777, 0o600);
  assert.equal(verifyBootstrap(r.accounts, proof), true); ensureBootstrap(r.home, r.accounts); assert.equal(readFileSync(r.file, "utf8").trim(), proof);
  await r.accounts.bootstrapOwner("christian", "unused"); clean(); ensureBootstrap(r.home, r.accounts); assert.equal(existsSync(r.file), false); assert.equal(verifyBootstrap(r.accounts, proof), false);
});
test("bundled installer flag permanently suppresses startup proof", t => {
  const r = rig(t); ensureBootstrap(r.home, r.accounts, true); assert.equal(existsSync(r.file), false); ensureBootstrap(r.home, r.accounts); assert.equal(existsSync(r.file), false); assert.equal(r.accounts.bootstrapState()?.consumed, true);
});
test("expired unconsumed startup proof rotates on local restart, never validates the previous value", t => {
  const r = rig(t, Date.now() - 16 * 60000); ensureBootstrap(r.home, r.accounts); const first = readFileSync(r.file, "utf8").trim(); assert.equal(verifyBootstrap(r.accounts, first), false);
  r.expire(); ensureBootstrap(r.home, r.accounts); const next = readFileSync(r.file, "utf8").trim(); assert.notEqual(first, next); assert.equal(verifyBootstrap(r.accounts, first), false); assert.equal(verifyBootstrap(r.accounts, next), true);
});
test("bootstrap refuses a symlink or group-readable proof", { skip: process.platform === "win32" }, t => {
  const r = rig(t); ensureBootstrap(r.home, r.accounts); chmodSync(r.file, 0o644); assert.throws(() => ensureBootstrap(r.home, r.accounts), /untrusted bootstrap file/);
  rmSync(r.file); symlinkSync(join(r.home, "state", "accounts.db"), r.file); assert.throws(() => ensureBootstrap(r.home, r.accounts), /untrusted bootstrap file/);
});

test("oversized private bootstrap state fails closed before reading or replacing the proof", t => {
  const r = rig(t); ensureBootstrap(r.home, r.accounts);
  writeFileSync(r.file, "x".repeat(1024));
  assert.throws(() => ensureBootstrap(r.home, r.accounts), /untrusted bootstrap file/);
  assert.equal(statSync(r.file).size, 1024); assert.equal(r.accounts.bootstrapState()?.consumed, false);
});
