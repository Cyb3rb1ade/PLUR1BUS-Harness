import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { createPlatformCapabilities } from "../src/platform.ts";
import { basename, dirname, join } from "node:path";
import { platformCapabilities } from "../src/platform.ts";
import { tempDir } from "./helpers/temp-dir.ts";

describe("platform", () => {
  it("securePath chmods on posix and reports the mechanism", { skip: process.platform === "win32" }, () => {
    const dir = tempDir("p1b-plat-"); const f = join(dir, "t"); writeFileSync(f, "x");
    assert.deepEqual(platformCapabilities.securePath(f, { mode: 0o600 }), { applied: true, mechanism: "chmod" });
    assert.equal(statSync(f).mode & 0o777, 0o600);
    assert.deepEqual(platformCapabilities.securePath(join(dir, "missing")), { applied: false, reason: "missing" });
  });
  it("isUnsafeLink is true for a symlink and false for a file", { skip: process.platform === "win32" }, () => {
    const dir = tempDir("p1b-plat-"); writeFileSync(join(dir, "f"), ""); symlinkSync(join(dir, "f"), join(dir, "l"));
    assert.equal(platformCapabilities.isUnsafeLink(join(dir, "l")), true);
    assert.equal(platformCapabilities.isUnsafeLink(join(dir, "f")), false);
  });
  it("ipcAddress and canonicalIdentityPath", () => {
    const a = platformCapabilities.ipcAddress("/h/.plur1bus/state");
    assert.ok(["unix-socket", "named-pipe"].includes(a.kind));
    assert.equal(platformCapabilities.canonicalIdentityPath("/a/./b/../c"), process.platform === "win32" ? "\\a\\c" : "/a/c");
  });
  it("audit: distinct state roots that share a 16-byte prefix get distinct pipe names, equal roots (any case) the same one", () => {
    const w = createPlatformCapabilities({ platform: "win32" });
    const a = w.ipcAddress("C:\\Users\\alice\\AppData\\Local\\PLUR1BUS\\state").address;
    const b = w.ipcAddress("C:\\Users\\alice\\AppData\\Local\\PLUR1BUS-2\\state").address;
    assert.notEqual(a, b);
    assert.match(a, /^\\\\\.\\pipe\\plur1bus-embed-[0-9a-f]{32}$/);
    assert.equal(w.ipcAddress("c:/users/ALICE/appdata/local/plur1bus/state/").address, w.ipcAddress("C:\\Users\\alice\\AppData\\Local\\PLUR1BUS\\state").address);
  });
  it("audit: canonicalIdentityPath ignores a trailing separator and the \\\\?\\ prefix", () => {
    const w = createPlatformCapabilities({ platform: "win32" });
    assert.equal(w.canonicalIdentityPath("C:\\Data\\X\\"), "c:\\data\\x");
    assert.equal(w.canonicalIdentityPath("\\\\?\\C:\\Data\\X"), "c:\\data\\x");
    assert.equal(w.canonicalIdentityPath("\\\\?\\UNC\\Srv\\Share\\X"), "\\\\srv\\share\\x");
    assert.equal(w.canonicalIdentityPath("C:\\"), "c:\\", "a drive root keeps its separator");
    const p = createPlatformCapabilities({ platform: "linux" });
    assert.equal(p.canonicalIdentityPath("/a/b/"), "/a/b");
    assert.equal(p.canonicalIdentityPath("/"), "/");
    assert.equal(p.canonicalIdentityPath("/Ab"), "/Ab", "POSIX stays case-sensitive");
  });
  it("audit: on macOS the identity path is NFC like the default volume, so NFD and NFC spellings are one identity", () => {
    const d = createPlatformCapabilities({ platform: "darwin" });
    assert.equal(d.canonicalIdentityPath("/Users/c/Caf\u0065\u0301"), d.canonicalIdentityPath("/Users/c/Caf\u00e9"));
  });
  it("audit: isUnsafeLink fails closed on an error other than not-found", { skip: process.platform === "win32" }, () => {
    const dir = tempDir("p1b-plat-");
    assert.equal(platformCapabilities.isUnsafeLink(join(dir, "missing")), false);
    writeFileSync(join(dir, "f"), "");
    assert.equal(platformCapabilities.isUnsafeLink(join(dir, "f", "child")), false, "ENOTDIR is a plain absence");
    assert.equal(platformCapabilities.isUnsafeLink(join(dir, "x".repeat(300))), true, "ENAMETOOLONG: cannot be vouched for");
    symlinkSync(join(dir, "b"), join(dir, "a")); symlinkSync(join(dir, "a"), join(dir, "b"));
    assert.equal(platformCapabilities.isUnsafeLink(join(dir, "a", "x")), true, "ELOOP");
  });
  // A unix socket address must fit sun_path (104 bytes on macOS, 108 on Linux, each with its NUL). ipcAddress keeps the
  // state-root address when it fits and otherwise moves to a short, private, per-user directory; the file-system tests
  // run in a temp base and need POSIX owners and modes, so they skip on a Windows host.
  const posixOnly = { skip: process.platform === "win32" };
  const euid = typeof process.geteuid === "function" ? process.geteuid() : 0;
  const fallback = () => ({ socketFallbackBase: tempDir("p1b-sock-"), euid });

  it("a unix socket path over the platform limit is detected and shortened by ipcAddress", posixOnly, () => {
    const long = "/" + "d".repeat(120);
    assert.ok(Buffer.byteLength(createPlatformCapabilities({ platform: "linux", ...fallback() }).ipcAddress(long).address) <= 107);
  });
  it("an address that fits is the state-root address, unchanged and without touching the disk", () => {
    const base = join(tmpdir(), "p1b-never-created");
    const caps = createPlatformCapabilities({ platform: "linux", socketFallbackBase: base, euid: 1 });
    const root = "/" + "d".repeat(107 - "/embedding.sock".length - 1); // exactly 107 bytes
    const a = caps.ipcAddress(root);
    assert.deepEqual(a, { kind: "unix-socket", address: `${root}/embedding.sock` });
    assert.equal(Buffer.byteLength(a.address), 107);
    assert.equal(existsSync(base), false);
  });
  it("the limit is 103 bytes on darwin and 107 elsewhere", posixOnly, () => {
    const o = fallback();
    const root = (n: number) => "/" + "d".repeat(n - "/embedding.sock".length - 1);
    const darwin = createPlatformCapabilities({ platform: "darwin", ...o }), linux = createPlatformCapabilities({ platform: "linux", ...o });
    assert.equal(darwin.ipcAddress(root(103)).address, `${root(103)}/embedding.sock`);
    assert.notEqual(darwin.ipcAddress(root(104)).address, `${root(104)}/embedding.sock`);
    assert.equal(linux.ipcAddress(root(107)).address, `${root(107)}/embedding.sock`);
    assert.notEqual(linux.ipcAddress(root(108)).address, `${root(108)}/embedding.sock`);
  });
  it("the fallback is deterministic, short, absolute, per state root and independent of the spelling", posixOnly, () => {
    const o = fallback(); const caps = createPlatformCapabilities({ platform: "darwin", ...o });
    const a = caps.ipcAddress("/" + "d".repeat(120)), again = caps.ipcAddress("/" + "d".repeat(120) + "/");
    const other = caps.ipcAddress("/" + "d".repeat(121));
    assert.equal(a.kind, "unix-socket");
    assert.deepEqual(again, a, "a trailing separator is the same state root");
    assert.notEqual(other.address, a.address);
    assert.equal(dirname(a.address), join(o.socketFallbackBase, `plur1bus-${euid}`));
    assert.match(basename(a.address), /^embedding-[0-9a-f]{32}\.sock$/);
    assert.ok(Buffer.byteLength(a.address) <= 103);
  });
  it("pinned vector: the fallback name is sha256 of the canonical state root, first 32 hex", posixOnly, () => {
    const caps = createPlatformCapabilities({ platform: "linux", ...fallback() });
    assert.equal(basename(caps.ipcAddress("/" + "d".repeat(120)).address), "embedding-da4e47513be5e3cb5619755fa2c2e7cc.sock");
  });
  it("the fallback directory is created 0700, an existing looser one of ours is tightened", posixOnly, () => {
    const o = fallback(); const caps = createPlatformCapabilities({ platform: "linux", ...o });
    const dir = dirname(caps.ipcAddress("/" + "d".repeat(120)).address);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    chmodSync(dir, 0o755);
    caps.ipcAddress("/" + "d".repeat(120));
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  });
  it("a fallback directory that is a symlink, not a directory or another user's is refused", posixOnly, () => {
    const long = "/" + "d".repeat(120);
    const link = fallback(); mkdirSync(join(link.socketFallbackBase, "target"));
    symlinkSync(join(link.socketFallbackBase, "target"), join(link.socketFallbackBase, `plur1bus-${euid}`));
    assert.throws(() => createPlatformCapabilities({ platform: "linux", ...link }).ipcAddress(long), /symlink|not a directory/);
    const file = fallback(); writeFileSync(join(file.socketFallbackBase, `plur1bus-${euid}`), "");
    assert.throws(() => createPlatformCapabilities({ platform: "linux", ...file }).ipcAddress(long), /not a directory/);
    const foreign = fallback(); mkdirSync(join(foreign.socketFallbackBase, `plur1bus-${euid + 1}`), { mode: 0o700 });
    assert.throws(() => createPlatformCapabilities({ platform: "linux", socketFallbackBase: foreign.socketFallbackBase, euid: euid + 1 }).ipcAddress(long), /belongs to uid/);
  });
  it("a fallback base so long that even the short address cannot fit is a clear error", posixOnly, () => {
    const caps = createPlatformCapabilities({ platform: "darwin", socketFallbackBase: "/" + "b".repeat(90), euid });
    assert.throws(() => caps.ipcAddress("/" + "d".repeat(120)), /socket path .* exceeds the 103-byte limit/);
  });
  it("Windows named pipes are not affected by the socket limit", () => {
    const w = createPlatformCapabilities({ platform: "win32" }).ipcAddress("C:\\" + "d".repeat(300));
    assert.equal(w.kind, "named-pipe");
    assert.match(w.address, /^\\\\\.\\pipe\\plur1bus-embed-[0-9a-f]{32}$/);
  });
});
