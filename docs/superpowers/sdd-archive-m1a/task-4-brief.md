### Task 4 (PR-01a): `lib/platform.js` and its unit tests

Pure addition — nothing calls it yet. Task 5 routes the call sites.

**Files:**
- Create: `lib/platform.js`
- Create: `tests/platform.test.js`

**Interfaces:**
- Produces:
  - `isFilesystemPath(target: unknown) -> boolean`
  - `securePath(target: string, options?: { mode?: number, fd?: number|null, platform?: string, execFile?: Function, username?: string|null }) -> { applied: boolean, reason?: string, mechanism?: "chmod"|"acl" }`
  - `ipcAddress(stateRoot: string, options?: { platform?: string }) -> { kind: "abstract-socket"|"unix-socket"|"named-pipe", address: string }`
  - `isUnsafeLink(target: string, options?: { platform?: string, stat?: Stats|null }) -> boolean`
  - `canonicalIdentityPath(target: string, options?: { platform?: string }) -> string`
  These match `PlatformCapabilities`, `SecurePathResult` and `IpcAddress` in `types/engine.d.ts` (Task 3).
- Consumed by: Task 5 (`securePath` only). `ipcAddress` is wired in PR-11, `isUnsafeLink` in the f.15 sweep and `canonicalIdentityPath` in PR-06 — all outside M1a. They are defined and tested now so the contract is complete and the harness can import them.

**House style to match:** `lib/providers/scoped-embedding-ipc.js:207` already takes `platform = process.platform` as a defaulted parameter. Every function here does the same, so a test reaches the win32 branch either by passing `{ platform: "win32" }` or by stubbing `process.platform` — the default is evaluated at call time, so both work.

- [ ] **Step 1: Write the failing tests**

Create `tests/platform.test.js`:

```js
/**
 * tests/platform.test.js — lib/platform.js, including the win32 branches,
 * which are reached both by the explicit `platform` option and by stubbing
 * `process.platform`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { closeSync, mkdirSync, openSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  canonicalIdentityPath,
  ipcAddress,
  isFilesystemPath,
  isUnsafeLink,
  securePath,
} from "../lib/platform.js";
import { makeTempDir } from "./helpers/temp-dir.js";

function withStubbedPlatform(value, body) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value, configurable: true });
  try {
    return body();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

describe("lib/platform isFilesystemPath", () => {
  it("accepts an ordinary path and rejects pipe and abstract addresses", () => {
    assert.equal(isFilesystemPath("/tmp/x"), true);
    assert.equal(isFilesystemPath("\\\\.\\pipe\\plur1bus-embedding-abc"), false);
    assert.equal(isFilesystemPath("\0plur1bus-embedding-abc"), false);
    assert.equal(isFilesystemPath(""), false);
    assert.equal(isFilesystemPath(undefined), false);
  });
});

describe("lib/platform securePath", () => {
  it("chmods a regular file on POSIX", () => {
    const dir = makeTempDir("plur1bus-platform-");
    const file = join(dir, "state.json");
    writeFileSync(file, "{}", { mode: 0o644 });
    const result = securePath(file, { mode: 0o600, platform: "linux" });
    assert.deepEqual(result, { applied: true, mechanism: "chmod" });
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });

  it("chmods through a file descriptor when one is given", () => {
    const dir = makeTempDir("plur1bus-platform-fd-");
    const file = join(dir, "report.json");
    const fd = openSync(file, "wx", 0o644);
    try {
      const result = securePath(file, { mode: 0o600, fd, platform: "linux" });
      assert.deepEqual(result, { applied: true, mechanism: "chmod" });
    } finally {
      closeSync(fd);
    }
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });

  it("secures a live unix domain socket rather than refusing it", async () => {
    const dir = makeTempDir("plur1bus-platform-sock-");
    const socketPath = join(dir, "owner.sock");
    const server = createServer();
    await new Promise((done) => server.listen(socketPath, done));
    try {
      const result = securePath(socketPath, { mode: 0o600, platform: "linux" });
      assert.deepEqual(result, { applied: true, mechanism: "chmod" });
      assert.equal(statSync(socketPath).mode & 0o777, 0o600);
    } finally {
      await new Promise((done) => server.close(done));
    }
  });

  it("refuses a named pipe instead of throwing", () => {
    const result = securePath("\\\\.\\pipe\\plur1bus-embedding-abc", { platform: "win32" });
    assert.deepEqual(result, { applied: false, reason: "not-a-filesystem-path" });
  });

  it("runs an icacls ACL grant on win32", () => {
    const calls = [];
    const result = securePath("C:\\state\\owner.token", {
      platform: "win32",
      username: "tester",
      execFile: (...args) => { calls.push(args); },
    });
    assert.deepEqual(result, { applied: true, mechanism: "acl" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "icacls");
    assert.deepEqual(calls[0][1], [
      "C:\\state\\owner.token",
      "/inheritance:r",
      "/grant:r",
      "tester:(F)",
    ]);
  });

  it("reaches the win32 branch through a stubbed process.platform", () => {
    const calls = [];
    const result = withStubbedPlatform("win32", () => securePath("C:\\state\\owner.token", {
      username: "tester",
      execFile: (...args) => { calls.push(args); },
    }));
    assert.deepEqual(result, { applied: true, mechanism: "acl" });
    assert.equal(calls.length, 1);
  });
});

describe("lib/platform ipcAddress", () => {
  it("returns an abstract socket on linux", () => {
    const address = ipcAddress("/var/lib/plur1bus", { platform: "linux" });
    assert.equal(address.kind, "abstract-socket");
    assert.match(address.address, /^\0plur1bus-embedding-[0-9a-f]{32}$/);
  });

  it("returns a named pipe on win32", () => {
    const address = ipcAddress("C:\\ProgramData\\plur1bus", { platform: "win32" });
    assert.equal(address.kind, "named-pipe");
    assert.match(address.address, /^\\\\\.\\pipe\\plur1bus-embedding-[0-9a-f]{32}$/);
  });

  it("returns a filesystem socket on darwin", () => {
    const address = ipcAddress("/Users/x/.plur1bus", { platform: "darwin" });
    assert.deepEqual(address, { kind: "unix-socket", address: "/Users/x/.plur1bus/owner.sock" });
  });

  it("is deterministic and distinct per state root", () => {
    const a = ipcAddress("/a", { platform: "linux" });
    const b = ipcAddress("/a", { platform: "linux" });
    const c = ipcAddress("/b", { platform: "linux" });
    assert.equal(a.address, b.address);
    assert.notEqual(a.address, c.address);
  });
});

describe("lib/platform isUnsafeLink", () => {
  it("is true for a symlink and false for a real file", () => {
    const dir = makeTempDir("plur1bus-platform-link-");
    const real = join(dir, "real.txt");
    const link = join(dir, "link.txt");
    writeFileSync(real, "x");
    symlinkSync(real, link);
    assert.equal(isUnsafeLink(link, { platform: "linux" }), true);
    assert.equal(isUnsafeLink(real, { platform: "linux" }), false);
  });

  it("is false for a missing path and for a non-filesystem address", () => {
    assert.equal(isUnsafeLink("/nonexistent/plur1bus/xyz", { platform: "linux" }), false);
    assert.equal(isUnsafeLink("\\\\.\\pipe\\x", { platform: "win32" }), false);
  });

  it("accepts a pre-read stat so callers need not lstat twice", () => {
    const dir = makeTempDir("plur1bus-platform-stat-");
    const real = join(dir, "real.txt");
    writeFileSync(real, "x");
    assert.equal(isUnsafeLink(real, { platform: "linux", stat: { isSymbolicLink: () => true } }), true);
  });

  it("on win32 treats a path whose native realpath differs as a reparse point", () => {
    const dir = makeTempDir("plur1bus-platform-junction-");
    const real = join(dir, "target");
    const link = join(dir, "junction");
    mkdirSync(real);
    symlinkSync(real, link, "dir");
    // The stat says "not a symlink" (as Windows reports a junction); the
    // realpath comparison is what catches it.
    assert.equal(
      isUnsafeLink(link, { platform: "win32", stat: { isSymbolicLink: () => false } }),
      true,
    );
  });
});

describe("lib/platform canonicalIdentityPath", () => {
  it("resolves a real directory on POSIX and preserves case", () => {
    const dir = makeTempDir("plur1bus-platform-Canon-");
    // realpathSync, not the raw path: on macOS os.tmpdir() is /var -> /private/var.
    assert.equal(canonicalIdentityPath(dir, { platform: "linux" }), realpathSync(dir));
    assert.match(canonicalIdentityPath(dir, { platform: "linux" }), /Canon-/);
  });

  it("folds case and separators on win32 so one workspace hashes once", () => {
    const a = canonicalIdentityPath("C:\\Users\\X\\Work", { platform: "win32" });
    const b = canonicalIdentityPath("c:/users/x/work", { platform: "win32" });
    assert.equal(a, b);
  });

  it("falls back to the absolute path when the target does not exist", () => {
    const value = canonicalIdentityPath("/nonexistent/plur1bus/ws", { platform: "linux" });
    assert.equal(value, "/nonexistent/plur1bus/ws");
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/platform.test.js 2>&1 | tail -5
```

Expected: the file fails to load with `ERR_MODULE_NOT_FOUND … '../lib/platform.js'`.

- [ ] **Step 3: Write the implementation**

Create `lib/platform.js`:

```js
/**
 * lib/platform.js — the four platform decisions, in one place.
 *
 * `securePath`            — host-contract §f.9: chmod is not a permission on
 *                           Windows, so a token or state file written 0o600
 *                           stays world-readable there.
 * `ipcAddress`            — the embedding owner's transport per platform.
 * `isUnsafeLink`          — host-contract §f.15: `isSymbolicLink()` is false
 *                           for a Windows junction or reparse point.
 * `canonicalIdentityPath` — ADR-002 §"Principal and turn-origin contract":
 *                           `C:\Users\X` and `c:\users\x` must hash alike.
 *
 * Every function takes a `platform` option that defaults to `process.platform`
 * at call time, mirroring `resolveScopedEmbeddingOwnerClaimAddress`
 * (lib/providers/scoped-embedding-ipc.js:207), so unit tests can reach the
 * win32 branches on Linux either by passing the option or by stubbing
 * `process.platform`.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, fchmodSync, lstatSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { resolve } from "node:path";

const NAMED_PIPE_PREFIX = "\\\\.\\pipe\\";

/**
 * A value `securePath` and `isUnsafeLink` can actually act on. Named pipes and
 * Linux abstract sockets have no filesystem entry.
 * @param {unknown} target Candidate path.
 * @returns {boolean} True when the value is a real filesystem path.
 */
export function isFilesystemPath(target) {
  if (typeof target !== "string" || target.length === 0) return false;
  if (target.startsWith(NAMED_PIPE_PREFIX)) return false;
  if (target.startsWith("\0")) return false;
  return true;
}

/**
 * Restrict a path to the current user.
 *
 * POSIX: `chmod` (on `fd` when one is supplied, which is race-free).
 * win32: a per-user SID ACL via `icacls`, because `chmod` only toggles the
 *        read-only bit there.
 *
 * Never throws for an address that has no filesystem entry; the caller gets
 * `{ applied: false, reason: "not-a-filesystem-path" }` so an embedding owner
 * on a named pipe does not fail to start.
 *
 * @param {string} target Filesystem path.
 * @param {{mode?: number, fd?: number|null, platform?: string,
 *          execFile?: Function, username?: string|null}} [options] Options.
 * @returns {{applied: boolean, reason?: string, mechanism?: "chmod"|"acl"}} Outcome.
 */
export function securePath(target, {
  mode = 0o600,
  fd = null,
  platform = process.platform,
  execFile = execFileSync,
  username = null,
} = {}) {
  if (!isFilesystemPath(target)) return { applied: false, reason: "not-a-filesystem-path" };
  if (platform !== "win32") {
    if (fd !== null && fd !== undefined) fchmodSync(fd, mode);
    else chmodSync(target, mode);
    return { applied: true, mechanism: "chmod" };
  }
  const who = username || userInfo().username;
  execFile("icacls", [target, "/inheritance:r", "/grant:r", `${who}:(F)`], { stdio: "ignore" });
  return { applied: true, mechanism: "acl" };
}

/**
 * The embedding-owner IPC address for a state root.
 *
 * linux  — abstract socket, no filesystem entry, released on process death.
 * win32  — named pipe `\\.\pipe\plur1bus-embedding-<sha256(stateRoot)[0:32]>`.
 * other  — filesystem socket under the state root (darwin, BSD).
 *
 * @param {string} stateRoot Canonical private state directory.
 * @param {{platform?: string}} [options] Options.
 * @returns {{kind: "abstract-socket"|"unix-socket"|"named-pipe", address: string}} Address.
 */
export function ipcAddress(stateRoot, { platform = process.platform } = {}) {
  const digest = createHash("sha256").update(String(stateRoot)).digest("hex").slice(0, 32);
  if (platform === "linux") {
    return Object.freeze({ kind: "abstract-socket", address: `\0plur1bus-embedding-${digest}` });
  }
  if (platform === "win32") {
    return Object.freeze({ kind: "named-pipe", address: `${NAMED_PIPE_PREFIX}plur1bus-embedding-${digest}` });
  }
  return Object.freeze({ kind: "unix-socket", address: resolve(stateRoot, "owner.sock") });
}

/**
 * True when a path must not be followed: a symlink anywhere, and additionally
 * a junction or other reparse point on Windows, where `isSymbolicLink()` is
 * false. A missing path is not unsafe.
 *
 * @param {string} target Path to inspect.
 * @param {{platform?: string, stat?: import("node:fs").Stats|null}} [options] Options.
 * @returns {boolean} True when the path is a link the caller must refuse.
 */
export function isUnsafeLink(target, { platform = process.platform, stat = null } = {}) {
  if (!isFilesystemPath(target)) return false;
  let entry = stat;
  if (!entry) {
    try {
      entry = lstatSync(target);
    } catch {
      return false;
    }
  }
  if (typeof entry.isSymbolicLink === "function" && entry.isSymbolicLink()) return true;
  if (platform !== "win32") return false;
  try {
    return realpathSync.native(target) !== resolve(target);
  } catch {
    return false;
  }
}

/**
 * The stable identity form of a path, used before hashing a workspace
 * principal. On Windows the filesystem is case-insensitive and accepts both
 * separators, so `C:/Users/X` and `c:\users\x` must produce one string.
 *
 * @param {string} target Path to canonicalise.
 * @param {{platform?: string}} [options] Options.
 * @returns {string} Canonical identity path.
 */
export function canonicalIdentityPath(target, { platform = process.platform } = {}) {
  const absolute = resolve(String(target));
  let resolved = absolute;
  try {
    resolved = realpathSync(absolute);
  } catch {
    resolved = absolute;
  }
  if (platform !== "win32") return resolved;
  return resolved.replace(/\//g, "\\").toLowerCase();
}
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/platform.test.js 2>&1 | tail -8
```

Expected: `tests 18`, `pass 18`, `fail 0`.

- [ ] **Step 5: Lint, suite, golden**

```bash
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run lint
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/golden-prefix.test.js
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm test 2>&1 | tail -20
```

Expected: lint 0; golden `pass 7 / fail 0`; suite at the accepted baseline (now 5 094 tests, 5 089 pass, 2 fail).

- [ ] **Step 6: Commit**

```bash
cd "$PLUR1BUS"
git add lib/platform.js tests/platform.test.js
git commit -m "feat(platform): add securePath, ipcAddress, isUnsafeLink, canonicalIdentityPath

PR-01a. No call site yet. securePath returns a result object instead of
throwing so a named pipe or abstract socket cannot fail the embedding owner's
start-up; the win32 branches are covered both by an explicit platform option
and by a stubbed process.platform."
```

---

