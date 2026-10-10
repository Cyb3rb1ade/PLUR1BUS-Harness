import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureOwnerToken, ownerTokenPath } from "../src/owner-token.ts";

// Lines 35-38 of owner-token.ts run only when the host is Windows (process.platform === "win32") and the caller asked for
// the non-POSIX branch. The DACL step (createSecurePath) reads process.platform at call time, so on a POSIX host the
// process platform is swapped for the duration of one call and restored in finally. The DACL cannot be applied here
// (there is no whoami.exe or icacls), which is exactly the failure path that must remove the token and refuse to keep it.
const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const dirs: string[] = [];

function home(): string {
  const h = mkdtempSync(join(tmpdir(), "ot-win-"));
  dirs.push(h);
  mkdirSync(join(h, "run"), { mode: 0o700 });
  chmodSync(join(h, "run"), 0o700);
  return h;
}

function withProcessPlatform<T>(platform: string, fn: () => T): T {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    if (realPlatform) Object.defineProperty(process, "platform", realPlatform);
  }
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { chmodSync(join(d, "run"), 0o700); } catch { /* already gone */ }
    rmSync(d, { recursive: true, force: true });
  }
});

describe("owner token on a win32 host", { skip: process.platform === "win32" && "real Windows applies the DACL; covered by the win32 CI leg" }, () => {
  it("when the DACL cannot be applied the new token is removed and the call throws, no token is kept", () => {
    const h = home();
    const file = ownerTokenPath(h);
    assert.throws(
      () => withProcessPlatform("win32", () => ensureOwnerToken(h, { platform: "win32" })),
      (e: unknown) => e instanceof Error && /could not be restricted to this user/.test(e.message) && !/[0-9a-f]{64}/.test(e.message),
    );
    assert.equal(existsSync(file), false, "a token that could not be restricted is not left behind");
  });

  it("the error names the file but never the token value", () => {
    const h = home();
    let message = "";
    try {
      withProcessPlatform("win32", () => ensureOwnerToken(h, { platform: "win32" }));
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    assert.ok(message.includes("api-owner.token"), message);
    assert.match(message, /no token was kept/);
  });

  it("the process platform is restored after the call, even when it throws", () => {
    const h = home();
    assert.throws(() => withProcessPlatform("win32", () => ensureOwnerToken(h, { platform: "win32" })));
    assert.equal(process.platform, realPlatform?.value);
  });
});
