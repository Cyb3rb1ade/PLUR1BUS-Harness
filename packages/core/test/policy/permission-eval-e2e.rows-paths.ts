// Rows: path tricks against the REAL canonicaliser (policy/paths.ts) on the real file system.
//  - Real links (symlink / junction / hard link) are created in the temp dir; where the OS will not allow it the row is skipped
//    with the reason, never faked.
//  - Windows (UNC, \\?\, ADS, 8.3, trailing dot, device names, drive-relative, case) and the POSIX special trees are exercised the way
//    paths.ts exposes them: `platform` is injected into the SYNTAX layer, which runs before any file system access. That is the only
//    thing paths.ts lets a test inject; the file-system half (realpath, identity, link counts) always runs on the host OS.
//  - Case and Unicode-normalisation rows are decided by what the host file system does (probed), since the allow side compares the
//    on-disk spelling exactly while the deny side is folded on every OS.
import { linkSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { canonicalisePath, checkSyntax } from "../../src/policy/paths-index.ts";
import {
  CAN_DIR_LINK, CAN_HARDLINK, CAN_SYMLINK, CASE_INSENSITIVE_FS, DIR_LINK_TYPE, NFC, NFD, NORMALIZATION_INSENSITIVE_FS,
  type E2ERow, type Verdict, type World,
} from "./permission-eval-e2e.fixtures.ts";

const WRITE = { content: "x" };
const NO_DIR_LINK = CAN_DIR_LINK ? undefined : "this OS/user cannot create directory links (symlink or junction) in the temp dir";
const NO_SYMLINK = CAN_SYMLINK ? undefined : "this OS/user cannot create file symlinks (Windows needs a privilege)";
const NO_HARDLINK = CAN_HARDLINK ? undefined : "this file system cannot create hard links";

const dirLink = (target: string, link: string): void => symlinkSync(target, link, DIR_LINK_TYPE);

export const FS_PATH_ROWS: E2ERow[] = [
  {
    id: "path-dir-link-out-of-root", group: "paths", what: "a link inside the root that points out of it is judged by its real target", expect: "pending", skip: NO_DIR_LINK,
    attack: async (w) => { dirLink(w.f.other, path.join(w.f.ws, "escape")); return w.probe("fs.read", path.join(w.f.ws, "escape", "b.txt")); },
    benign: async (w) => { mkdirSync(path.join(w.f.ws, "real")); writeFileSync(path.join(w.f.ws, "real", "f.txt"), "x"); dirLink(path.join(w.f.ws, "real"), path.join(w.f.ws, "alias")); return w.probe("fs.read", path.join(w.f.ws, "alias", "f.txt")); },
  },
  {
    id: "path-write-through-link-out-of-root", group: "paths", what: "creating a file through an out-of-root link asks, it is not an in-root write", expect: "pending", skip: NO_DIR_LINK,
    attack: async (w) => { dirLink(w.f.other, path.join(w.f.ws, "escape")); return w.probe("fs.write", path.join(w.f.ws, "escape", "new.txt"), WRITE); },
    benign: (w) => w.probe("fs.write", path.join(w.f.ws, "new.txt"), WRITE),
  },
  {
    id: "path-dir-link-to-denylist", group: "paths", what: "an innocent-looking link to ~/.ssh is refused by the deny-list on the real target", expect: "denied:deny-list", skip: NO_DIR_LINK,
    attack: async (w) => { dirLink(path.join(w.f.ws, ".ssh"), path.join(w.f.ws, "innocent")); return w.probe("fs.read", path.join(w.f.ws, "innocent", "id_ed25519")); },
    benign: (w) => w.probe("fs.read", w.f.wsN),
  },
  {
    id: "path-file-link-to-key", group: "paths", what: "a file symlink to a private key is refused", expect: "denied:deny-list", skip: NO_SYMLINK,
    attack: async (w) => { symlinkSync(w.f.wsKey, path.join(w.f.ws, "notes.txt")); return w.probe("fs.read", path.join(w.f.ws, "notes.txt")); },
    benign: (w) => w.probe("fs.read", w.f.wsA),
  },
  {
    id: "path-dangling-link", group: "paths", what: "a dangling link is refused (a create would follow it out of the root)", expect: "path-refused:dangling-link", skip: NO_SYMLINK,
    attack: async (w) => { symlinkSync(path.join(w.f.tmp, "nowhere", "x"), path.join(w.f.ws, "dangling")); return w.probe("fs.write", path.join(w.f.ws, "dangling"), WRITE); },
    benign: (w) => w.probe("fs.write", path.join(w.f.ws, "fresh.txt"), WRITE),
  },
  {
    id: "path-link-loop", group: "paths", what: "a link loop is refused", expect: "path-refused:link-loop", skip: NO_SYMLINK,
    attack: async (w) => { symlinkSync(path.join(w.f.ws, "l2"), path.join(w.f.ws, "l1")); symlinkSync(path.join(w.f.ws, "l1"), path.join(w.f.ws, "l2")); return w.probe("fs.read", path.join(w.f.ws, "l1")); },
    benign: (w) => w.probe("fs.read", w.f.wsA),
  },
  {
    id: "path-hard-link-to-denied-path", group: "paths", what: "a hard link to a file below a deny-listed PATH entry (browser profile) is refused by identity", expect: "denied:deny-list", skip: NO_HARDLINK,
    attack: async (w) => { linkSync(w.f.wsCookies, path.join(w.f.ws, "innocent.txt")); return w.probe("fs.read", path.join(w.f.ws, "innocent.txt")); },
    benign: async (w) => { linkSync(w.f.wsA, path.join(w.f.ws, "alias.txt")); return w.probe("fs.read", path.join(w.f.ws, "alias.txt")); },
  },
  {
    // paths.ts resolves hard-link identities only for deny-list `path` entries; a `name` entry (.env, token files by pattern) is
    // matched by spelling alone, so a hard link with another name reads the file. Reported, not fixed here: refusing every
    // hard-linked target would over-block pnpm stores. See the task report.
    id: "path-hard-link-to-name-entry", group: "paths", what: "a hard link to a file protected only by a deny-list NAME entry (.env) is refused", expect: "denied:deny-list", skip: NO_HARDLINK,
    knownGap: "paths.ts matches deny-list `name` entries by spelling only; a hard link under another name is not recognised",
    attack: async (w) => { linkSync(w.f.wsEnv, path.join(w.f.ws, "notes.txt")); return w.probe("fs.read", path.join(w.f.ws, "notes.txt")); },
    benign: async (w) => { linkSync(w.f.wsA, path.join(w.f.ws, "alias.txt")); return w.probe("fs.read", path.join(w.f.ws, "alias.txt")); },
  },
  {
    id: "path-hard-link-write-outside", group: "paths", what: "writing a file in the root that is a hard link to an outside file is not an in-root write", expect: "pending", skip: NO_HARDLINK,
    attack: async (w) => { linkSync(w.f.otherB, path.join(w.f.ws, "hl.txt")); return w.probe("fs.write", path.join(w.f.ws, "hl.txt"), WRITE); },
    benign: async (w) => { linkSync(w.f.otherB, path.join(w.f.ws, "hl.txt")); return w.probe("fs.read", path.join(w.f.ws, "hl.txt")); },
  },
  {
    id: "path-case-spellings-of-denylist", group: "paths", what: "upper-case spellings of .env, .ssh and a profile folder hit the deny-list on every OS (the deny side is case-folded)", expect: "denied:deny-list",
    attack: async (w) => {
      const spellings = [path.join(w.f.ws, ".ENV"), path.join(w.f.ws, ".Ssh", "id_ed25519"), path.join(w.f.ws, "BROWSER-PROFILE", "Default", "Cookies"), path.join(w.f.ws, "sub", ".eNv")];
      const out: Verdict[] = [];
      for (const s of spellings) out.push(await w.probe("fs.read", s));
      return { done: out.some((v) => v.done), code: out.every((v) => v.code === out[0]!.code) ? out[0]!.code : out.map((v) => v.code).join(",") };
    },
    benign: (w) => w.probe("fs.read", w.f.wsN),
  },
  {
    id: "path-case-spelling-of-root", group: "paths", what: "two spellings of one root path must not yield two canonical forms (case-insensitive FS); on a case-sensitive FS the other spelling is another, outside place", expect: /^(same-canonical|other-place-outside)$/,
    attack: async (w) => {
      const opt = { roots: w.roots, deny: w.deny, requireRoot: false, home: w.f.home } as const;
      const lower = await canonicalisePath(w.f.wsA, opt);
      const upper = await canonicalisePath(path.join(w.f.tmp, "WS", "a.txt"), opt);
      if (!lower.ok || !upper.ok) return { done: false, code: `refused:${lower.ok ? (upper as { reason: string }).reason : lower.reason}` };
      if (CASE_INSENSITIVE_FS) return { done: lower.canonical !== upper.canonical, code: lower.canonical === upper.canonical ? "same-canonical" : "spellings-diverge" };
      return { done: upper.rootId !== null, code: upper.rootId === null ? "other-place-outside" : "case-fold-into-root" };
    },
  },
  {
    id: "path-nfd-spelling-of-denylist", group: "paths", what: "a decomposed (NFD) spelling of a deny-listed name is still deny-listed (NFC fold)", expect: "denied:deny-list",
    attack: async (w) => w.probe("fs.read", path.join(w.f.ws, "tresor-e\u0301", "k.txt")),
    benign: (w) => w.probe("fs.read", path.join(w.f.ws, "tresor-e", "k.txt")),
  },
  {
    id: "path-nfc-nfd-one-canonical-form", group: "paths", what: "on a normalisation-insensitive FS the NFC and NFD spellings of one file give one canonical path", expect: "same-canonical",
    skip: NORMALIZATION_INSENSITIVE_FS ? undefined : "this file system distinguishes NFC and NFD names (no aliasing to normalise)",
    attack: async (w) => {
      writeFileSync(path.join(w.f.ws, NFC), "x");
      const opt = { roots: w.roots, deny: w.deny, requireRoot: false, home: w.f.home } as const;
      const a = await canonicalisePath(path.join(w.f.ws, NFC), opt);
      const b = await canonicalisePath(path.join(w.f.ws, NFD), opt);
      if (!a.ok || !b.ok) return { done: false, code: "refused" };
      return { done: a.canonical !== b.canonical, code: a.canonical === b.canonical ? "same-canonical" : "spellings-diverge" };
    },
  },
];

// ---- syntax rules with the platform injected (they run before any file system access) ----

const harmless = (p: NodeJS.Platform): string => (p === "win32" ? "C:\\work\\proj\\a.txt" : "/work/proj/a.txt");

interface SyntaxCase { id: string; what: string; platform: NodeJS.Platform; input: string; reason: string; allowUnc?: boolean; denyExtra?: { path: string }[] }

const SYNTAX_CASES: SyntaxCase[] = [
  { id: "win-unc-share", what: "a UNC path is refused unless a root is UNC", platform: "win32", input: "\\\\server\\share\\a.txt", reason: "unc-not-allowed" },
  { id: "win-device-path", what: "\\\\?\\C:\\ device paths are refused", platform: "win32", input: "\\\\?\\C:\\work\\a.txt", reason: "device-path" },
  { id: "win-device-path-forward-slashes", what: "//?/C:/ (forward slashes) is the same device path", platform: "win32", input: "//?/C:/work/a.txt", reason: "device-path" },
  { id: "win-device-unc", what: "\\\\?\\UNC\\server\\share is refused", platform: "win32", input: "\\\\?\\UNC\\server\\share\\a.txt", reason: "device-path" },
  { id: "win-dot-device", what: "\\\\.\\PhysicalDrive0 is refused", platform: "win32", input: "\\\\.\\PhysicalDrive0", reason: "device-path" },
  { id: "win-nt-object-path", what: "\\??\\C:\\ NT object paths are refused", platform: "win32", input: "\\??\\C:\\work\\a.txt", reason: "device-path" },
  { id: "win-ads-stream", what: "an NTFS alternate data stream is refused", platform: "win32", input: "C:\\work\\a.txt:hidden", reason: "alternate-stream" },
  { id: "win-ads-data-deny-bypass", what: ".env::$DATA (the deny-list name plus a stream) is refused", platform: "win32", input: "C:\\work\\.env::$DATA", reason: "alternate-stream" },
  { id: "win-8dot3-deny-bypass", what: "SSH~1 (the 8.3 alias of .ssh) is refused", platform: "win32", input: "C:\\Users\\c\\SSH~1\\id_rsa", reason: "short-name" },
  { id: "win-8dot3-program-files", what: "PROGRA~1 is refused", platform: "win32", input: "C:\\work\\PROGRA~1\\x", reason: "short-name" },
  { id: "win-trailing-dot-deny-bypass", what: ".env. (Windows drops the trailing dot) is refused", platform: "win32", input: "C:\\work\\.env.", reason: "trailing-dot-space" },
  { id: "win-trailing-space", what: "a trailing space in a segment is refused", platform: "win32", input: "C:\\work\\.ssh \\id_rsa", reason: "trailing-dot-space" },
  { id: "win-reserved-device-name", what: "NUL.txt (a device name with an extension) is refused", platform: "win32", input: "C:\\work\\NUL.txt", reason: "reserved-device-name" },
  { id: "win-drive-relative", what: "C:work (drive-relative) is refused", platform: "win32", input: "C:work\\a.txt", reason: "drive-relative" },
  { id: "win-dotdot-forward-slashes", what: "C:/work/../Windows is refused as '..'", platform: "win32", input: "C:/work/../Windows/x", reason: "dot-dot" },
  { id: "win-case-spelling-of-denylist", what: "C:\\USERS\\x\\.SSH and a lower-case drive hit the (case-folded) deny-list", platform: "win32", input: "c:\\Users\\X\\.SSH\\id_rsa", reason: "deny-listed" },
  { id: "win-case-spelling-of-profile-path", what: "an upper/lower-case spelling of a browser profile path hits the deny-list", platform: "win32", input: "c:\\USERS\\c\\appdata\\LOCAL\\google\\chrome\\User Data\\Default\\Cookies", reason: "deny-listed", denyExtra: [{ path: "C:\\Users\\c\\AppData\\Local\\Google\\Chrome" }] },
  { id: "win-unc-with-denylist", what: "even a permitted UNC root cannot reach a deny-listed name (any case)", platform: "win32", input: "\\\\srv\\share\\.Ssh\\k", reason: "deny-listed", allowUnc: true },
  { id: "posix-backslash", what: "a backslash in a POSIX path is refused (ambiguous with a separator)", platform: "linux", input: "/work/proj\\..\\x", reason: "backslash" },
  { id: "posix-nul-byte", what: "a NUL byte is refused", platform: "linux", input: "/work/proj/a\u0000.txt", reason: "control-char" },
  { id: "posix-bidi-control", what: "a bidirectional override in a name is refused", platform: "linux", input: "/work/proj/a\u202Etxt.exe", reason: "bidi-control" },
  { id: "posix-lone-surrogate", what: "a lone surrogate is refused", platform: "linux", input: "/work/proj/\ud800.txt", reason: "invalid-unicode" },
  { id: "posix-relative-without-cwd", what: "a relative path without a cwd is refused", platform: "linux", input: "proj/a.txt", reason: "relative-no-cwd" },
  { id: "linux-proc-tree", what: "/proc/self/environ is reachable only through sys.*", platform: "linux", input: "/proc/self/environ", reason: "special-tree" },
  { id: "linux-run-user-tree", what: "/run/user/<uid> (sockets) is refused", platform: "linux", input: "/run/user/1000/bus", reason: "special-tree" },
  { id: "darwin-dev-tree", what: "/dev/disk0 is refused on macOS", platform: "darwin", input: "/dev/disk0", reason: "special-tree" },
];

async function syntaxVerdict(w: World, c: SyntaxCase): Promise<Verdict> {
  const res = await canonicalisePath(c.input, {
    platform: c.platform, roots: [], requireRoot: false, home: w.f.home, ...(c.allowUnc ? { allowUnc: true } : {}),
    deny: [...w.deny, ...(c.denyExtra ?? [])],
  });
  return { done: res.ok, code: res.ok ? "accepted" : res.reason };
}

export const SYNTAX_PATH_ROWS: E2ERow[] = SYNTAX_CASES.map((c) => ({
  id: `path-${c.id}`, group: "paths", what: c.what, expect: c.reason,
  attack: (w: World) => syntaxVerdict(w, c),
  benign: async () => { const r = checkSyntax(harmless(c.platform), { platform: c.platform }); return { done: r.ok, code: r.ok ? "accepted" : r.reason }; },
}));
