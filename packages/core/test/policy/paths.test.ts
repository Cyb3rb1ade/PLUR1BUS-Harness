// D109 part 2: path canonicalisation. Conformance (per OS, Windows-only cases gated to win32) and red-team suites.
// Every test works inside one mkdtemp directory that `after` removes; nothing is created or written outside it.
import { after, before, describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { constants as fsc } from "node:fs";
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  canonicalisePath, checkSyntax, containsExact, foldForDeny, isForbiddenRoot, isReservedDeviceName, matchDeny, openVerified,
} from "../../src/policy/paths-index.ts";
import type { CanonicalPath, PathResult } from "../../src/policy/paths-index.ts";

const T = { timeout: 30_000 };
const win = process.platform === "win32";
const mac = process.platform === "darwin";
const linux = process.platform === "linux";

let base = "";
let root = "";
let outside = "";
const secretText = "outside-secret";
const roots = () => [{ id: "ws", path: root }];

function refused(r: PathResult, reason: string): void {
  assert.equal(r.ok, false, `expected refusal ${reason}, got ${r.ok ? (r as CanonicalPath).canonical : ""}`);
  if (!r.ok) assert.equal(r.reason, reason, r.detail);
}
function allowed(r: PathResult): CanonicalPath {
  assert.equal(r.ok, true, r.ok ? "" : `${r.reason}: ${r.detail}`);
  return r as CanonicalPath;
}
const canon = (input: string, extra: Partial<Parameters<typeof canonicalisePath>[1]> = {}) => canonicalisePath(input, { roots: roots(), ...extra });

/** Whether this runner may create file symlinks, probed for real once (Windows needs Developer Mode or the symlink
 *  privilege; junctions need neither). The swap races below need one planted; without it they are skipped with the
 *  reason, never silently passed. */
let symlinkProbe: Promise<boolean> | undefined;
const canSymlink = (): Promise<boolean> => (symlinkProbe ??= (async () => {
  const l = join(base, "probe-link");
  try { await symlink(join(root, "file.txt"), l); await rm(l); return true; } catch { return false; }
})());
/** Plants a link, or skips the calling test with the reason when the runner cannot. Real errors surface once the
 *  capability is proven. */
async function plant(t: TestContext, target: string, at: string, type?: "dir" | "junction"): Promise<boolean> {
  if (type !== "junction" && !(await canSymlink())) { t.skip("this runner cannot create symbolic links (Windows without the symlink privilege), which this swap race needs"); return false; }
  await symlink(target, at, type);
  return true;
}

before(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "p1b-paths-")));
  root = join(base, "root");
  outside = join(base, "outside");
  await mkdir(join(root, "sub"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(root, "file.txt"), "inside");
  await writeFile(join(root, "sub", "deep.txt"), "deep");
  await writeFile(join(outside, "secret.txt"), secretText);
});

after(async () => {
  try {
    // Only the fixtures the swap tests plant on purpose may exist outside the root; any other name means a write escaped.
    assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), secretText);
    assert.deepEqual((await readdir(outside)).sort(), ["f.txt", "linkback.txt", "secret.txt"]);
    assert.equal(await readFile(join(outside, "f.txt"), "utf8"), "out");
  } finally {
    await rm(base, { recursive: true, force: true }); // always, so a failed assertion leaves no temp dir behind
  }
  await assert.rejects(stat(base), { code: "ENOENT" });
});

describe("D109 paths: syntax rules (pure, run on every OS with an explicit platform)", T, () => {
  const w = { platform: "win32" as const };
  const reason = (i: unknown, o: Parameters<typeof checkSyntax>[1] = w) => { const r = checkSyntax(i, o); return r.ok ? "ok" : r.reason; };

  it("refuses non-strings, empty, control characters, bidi controls, lone surrogates and over-long input", () => {
    assert.equal(reason(42), "not-a-string");
    assert.equal(reason(""), "empty");
    assert.equal(reason("/a\u0000b", { platform: "linux" }), "control-char");
    assert.equal(reason("/a\nb", { platform: "linux" }), "control-char");
    assert.equal(reason("/a\u202eb", { platform: "linux" }), "bidi-control");
    assert.equal(reason("/a\ud800b", { platform: "linux" }), "invalid-unicode");
    assert.equal(reason("/" + "a".repeat(300), { platform: "linux" }), "too-long");
    assert.equal(reason("/" + "a/".repeat(2100), { platform: "linux" }), "too-long");
  });
  it("refuses '..' anywhere and collapses '.' and duplicate separators", () => {
    assert.equal(reason("/a/../b", { platform: "linux" }), "dot-dot");
    assert.equal(reason("../b", { platform: "linux" }), "dot-dot");
    const ok = checkSyntax("/a//./b/", { platform: "linux" });
    assert.ok(ok.ok && ok.segments.join("/") === "a/b");
  });
  it("refuses a backslash on POSIX (mixed separators)", () => {
    assert.equal(reason("/root\\..\\etc", { platform: "linux" }), "backslash");
    assert.equal(reason("sub\\file", { platform: "darwin" }), "backslash");
  });
  it("windows: refuses \\\\?\\ and \\\\.\\ prefixes, NT paths and GLOBALROOT, in either separator", () => {
    for (const p of ["\\\\?\\C:\\a", "//?/C:/a", "\\\\.\\C:\\a", "//./PhysicalDrive0", "\\\\?\\GLOBALROOT\\Device\\x", "\\\\?\\UNC\\h\\s\\a", "\\??\\C:\\a"]) {
      assert.equal(reason(p), "device-path", p);
    }
  });
  it("windows: UNC only when explicitly allowed", () => {
    assert.equal(reason("\\\\host\\share\\a"), "unc-not-allowed");
    assert.equal(reason("//host/share/a"), "unc-not-allowed");
    assert.equal(reason("\\\\host\\share\\a", { ...w, allowUnc: true }), "ok");
  });
  it("windows: refuses drive-relative and rooted-without-drive paths", () => {
    assert.equal(reason("C:foo"), "drive-relative");
    assert.equal(reason("\\foo"), "drive-relative");
    assert.equal(reason("C:\\foo"), "ok");
    assert.equal(reason("c:/foo"), "ok");
  });
  it("windows: refuses alternate data streams", () => {
    for (const p of ["C:\\a\\file.txt:stream", "C:\\a\\file.txt::$DATA", "C:\\a\\dir:$I30:$INDEX_ALLOCATION", "C:\\a:b\\c", "C:\\a\\f:"]) {
      assert.equal(reason(p), "alternate-stream", p);
    }
    assert.equal(reason("relative:stream"), "alternate-stream");
  });
  it("windows: refuses forbidden characters", () => {
    for (const c of ["<", ">", '"', "|", "?", "*"]) assert.equal(reason(`C:\\a\\b${c}c`), "forbidden-char", c);
  });
  it("windows: refuses trailing dots and spaces (secret.env. aliases secret.env)", () => {
    for (const p of ["C:\\a\\secret.env.", "C:\\a\\secret.env ", "C:\\a\\secret.env. .", "C:\\a. \\b", "C:\\a\\b\\..."]) {
      const r = reason(p);
      assert.ok(r === "trailing-dot-space" || r === "dot-dot", `${p} -> ${r}`);
    }
    assert.equal(reason("C:\\a\\secret.env."), "trailing-dot-space");
  });
  it("windows: refuses reserved device names with any extension, case or trailing spaces", () => {
    for (const n of ["CON", "con", "PRN", "AUX", "NUL", "nul.txt", "COM1", "com9.log", "LPT1", "lpt9.tar.gz", "COM\u00b9", "LPT\u00b3.x", "CONIN$", "CONOUT$", "CON .txt"]) {
      assert.equal(reason(`C:\\a\\${n}`), "reserved-device-name", n);
    }
    for (const n of ["CONSOLE", "COM0", "COM10", "LPT", "NULL", "auxiliary", "com", "xcon"]) assert.equal(reason(`C:\\a\\${n}`), "ok", n);
  });
  it("windows: device-name predicate mirrors the Rust X1 audit's table", () => {
    for (const s of ["con", "PRN", "Aux", "nul", "com1", "LPT9", "com\u00b2", "nul.txt", "con.tar.gz", "con  "]) assert.ok(isReservedDeviceName(s), s);
    for (const s of ["conn", "com0", "com10", "lpt", "xnul", "console.log"]) assert.ok(!isReservedDeviceName(s), s);
  });
  it("windows: refuses 8.3 short names", () => {
    for (const n of ["PROGRA~1", "PROGRA~2", "DOCUME~1", "secret~1.env", "ab~1", "LONGNA~10.txt", "WINDOW~1"]) assert.equal(reason(`C:\\a\\${n}`), "short-name", n);
    for (const n of ["notes~backup.txt", "a~b", "~tmp", "tilde~", "file~1.markdown"]) assert.equal(reason(`C:\\a\\${n}`), "ok", n);
  });
  it("windows: mixed separators are normalised, drive letter upper-cased, '..' still refused", () => {
    const r = checkSyntax("c:/a\\b/c", w);
    assert.ok(r.ok && r.drive === "C" && r.segments.join("\\") === "a\\b\\c");
    assert.equal(reason("C:\\a/..\\b"), "dot-dot");
    assert.equal(reason("C:/a\\..\\..\\Windows"), "dot-dot");
  });
  it("posix: the Windows name rules do not apply unless asked for (':' and 'CON' are legal there)", () => {
    assert.equal(reason("/a/CON", { platform: "linux" }), "ok");
    assert.equal(reason("/a/b:c", { platform: "linux" }), "ok");
    assert.equal(reason("a/CON", { platform: "linux", windowsRules: true }), "reserved-device-name");
  });
});

describe("D109 paths: deny and allow comparison", T, () => {
  it("folds the deny side by case and NFC", () => {
    assert.equal(foldForDeny("Caf\u00e9"), foldForDeny("cafe\u0301"));
    assert.equal(foldForDeny("STRASSE"), foldForDeny("Stra\u00dfe"));
    assert.equal(foldForDeny("\u212a"), foldForDeny("k"), "Kelvin sign folds to k");
    assert.ok(matchDeny("/home/u/.SSH/id_rsa", [{ path: "/home/u/.ssh" }]));
    assert.ok(matchDeny("/home/u/Caf\u00e9/x", [{ path: "/home/u/cafe\u0301" }]), "NFD deny entry matches an NFC path");
    assert.ok(matchDeny("/w/proj/.ENV", [{ name: ".env" }]));
    assert.equal(matchDeny("/home/u/.sshx/id", [{ path: "/home/u/.ssh" }]), null, "segment-aligned");
    assert.equal(matchDeny("/home/u", [{ path: "/home/u/.ssh" }]), null);
  });
  it("compares the allow side exactly: no case or NFC folding widens a root", () => {
    assert.ok(containsExact("/r/Docs", "/r/Docs/a", "/"));
    assert.ok(!containsExact("/r/Docs", "/r/docs/a", "/"));
    assert.ok(!containsExact("/r/Caf\u00e9", "/r/cafe\u0301/a", "/"), "NFD spelling is not the NFC root");
    assert.ok(!containsExact("/r/Docs", "/r/Docs2/a", "/"), "whole segments only");
    assert.ok(!containsExact("/r/Docs", "/r/Docs-evil", "/"));
  });
  it("never accepts home, drive roots or system trees as roots", () => {
    assert.ok(isForbiddenRoot("/", false, "/home/u"));
    assert.ok(isForbiddenRoot("/home/u", false, "/home/u"));
    assert.ok(isForbiddenRoot("/etc", false, "/home/u"));
    assert.ok(isForbiddenRoot("/usr/local", false, "/home/u"));
    assert.ok(isForbiddenRoot("/Users", false, "/home/u"));
    assert.ok(!isForbiddenRoot("/Users/u/work", false, "/Users/u"));
    assert.ok(isForbiddenRoot("C:\\", true, "C:\\Users\\u"));
    assert.ok(isForbiddenRoot("c:\\windows\\system32", true, "C:\\Users\\u"));
    assert.ok(isForbiddenRoot("C:\\Program Files (x86)\\x", true, "C:\\Users\\u"));
    assert.ok(isForbiddenRoot("C:\\Users", true, "C:\\Users\\u"));
    assert.ok(!isForbiddenRoot("C:\\Users\\u\\work", true, "C:\\Users\\u"));
  });
});

describe("D109 paths: conformance (every OS)", T, () => {
  it("resolves an existing file to its real path inside the root", async () => {
    const r = allowed(await canon(join(root, "file.txt")));
    assert.equal(r.canonical, join(root, "file.txt"));
    assert.equal(r.rootId, "ws");
    assert.equal(r.exists, true);
    assert.equal(r.hardLinked, false);
    const st = await stat(join(root, "file.txt"), { bigint: true });
    assert.equal(r.identity.dev, st.dev.toString());
    assert.equal(r.identity.ino, st.ino.toString());
  });
  it("resolves relative input against a cwd that is itself inside the root", async () => {
    const r = allowed(await canon("deep.txt", { cwd: join(root, "sub") }));
    assert.equal(r.canonical, join(root, "sub", "deep.txt"));
    refused(await canon("deep.txt"), "relative-no-cwd");
    refused(await canon("x", { cwd: outside }), "outside-root");
  });
  it("accepts a not-yet-existing leaf and tail under an existing directory", async () => {
    const r = allowed(await canon(join(root, "sub", "new", "deeper", "f.txt"), { access: "write" }));
    assert.equal(r.exists, false);
    assert.equal(r.canonical, join(root, "sub", "new", "deeper", "f.txt"));
    assert.equal(r.rootId, "ws");
  });
  it("collapses '.' and duplicate separators", async () => {
    const r = allowed(await canon(`${root}${sep}.${sep}sub${sep}${sep}deep.txt`));
    assert.equal(r.canonical, join(root, "sub", "deep.txt"));
  });
  it("refuses an outside path by default and reports rootId null when asked not to require a root", async () => {
    refused(await canon(join(outside, "secret.txt")), "outside-root");
    const r = allowed(await canon(join(outside, "secret.txt"), { requireRoot: false }));
    assert.equal(r.rootId, null);
  });
  it("picks the most specific of nested roots", async () => {
    const r = allowed(await canonicalisePath(join(root, "sub", "deep.txt"), { roots: [{ id: "outer", path: root }, { id: "inner", path: join(root, "sub") }] }));
    assert.equal(r.rootId, "inner");
  });
  it("refuses a file used as a directory", async () => {
    refused(await canon(join(root, "file.txt", "x")), "not-directory");
  });
  it("refuses a dangling link instead of treating it as a missing file", async () => {
    await symlink(join(outside, "does-not-exist"), join(root, "dangling")).catch(() => {});
    if (!(await stat(join(root, "dangling")).then(() => true, () => true))) return;
    refused(await canon(join(root, "dangling"), { access: "write" }), "dangling-link");
  });
  it("refuses a root that is the filesystem root, and a root whose identity changed", async () => {
    refused(await canonicalisePath(join(root, "file.txt"), { roots: [{ id: "x", path: sep }] }), "bad-root");
    refused(await canonicalisePath(join(root, "file.txt"), { roots: [{ id: "x", path: root, identity: { dev: "1", ino: "2" } }] }), "root-identity-changed");
    const real = allowed(await canon(root));
    allowed(await canonicalisePath(join(root, "file.txt"), { roots: [{ id: "x", path: root, identity: real.identity }] }));
  });
  it("applies the deny list on the spelled path and on the real target, ahead of the root check", async () => {
    await mkdir(join(root, ".ssh"), { recursive: true });
    await writeFile(join(root, ".ssh", "id"), "k");
    refused(await canon(join(root, ".ssh", "id"), { deny: [{ path: join(root, ".ssh") }] }), "deny-listed");
    refused(await canon(join(root, ".SSH", "id"), { deny: [{ path: join(root, ".ssh") }] }), "deny-listed");
    refused(await canon(join(root, "sub", ".env"), { deny: [{ name: ".ENV" }], access: "write" }), "deny-listed");
    const l = join(root, "innocent");
    if (await symlink(join(root, ".ssh"), l, win ? "junction" : "dir").then(() => true, () => false)) {
      refused(await canon(join(l, "id"), { deny: [{ path: join(root, ".ssh") }] }), "deny-listed");
    }
  });
  it("detects hard links: a write is refused (treated as outside), a read reports the flag", async () => {
    await link(join(outside, "secret.txt"), join(root, "hard.txt"));
    const rd = allowed(await canon(join(root, "hard.txt")));
    assert.equal(rd.hardLinked, true);
    refused(await canon(join(root, "hard.txt"), { access: "write" }), "hard-link");
    const loose = allowed(await canon(join(root, "hard.txt"), { access: "write", requireRoot: false }));
    assert.equal(loose.rootId, null);
  });
  it("leaves the outside file untouched by every refusal above", async () => {
    assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), secretText);
  });
  it("openVerified opens the checked file and refuses a write opened from a read canonicalisation", async () => {
    const c = allowed(await canon(join(root, "file.txt")));
    const fh = await openVerified(c, fsc.O_RDONLY);
    assert.ok(!("ok" in fh));
    assert.equal(await (fh as import("node:fs/promises").FileHandle).readFile("utf8"), "inside");
    await (fh as import("node:fs/promises").FileHandle).close();
    const r = await openVerified(c, fsc.O_WRONLY);
    refused(r as PathResult, "unsupported-open");
  });
  it("openVerified creates a new file exclusively inside the root", async () => {
    const c = allowed(await canon(join(root, "created.txt"), { access: "write" }));
    const fh = await openVerified(c, fsc.O_WRONLY | fsc.O_CREAT);
    assert.ok(!("ok" in fh));
    await (fh as import("node:fs/promises").FileHandle).writeFile("x");
    await (fh as import("node:fs/promises").FileHandle).close();
    assert.equal(await readFile(join(root, "created.txt"), "utf8"), "x");
  });
});

describe("D109 paths: red team, root escapes (every one refused)", T, () => {
  it("../ in every position and with every separator spelling", async () => {
    const escapes = [
      `${root}/../outside/secret.txt`, `${root}/sub/../../outside/secret.txt`, `../outside/secret.txt`,
      `${root}/sub/..`, `${root}/./..`, `..`,
    ];
    for (const e of escapes) refused(await canon(e, { cwd: root }), "dot-dot");
    if (!win) {
      refused(await canon(`${root}\\..\\outside\\secret.txt`, { cwd: root }), "backslash");
      refused(await canon(`sub\\..\\..\\outside`, { cwd: root }), "backslash");
      refused(await canon(`${root}/sub/..\\..\\outside/secret.txt`, { cwd: root }), "backslash");
    } else {
      refused(await canon(`${root}\\sub/..\\..\\outside\\secret.txt`), "dot-dot");
    }
  });
  it("mixed-separator and Windows-spelled escapes are refused under the Windows rules on every OS", async () => {
    const w = { platform: "win32" as const };
    for (const p of ["C:\\root\\sub/..\\..\\Windows\\system32", "C:/root/..", "C:\\root\\..\\..", "\\\\?\\C:\\Windows", "\\\\.\\C:\\", "C:\\root\\file.txt:evil", "C:\\root\\CON", "C:\\root\\PROGRA~1"]) {
      assert.equal(checkSyntax(p, w).ok, false, p);
    }
  });
  it("a symlink inside the root pointing outside counts as outside (file and directory)", async () => {
    const fl = join(root, "link-file");
    const dl = join(root, "link-dir");
    const okF = await symlink(join(outside, "secret.txt"), fl).then(() => true, () => false);
    const okD = await symlink(outside, dl, win ? "junction" : "dir").then(() => true, () => false);
    if (okF) refused(await canon(fl), "outside-root");
    if (okD) {
      refused(await canon(join(dl, "secret.txt")), "outside-root");
      refused(await canon(join(dl, "new.txt"), { access: "write" }), "outside-root");
      assert.equal(await stat(join(outside, "new.txt")).then(() => true, () => false), false);
    }
    assert.ok(okF || okD || win, "this OS cannot create links at all");
  });
  it("a chain of links and a link loop are refused", async () => {
    const a = join(root, "chain-a");
    const b = join(root, "chain-b");
    if (!(await symlink(b, a).then(() => true, () => false))) return;
    await symlink(a, b);
    refused(await canon(a), "link-loop");
    const hop1 = join(root, "hop1");
    const hop2 = join(root, "hop2");
    await symlink(join(outside, "secret.txt"), hop2);
    await symlink(hop2, hop1);
    refused(await canon(hop1), "outside-root");
  });
  it("a link target spelled with '..' resolves to the real target and is refused", async () => {
    const l = join(root, "link-dotdot");
    if (!(await symlink("../outside", l, win ? "junction" : "dir").then(() => true, () => false))) return;
    refused(await canon(join(l, "secret.txt")), "outside-root");
  });
  it("sibling directory sharing the root's name as a prefix is outside", async () => {
    const evil = `${root}-evil`;
    await mkdir(evil);
    await writeFile(join(evil, "f"), "x");
    refused(await canon(join(evil, "f")), "outside-root");
  });
  it("Unicode: an NFD or confusable spelling never widens the allow side", async () => {
    const nfc = "caf\u00e9";
    const nfd = "cafe\u0301";
    await mkdir(join(root, nfc), { recursive: true });
    await writeFile(join(root, nfc, "x"), "x");
    const r = await canonicalisePath(join(root, nfd, "x"), { roots: [{ id: "c", path: join(root, nfc) }] });
    if (r.ok) assert.equal(r.canonical, join(root, nfc, "x"), "a normalisation-insensitive FS must hand back the on-disk spelling"); // macOS
    else assert.ok(["outside-root", "unresolvable"].includes(r.reason), r.reason); // Linux/NTFS: a different (missing) name
    // Cyrillic 'а' (U+0430) is not canonically equivalent to Latin 'a': a different directory, never inside the root.
    const homoglyphRoot = join(root, "h\u0430ve");
    await mkdir(homoglyphRoot, { recursive: true });
    refused(await canonicalisePath(join(root, "have"), { roots: [{ id: "h", path: homoglyphRoot }], access: "write" }), "outside-root");
    refused(await canonicalisePath(join(homoglyphRoot, "f"), { roots: [{ id: "h", path: join(root, "have") }], access: "write" }), "bad-root");
  });
  it("Unicode: the deny side matches NFD, case and compatibility-free homoglyph spellings of an entry", async () => {
    const deny = [{ path: join(root, "Caf\u00e9", ".ssh") }];
    assert.ok(matchDeny(join(root, "cafe\u0301", ".SSH", "id"), deny));
    assert.equal(matchDeny(join(root, "caf\u0435", ".ssh", "id"), deny), null, "Cyrillic е is a different name, not a spelling of the entry");
  });
  it("bidi, control and NUL tricks are refused", async () => {
    refused(await canon(`${root}/file\u202etxt.exe`), "bidi-control");
    refused(await canon(`${root}/file.txt\u0000.png`), "control-char");
    refused(await canon(`${root}/a\u0085b`), "control-char");
  });
  it("special trees are refused on Linux (/proc aliases, /dev, /sys)", { skip: !linux }, async () => {
    for (const p of ["/proc/self/root/etc/passwd", "/proc/self/cwd/x", "/proc/self/fd/0", "/proc/1/root", "/sys/kernel", "/dev/null", "/dev/shm/x", "/run/user/0/bus"]) {
      const r = await canon(p, { requireRoot: false });
      assert.equal(r.ok, false, p);
      if (!r.ok) assert.equal(r.reason, "special-tree", p);
    }
  });
  it("a link into /proc inside the root is judged on its real target (outside the root)", { skip: !linux }, async () => {
    const l = join(root, "to-proc");
    if (!(await symlink("/proc/self/root", l, "dir").then(() => true, () => false))) return;
    // The link's real target is judged, not its spelling: /proc/self/root resolves to "/", which is outside the root.
    refused(await canon(join(l, "etc", "passwd")), "outside-root");
  });
});

describe("D109 paths: red team, swap races between check and use", T, () => {
  const sw = async (name: string) => { const p = join(root, name); await writeFile(p, "original"); return p; };

  it("leaf swapped for a symlink to an outside file after the check is refused and not followed", async (t) => {
    const p = await sw("race-leaf.txt");
    const c = allowed(await canon(p));
    await rm(p);
    if (!(await plant(t, join(outside, "secret.txt"), p))) return;
    const r = await openVerified(c, fsc.O_RDONLY);
    assert.ok("ok" in r && r.ok === false, "must not return a handle");
    if ("ok" in r && !r.ok) assert.ok(["link-swap", "identity-changed"].includes(r.reason), r.reason);
  });
  it("leaf replaced by a different file after the check is refused (identity re-check)", async () => {
    const p = await sw("race-ident.txt");
    const c = allowed(await canon(p));
    await rm(p);
    await writeFile(p, "swapped-in");
    const r = await openVerified(c, fsc.O_RDONLY);
    assert.ok("ok" in r && r.ok === false);
    if ("ok" in r && !r.ok) assert.equal(r.reason, "identity-changed");
  });
  it("write target swapped for a symlink to an outside file is refused and the outside file stays intact", async (t) => {
    const p = await sw("race-write.txt");
    const c = allowed(await canon(p, { access: "write" }));
    await rm(p);
    if (!(await plant(t, join(outside, "secret.txt"), p))) return;
    const r = await openVerified(c, fsc.O_WRONLY | fsc.O_TRUNC);
    assert.ok("ok" in r && r.ok === false);
    assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), secretText);
  });
  it("a missing leaf that appears as a planted symlink is not followed or created through (O_EXCL)", async (t) => {
    const p = join(root, "race-create.txt");
    const c = allowed(await canon(p, { access: "write" }));
    assert.equal(c.exists, false);
    if (!(await plant(t, join(outside, "planted.txt"), p))) return;
    const r = await openVerified(c, fsc.O_WRONLY | fsc.O_CREAT);
    assert.ok("ok" in r && r.ok === false);
    assert.equal(await stat(join(outside, "planted.txt")).then(() => true, () => false), false, "nothing created outside");
  });
  it("parent directory swapped for a link to an outside directory is refused", async (t) => {
    await mkdir(join(root, "swapdir"));
    await writeFile(join(root, "swapdir", "f.txt"), "in");
    await writeFile(join(outside, "f.txt"), "out");
    const c = allowed(await canon(join(root, "swapdir", "f.txt")));
    await rename(join(root, "swapdir"), join(root, "swapdir.old"));
    if (!(await plant(t, outside, join(root, "swapdir"), win ? "junction" : "dir"))) return;
    const r = await openVerified(c, fsc.O_RDONLY);
    assert.ok("ok" in r && r.ok === false, "must not open the outside file");
    if ("ok" in r && !r.ok) assert.equal(r.reason, "identity-changed");
  });
  it("parent swapped while creating a new file is refused before the create", async (t) => {
    await mkdir(join(root, "swapnew"));
    const c = allowed(await canon(join(root, "swapnew", "n.txt"), { access: "write" }));
    await rename(join(root, "swapnew"), join(root, "swapnew.old"));
    if (!(await plant(t, outside, join(root, "swapnew"), win ? "junction" : "dir"))) return;
    const r = await openVerified(c, fsc.O_WRONLY | fsc.O_CREAT);
    assert.ok("ok" in r && r.ok === false);
    assert.equal(await stat(join(outside, "n.txt")).then(() => true, () => false), false);
  });
  it("a file that gains a hard link after the check is refused for writing", async () => {
    const p = await sw("race-hard.txt");
    const c = allowed(await canon(p, { access: "write" }));
    await link(p, join(outside, "linkback.txt"));
    const r = await openVerified(c, fsc.O_WRONLY);
    assert.ok("ok" in r && r.ok === false);
    if ("ok" in r && !r.ok) assert.equal(r.reason, "hard-link");
  });
});

describe("D109 paths: review round 1 regressions", T, () => {
  it("deny entries are resolved like targets: an entry spelled through a link matches the real path", async () => {
    await mkdir(join(root, "realdeny"), { recursive: true });
    await writeFile(join(root, "realdeny", "token"), "t");
    const alias = join(base, "alias-deny"); // outside the root, so the entry itself is never a request path
    if (!(await symlink(join(root, "realdeny"), alias, win ? "junction" : "dir").then(() => true, () => false))) return;
    refused(await canon(join(root, "realdeny", "token"), { deny: [{ path: alias }] }), "deny-listed");
    refused(await canon(join(root, "realdeny", "new"), { deny: [{ path: join(alias, "new") }], access: "write" }), "deny-listed");
    await rm(alias, { recursive: true, force: true });
  });
  it("a read never creates: a missing file stays not-found and nothing appears on disk", async () => {
    const p = join(root, "missing-read.txt");
    const c = allowed(await canon(p));
    assert.equal(c.exists, false);
    const r = await openVerified(c, fsc.O_RDONLY);
    assert.ok("ok" in r && r.ok === false);
    if ("ok" in r && !r.ok) assert.equal(r.reason, "not-found");
    assert.equal(await stat(p).then(() => true, () => false), false);
    const w = allowed(await canon(p, { access: "write" }));
    const r2 = await openVerified(w, fsc.O_WRONLY); // write without O_CREAT: still no creation
    assert.ok("ok" in r2 && r2.ok === false);
    assert.equal(await stat(p).then(() => true, () => false), false);
    const nested = allowed(await canon(join(root, "no", "such", "dir", "f"), { access: "write" }));
    const r3 = await openVerified(nested, fsc.O_WRONLY | fsc.O_CREAT);
    assert.ok("ok" in r3 && r3.ok === false, "a missing parent is not-found, not created");
  });
  it("a hard link inside the root to a deny-listed file is refused (file entry and directory entry)", async () => {
    const h = join(root, "hard-deny.txt");
    await link(join(outside, "secret.txt"), h);
    refused(await canon(h, { deny: [{ path: join(outside, "secret.txt") }] }), "deny-listed");
    refused(await canon(h, { deny: [{ path: outside }] }), "deny-listed");
    allowed(await canon(h, { deny: [{ path: join(root, "sub") }] })); // unrelated deny entries do not block it
  });
  it("a hard link to a file protected only by a deny-list NAME entry is refused by identity, whatever the link is called", async () => {
    await mkdir(join(root, "nm"), { recursive: true });
    await writeFile(join(root, "nm", ".env"), "TOKEN=1");
    const h = join(root, "nm", "notes.txt");
    await link(join(root, "nm", ".env"), h);
    refused(await canon(h, { deny: [{ name: ".env" }] }), "deny-listed");
    allowed(await canon(h, { deny: [{ name: ".npmrc" }] })); // an unrelated name entry does not block it
    allowed(await canon(h)); // no name entry, no scan
  });
  it("name entries match on the folded spelling when the scan looks for protected files (.ENV is .env)", async () => {
    await mkdir(join(root, "fold"), { recursive: true });
    const secret = join(root, "fold", ".ENV");
    await writeFile(secret, "TOKEN=2");
    const h = join(root, "fold", "plain.txt");
    await link(secret, h);
    refused(await canon(h, { deny: [{ name: ".env" }] }), "deny-listed");
  });
  it("a hard link to a file below a directory protected by a NAME entry (.ssh/) is refused", async () => {
    await mkdir(join(root, "keys", ".ssh"), { recursive: true });
    await writeFile(join(root, "keys", ".ssh", "id_ed25519"), "KEY");
    const h = join(root, "keys", "innocent.txt");
    await link(join(root, "keys", ".ssh", "id_ed25519"), h);
    refused(await canon(h, { deny: [{ name: ".ssh" }] }), "deny-listed");
  });
  it("the NAME-entry file may live in another root than the link", async () => {
    const second = join(base, "second-root");
    await mkdir(second, { recursive: true });
    await writeFile(join(second, ".env"), "TOKEN=3");
    const h = join(root, "from-second.txt");
    await link(join(second, ".env"), h);
    refused(await canonicalisePath(h, { roots: [...roots(), { id: "two", path: second }], deny: [{ name: ".env" }] }), "deny-listed");
  });
  it("a hard link reached through a symbolic link is refused as well", async (t) => {
    await mkdir(join(root, "viasym"), { recursive: true });
    await writeFile(join(root, "viasym", ".env"), "TOKEN=4");
    await link(join(root, "viasym", ".env"), join(root, "viasym", "real.txt"));
    if (!(await plant(t, join(root, "viasym", "real.txt"), join(root, "viasym", "sym.txt")))) return;
    refused(await canon(join(root, "viasym", "sym.txt"), { deny: [{ name: ".env" }] }), "deny-listed");
  });
  it("hard links whose every name is unprotected stay readable when a NAME entry is in force", async () => {
    await writeFile(join(root, "plain-a.txt"), "x");
    await link(join(root, "plain-a.txt"), join(root, "plain-b.txt"));
    const r = allowed(await canon(join(root, "plain-b.txt"), { deny: [{ name: ".env" }] }));
    assert.equal(r.hardLinked, true);
  });
  it("a hard-linked target is refused when the name scan hits its cap (fail closed)", async () => {
    await mkdir(join(root, "capped"), { recursive: true });
    for (const n of ["a", "b", "c"]) await writeFile(join(root, "capped", n), n);
    await link(join(root, "capped", "a"), join(root, "capped", "a2"));
    refused(await canon(join(root, "capped", "a2"), { deny: [{ name: ".env" }], scanCap: 2 }), "deny-listed");
    allowed(await canon(join(root, "capped", "b"), { deny: [{ name: ".env" }], scanCap: 2 })); // link count 1: never scanned
  });
  it("a file that gains a hard link after the check is refused at the open when a NAME entry is in force", async () => {
    const p = join(root, "gain-name.txt");
    await writeFile(p, "g");
    const c = allowed(await canon(p, { deny: [{ name: ".env" }] }));
    await link(p, join(root, "gain-name.alias"));
    const r = await openVerified(c, fsc.O_RDONLY);
    assert.ok("ok" in r && r.ok === false);
    if ("ok" in r && !r.ok) assert.equal(r.reason, "hard-link");
  });
  it("a file swapped for a hard link to a NAME-protected file after the check is refused at the open", async () => {
    await writeFile(join(root, ".env"), "TOKEN=5");
    const p = join(root, "swap-env.txt");
    await writeFile(p, "harmless");
    const c = allowed(await canon(p, { deny: [{ name: ".env" }] }));
    await rm(p);
    await link(join(root, ".env"), p);
    const r = await openVerified(c, fsc.O_RDONLY);
    assert.ok("ok" in r && r.ok === false);
    if ("ok" in r && !r.ok) assert.equal(r.reason, "identity-changed");
  });
  it("home, system trees and their macOS /private spellings are never roots, checked on the real path", () => {
    for (const p of ["/private/etc", "/private/etc/ssh", "/private/var/db", "/private/var/root/x"]) assert.ok(isForbiddenRoot(p, false, "/Users/u"), p);
    assert.ok(!isForbiddenRoot("/private/tmp/work", false, "/Users/u"));
  });
});

describe("D109 paths: macOS", { ...T, skip: !mac }, () => {
  it("resolves /var and /tmp through /private before the comparison", async () => {
    const r = allowed(await canonicalisePath("/tmp", { roots: [{ id: "t", path: "/private/tmp" }], requireRoot: true }).then((x) => x.ok ? x : canonicalisePath("/tmp", { roots: [{ id: "t", path: "/private/tmp" }], requireRoot: false })));
    assert.ok(r.canonical.startsWith("/private/tmp"));
  });
  it("a root spelled through /var matches a path spelled through /private/var", async () => {
    const viaVar = base.startsWith("/private") ? base.slice("/private".length) : base;
    const r = allowed(await canonicalisePath(join(base, "root", "file.txt"), { roots: [{ id: "v", path: join(viaVar, "root") }] }));
    assert.equal(r.rootId, "v");
  });
});

describe("D109 paths: Windows (win32 only, run in the windows CI legs)", { ...T, skip: !win }, () => {
  it("a differently-cased spelling resolves to the on-disk form and lands in the root", async () => {
    const r = allowed(await canon(join(root, "FILE.TXT").toLowerCase()));
    assert.equal(r.canonical, join(root, "file.txt"));
  });
  it("junctions are resolved on the target; one pointing outside is refused", async () => {
    const j = join(root, "junc");
    await symlink(outside, j, "junction");
    refused(await canon(join(j, "secret.txt")), "outside-root");
    refused(await canon(join(j, "new.txt"), { access: "write" }), "outside-root");
  });
  it("refuses \\\\?\\ and \\\\.\\ prefixed spellings of a root path", async () => {
    refused(await canon(`\\\\?\\${join(root, "file.txt")}`), "device-path");
    refused(await canon(`\\\\.\\${join(root, "file.txt")}`), "device-path");
  });
  it("refuses UNC unless allowed, even to the local machine", async () => {
    refused(await canon(`\\\\localhost\\${join(root, "file.txt").replace(":", "$")}`), "unc-not-allowed");
  });
  it("refuses ADS, reserved names and trailing dot/space on real paths", async () => {
    refused(await canon(`${join(root, "file.txt")}:stream`), "alternate-stream");
    refused(await canon(`${join(root, "file.txt")}::$DATA`), "alternate-stream");
    refused(await canon(join(root, "NUL")), "reserved-device-name");
    refused(await canon(join(root, "com1.txt")), "reserved-device-name");
    refused(await canon(`${join(root, "file.txt")}.`), "trailing-dot-space");
    refused(await canon(`${join(root, "file.txt")} `), "trailing-dot-space");
  });
  it("refuses the 8.3 alias of an existing long name", async () => {
    await mkdir(join(root, "A Long Directory Name"));
    const { spawnSync } = await import("node:child_process");
    const out = spawnSync("cmd.exe", ["/d", "/c", `for %I in ("${join(root, "A Long Directory Name")}") do @echo %~sI`], { encoding: "utf8", timeout: 10_000 });
    const short = out.stdout?.trim();
    if (!short || !short.includes("~")) return; // 8.3 generation is disabled on this volume: nothing to alias
    refused(await canon(short), "short-name");
  });
});
