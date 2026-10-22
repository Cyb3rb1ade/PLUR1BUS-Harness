import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, statSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { checkAddress } from "@plur1bus/module-api";
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
  // A unix socket address must fit sun_path (104 bytes on macOS and the BSDs, 108 on Linux, each with its NUL). ipcAddress
  // keeps the state-root address when it fits and otherwise moves to a short, private, per-user directory; the
  // file-system tests run in a temp base and need POSIX owners and modes, so they skip on a Windows host.
  const posixOnly = { skip: process.platform === "win32" };
  const euid = typeof process.geteuid === "function" ? process.geteuid() : 0;
  // The fallback base lives under /tmp, not tmpdir(): macOS's per-user tmpdir is about 66 bytes, so a base made there
  // would already push <base>/plur1bus-<euid>/<name> past sun_path and ipcAddress would throw (as in admin-ops.test.ts).
  const sockBases: string[] = [];
  after(() => { for (const d of sockBases) rmSync(d, { recursive: true, force: true }); });
  // `runtimeDirBase` (where a Linux user's /run/user/<euid> lives) points at a place that does not exist unless a test
  // makes it, so these tests never depend on the host's real /run/user.
  const fallback = () => {
    const base = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "p1b-s-"));
    sockBases.push(base);
    return { socketFallbackBase: base, runtimeDirBase: join(base, "no-run-user"), euid };
  };
  /** A runtime-dir base holding `<euid>` with `mode`, like logind's /run/user/<euid>. */
  const runUser = (o: { runtimeDirBase: string }, mode = 0o700) => {
    mkdirSync(join(o.runtimeDirBase, String(euid)), { recursive: true, mode });
    chmodSync(join(o.runtimeDirBase, String(euid)), mode);
    return join(o.runtimeDirBase, String(euid), "plur1bus");
  };
  const listen = (address: string) => new Promise<net.Server>((resolve, reject) => {
    const server = net.createServer(); server.once("error", reject);
    server.listen(address, () => resolve(server));
  });
  const close = (server: net.Server) => new Promise<void>((resolve) => server.close(() => resolve()));

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
  it("the limit is 103 bytes on darwin and the BSDs and 107 on Linux", posixOnly, () => {
    const o = fallback();
    const root = (n: number) => "/" + "d".repeat(n - "/embedding.sock".length - 1);
    for (const platform of ["darwin", "freebsd", "openbsd", "netbsd"] as const) {
      const caps = createPlatformCapabilities({ platform, ...o });
      assert.equal(caps.ipcAddress(root(103)).address, `${root(103)}/embedding.sock`, `${platform}: 103 bytes fit`);
      assert.notEqual(caps.ipcAddress(root(104)).address, `${root(104)}/embedding.sock`, `${platform}: 104 bytes do not`);
    }
    const linux = createPlatformCapabilities({ platform: "linux", ...o });
    assert.equal(linux.ipcAddress(root(107)).address, `${root(107)}/embedding.sock`);
    assert.notEqual(linux.ipcAddress(root(108)).address, `${root(108)}/embedding.sock`);
  });
  it("two spellings of one state root get one address: the limit is decided on the canonical root, like the hash", posixOnly, () => {
    // macOS compares NFC and NFD as one name; the hash is over the NFC form, so the direct-or-fallback decision must be too.
    const nfc = (n: number) => "/" + "d".repeat(n - "/embedding.sock".length - 3) + "\u00e9"; // "é" is 2 bytes in NFC, 3 in NFD
    const o = fallback(); const caps = createPlatformCapabilities({ platform: "darwin", ...o });
    const fits = nfc(103), fitsNfd = fits.normalize("NFD");
    assert.equal(Buffer.byteLength(`${fits}/embedding.sock`), 103);
    assert.equal(Buffer.byteLength(`${fitsNfd}/embedding.sock`), 104, "the NFD spelling alone would not fit");
    assert.deepEqual(caps.ipcAddress(fitsNfd), caps.ipcAddress(fits));
    const tooLong = nfc(110);
    assert.deepEqual(caps.ipcAddress(tooLong.normalize("NFD")), caps.ipcAddress(tooLong));
    assert.equal(dirname(caps.ipcAddress(tooLong).address), join(o.socketFallbackBase, `plur1bus-${euid}`));
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
  it("on Linux /run/user/<euid> comes first when it exists, is ours and is 0700, with a plur1bus directory below it", posixOnly, () => {
    const o = fallback(); const dir = runUser(o);
    const a = createPlatformCapabilities({ platform: "linux", ...o }).ipcAddress("/" + "d".repeat(120));
    assert.equal(dirname(a.address), dir);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(existsSync(join(o.socketFallbackBase, `plur1bus-${euid}`)), false, "/tmp was not touched");
    assert.equal(createPlatformCapabilities({ platform: "linux", ...o }).ipcAddress("/" + "d".repeat(120)).address, a.address, "stable");
  });
  it("only Linux has a runtime directory candidate", posixOnly, () => {
    const o = fallback(); runUser(o);
    const a = createPlatformCapabilities({ platform: "darwin", ...o }).ipcAddress("/" + "d".repeat(120));
    assert.equal(dirname(a.address), join(o.socketFallbackBase, `plur1bus-${euid}`));
  });
  it("a missing or too open /run/user/<euid> is passed over for /tmp, and not tightened (it is not ours to manage)", posixOnly, () => {
    const missing = fallback();
    assert.equal(dirname(createPlatformCapabilities({ platform: "linux", ...missing }).ipcAddress("/" + "d".repeat(120)).address), join(missing.socketFallbackBase, `plur1bus-${euid}`));
    const open = fallback(); runUser(open, 0o755);
    const a = createPlatformCapabilities({ platform: "linux", ...open }).ipcAddress("/" + "d".repeat(120));
    assert.equal(dirname(a.address), join(open.socketFallbackBase, `plur1bus-${euid}`));
    assert.equal(statSync(join(open.runtimeDirBase, String(euid))).mode & 0o777, 0o755);
  });
  it("an untrustworthy plur1bus directory in /tmp is passed over for /run/user, and the other way round", posixOnly, () => {
    const long = "/" + "d".repeat(120);
    const tmpBad = fallback(); const dir = runUser(tmpBad);
    mkdirSync(join(tmpBad.socketFallbackBase, "elsewhere"));
    symlinkSync(join(tmpBad.socketFallbackBase, "elsewhere"), join(tmpBad.socketFallbackBase, `plur1bus-${euid}`));
    assert.equal(dirname(createPlatformCapabilities({ platform: "linux", ...tmpBad }).ipcAddress(long).address), dir, "a symlink under /tmp does not stop /run/user");
    const runBad = fallback(); runUser(runBad);
    writeFileSync(join(runBad.runtimeDirBase, String(euid), "plur1bus"), "");
    assert.equal(dirname(createPlatformCapabilities({ platform: "linux", ...runBad }).ipcAddress(long).address), join(runBad.socketFallbackBase, `plur1bus-${euid}`), "a file in /run/user does not stop /tmp");
  });
  it("when every candidate is refused the error names each reason", posixOnly, () => {
    const o = fallback(); const other = euid + 1; // the directories we create belong to euid, so they are foreign to `other`
    mkdirSync(join(o.runtimeDirBase, String(other)), { recursive: true, mode: 0o700 });
    mkdirSync(join(o.socketFallbackBase, `plur1bus-${other}`), { mode: 0o700 });
    assert.throws(
      () => createPlatformCapabilities({ platform: "linux", ...o, euid: other }).ipcAddress("/" + "d".repeat(120)),
      (e: Error) => /belongs to uid/.test(e.message) && e.message.includes(join(o.runtimeDirBase, String(other))) && e.message.includes(join(o.socketFallbackBase, `plur1bus-${other}`)),
    );
  });
  it("the fallback address can really be bound, reached and passes the client's trust check", posixOnly, async () => {
    for (const platform of ["linux", "darwin"] as const) {
      const o = fallback(); if (platform === "linux") runUser(o);
      const a = createPlatformCapabilities({ platform, ...o }).ipcAddress("/" + "d".repeat(120));
      assert.ok(Buffer.byteLength(a.address) <= (platform === "linux" ? 107 : 103));
      const server = await listen(a.address);
      try {
        assert.deepEqual(checkAddress(a.address), { ok: true });
        await new Promise<void>((resolve, reject) => { const c = net.connect(a.address, () => { c.end(); resolve(); }); c.once("error", reject); });
      } finally { await close(server); }
    }
  });
  it("Windows named pipes are not affected by the socket limit", () => {
    const w = createPlatformCapabilities({ platform: "win32" }).ipcAddress("C:\\" + "d".repeat(300));
    assert.equal(w.kind, "named-pipe");
    assert.match(w.address, /^\\\\\.\\pipe\\plur1bus-embed-[0-9a-f]{32}$/);
  });
});
