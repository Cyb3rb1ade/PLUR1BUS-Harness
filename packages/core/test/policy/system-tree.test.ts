// D109 §3: home, drive roots, `/`, `/Users`, `C:\Users` and system trees are never roots, and a grant on them is T3 and at most `task`.
// The classification lives in the path layer: `isSystemTreePath` (a target), `grantReachesSystemTree` (a path grant) and
// `canonicalisePath(...).systemTree`, which the tool classifiers copy into the call's `systemTree` flag.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalisePath, grantReachesSystemTree, isSystemTreePath } from "../../src/policy/paths-index.ts";
import type { CanonicalPath } from "../../src/policy/paths-index.ts";

const T = { timeout: 30_000 };
const posix = { windows: false, homes: ["/home/u"] };
const mac = { windows: false, homes: ["/Users/u"] };
const win = { windows: true, homes: ["C:\\Users\\u"] };

describe("isSystemTreePath: the target itself", () => {
  it("POSIX: root, home, /home, /Users and the system trees (and below them) count", () => {
    for (const p of ["/", "/home/u", "/home", "/Users", "/etc", "/etc/hosts", "/usr/local/bin", "/System/Library/x", "/Library", "/bin", "/sbin", "/boot", "/proc/1", "/sys", "/dev/null"]) {
      assert.equal(isSystemTreePath(p, posix), true, p);
    }
  });
  it("POSIX: a folder in home, another person's home and ordinary trees do not", () => {
    for (const p of ["/home/u/work", "/home/u/Documents/a.txt", "/home/other", "/srv/data", "/tmp/x", "/var/www", "/opt/app", "/etcetera", "/usrlocal"]) {
      assert.equal(isSystemTreePath(p, posix), false, p);
    }
  });
  it("macOS: /private/etc and friends are system trees, /private/tmp is not", () => {
    for (const p of ["/Users/u", "/Users", "/private/etc", "/private/etc/ssh", "/private/var/db", "/private/var/root/x", "/System/Volumes/Data"]) assert.equal(isSystemTreePath(p, mac), true, p);
    for (const p of ["/Users/u/work", "/private/tmp/work", "/Users/other/x"]) assert.equal(isSystemTreePath(p, mac), false, p);
  });
  it("Windows: drive roots, C:\\Users, the home and the Windows and Program Files trees count, case-insensitively and with either separator", () => {
    for (const p of ["C:\\", "D:\\", "C:/", "C:\\Users", "c:\\users", "C:\\Users\\u", "c:/users/U", "C:\\Windows", "c:\\windows\\system32", "C:\\Program Files\\x", "C:\\Program Files (x86)", "C:\\ProgramData\\y", "\\\\srv\\share"]) {
      assert.equal(isSystemTreePath(p, win), true, p);
    }
    for (const p of ["C:\\Users\\u\\work", "C:\\Users\\other", "D:\\data\\x", "C:\\work", "\\\\srv\\share\\dir"]) assert.equal(isSystemTreePath(p, win), false, p);
  });
  it("a home that is a link is recognised by its real path as well", () => {
    assert.equal(isSystemTreePath("/data/real-home", { windows: false, homes: ["/home/u", "/data/real-home"] }), true);
    assert.equal(isSystemTreePath("/data/real-home/work", { windows: false, homes: ["/home/u", "/data/real-home"] }), false);
  });
  it("case folding can only classify more: /ETC on a case-insensitive volume is still a system tree", () => {
    assert.equal(isSystemTreePath("/ETC/hosts", posix), true);
    assert.equal(isSystemTreePath("/HOME/U", posix), true);
  });
  it("an unreadable (empty) path fails closed", () => {
    assert.equal(isSystemTreePath("", posix), true);
  });
});

describe("grantReachesSystemTree: a path grant", () => {
  it("a grant on home, on /etc or on a directory holding the home reaches one, recursive or not", () => {
    for (const rec of [false, true]) {
      for (const p of ["/home/u", "/etc", "/usr/share", "/home"]) assert.equal(grantReachesSystemTree(p, rec, posix), true, `${p} ${rec}`);
      assert.equal(grantReachesSystemTree("C:\\Windows", rec, win), true);
      assert.equal(grantReachesSystemTree("C:\\Users\\u", rec, win), true);
    }
    assert.equal(grantReachesSystemTree("/srv", false, { windows: false, homes: ["/srv/people/u"] }), true, "a directory that holds the home");
  });
  it("a recursive grant on an ancestor of a system tree reaches it; a non-recursive one covers only the direct children", () => {
    assert.equal(grantReachesSystemTree("/private", true, mac), true);
    assert.equal(grantReachesSystemTree("/private", false, mac), false);
    assert.equal(grantReachesSystemTree("C:\\Program Files", true, win), true);
  });
  it("a folder inside home, an ordinary directory and another person's home do not", () => {
    for (const rec of [false, true]) {
      for (const p of ["/home/u/Documents", "/home/u/work/proj", "/srv/data", "/tmp/x", "/home/other"]) assert.equal(grantReachesSystemTree(p, rec, posix), false, `${p} ${rec}`);
      assert.equal(grantReachesSystemTree("C:\\Users\\u\\work", rec, win), false);
      assert.equal(grantReachesSystemTree("D:\\data", rec, win), false);
    }
  });
});

describe("canonicalisePath reports systemTree on the real target", { skip: process.platform === "win32" }, () => {
  let base = "", home = "", work = "";
  before(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), "p1b-systree-")));
    home = join(base, "home", "u");
    work = join(home, "work");
    await mkdir(work, { recursive: true });
    await symlink(join(base, "home"), join(base, "homelink"));
  });
  after(async () => { await rm(base, { recursive: true, force: true }); });
  const ok = (r: Awaited<ReturnType<typeof canonicalisePath>>): CanonicalPath => { assert.equal(r.ok, true, r.ok ? "" : `${r.reason}: ${r.detail}`); return r as CanonicalPath; };

  it("the home directory itself and the root are flagged, a folder in home and a workspace root's files are not", T, async () => {
    const o = { roots: [{ id: "ws", path: work }], requireRoot: false, home };
    assert.equal(ok(await canonicalisePath(home, o)).systemTree, true);
    assert.equal(ok(await canonicalisePath("/", o)).systemTree, true);
    assert.equal(ok(await canonicalisePath("/etc", o)).systemTree, true);
    assert.equal(ok(await canonicalisePath(join(home, "newdir", "x.txt"), o)).systemTree, false);
    assert.equal(ok(await canonicalisePath(join(work, "a.txt"), o)).systemTree, false);
    assert.equal(ok(await canonicalisePath(tmpdir(), o)).systemTree, false);
  });
  it("a home reached through a link is the same home", T, async () => {
    const o = { roots: [{ id: "ws", path: work }], requireRoot: false, home: join(base, "homelink", "u") };
    assert.equal(ok(await canonicalisePath(home, o)).systemTree, true);
    assert.equal(ok(await canonicalisePath(join(base, "homelink", "u"), o)).systemTree, true);
  });
});
