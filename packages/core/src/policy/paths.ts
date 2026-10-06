// D109 part 2: path canonicalisation for policy decisions (spec: basics-quality-bar-design.md §D109 "Canonicalisation").
//
// Every path argument is turned into `{ canonical, rootId }` on the REAL target, or into a typed refusal, before any
// policy check sees it. Modelled on the X1 audit rules in crates/plur1bus-ext/src/zipaudit.rs (`check_name`,
// `is_reserved_device`); deliberately a TypeScript re-implementation, not a dependency on that crate.
//
// Two layers:
//   * `checkSyntax` is pure and takes the platform as a parameter, so the Windows rules are unit-tested on every OS.
//   * `canonicalisePath` touches the file system (real-target resolution, identity, link count) and `openVerified`
//     re-checks that identity at use time (O_NOFOLLOW + dev/ino), so a swap between check and use fails closed.
//
// Allow side (roots, grants) is compared EXACTLY on the on-disk form the OS returns; the deny side is compared case-
// and NFC-folded (`foldForDeny`), so it matches more, never less.
import { constants as fsc } from "node:fs";
import { lstat, open, readdir, readlink, realpath, stat, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { homedir as osHomedir } from "node:os";
import path from "node:path";

export type RefusalReason =
  | "not-a-string" | "empty" | "too-long" | "invalid-unicode" | "control-char" | "bidi-control"
  | "backslash" | "dot-dot" | "relative-no-cwd" | "drive-relative" | "device-path" | "unc-not-allowed"
  | "short-name" | "alternate-stream" | "forbidden-char" | "trailing-dot-space" | "reserved-device-name"
  | "special-tree" | "unresolvable" | "dangling-link" | "link-loop" | "not-directory" | "no-identity"
  | "bad-root" | "root-identity-changed" | "outside-root" | "hard-link" | "deny-listed"
  | "identity-changed" | "link-swap" | "unsupported-open" | "not-found";

export interface PathRefusal { ok: false; reason: RefusalReason; detail: string }

/** POSIX `{dev, ino}` / Windows volume serial + file id. `birth` (ns) is added when the file system reports one: an inode
 *  number is recycled the moment a file is deleted, so a swap-in could otherwise reuse the checked file's identity. */
export interface Identity { dev: string; ino: string; birth?: string }

export interface PathRoot {
  id: string;
  path: string;
  /** Identity stamped when the root was confirmed; a mismatch suspends the root (`root-identity-changed`). */
  identity?: Identity;
}

/** `path`: the entry and everything below it. `name`: any segment equal to it (e.g. `.env`). */
export type DenyEntry = { path: string } | { name: string };

export type Access = "read" | "write";

export interface CanonicalPath {
  ok: true;
  /** Real path of the target (or of its deepest existing ancestor plus the not-yet-existing tail). */
  canonical: string;
  /** The most specific root containing `canonical`, or `null` (only when `requireRoot` is false, or a hard-linked write). */
  rootId: string | null;
  exists: boolean;
  /** Identity of the target when it exists, else of its nearest existing ancestor. */
  identity: Identity;
  /** Identity of the directory that holds (or would hold) the leaf. */
  parentIdentity: Identity;
  hardLinked: boolean;
  access: Access;
}

export type PathResult = CanonicalPath | PathRefusal;

export interface CanonicaliseOptions {
  /** Defaults to `process.platform`. Only the syntactic rules honour another value (tests). */
  platform?: NodeJS.Platform;
  /** Apply the Windows name rules even on POSIX (WSL drvfs, SMB mounts). Defaults to `platform === "win32"`. */
  windowsRules?: boolean;
  /** Base for relative input; it must itself be inside a root. */
  cwd?: string;
  roots: readonly PathRoot[];
  deny?: readonly DenyEntry[];
  access?: Access;
  /** Default true: a path outside every root is refused (`outside-root`). false returns `rootId: null` for the caller's approval step. */
  requireRoot?: boolean;
  /** UNC paths are refused unless true; set it only when a root itself is UNC. */
  allowUnc?: boolean;
  /** Overrides `os.homedir()` for the "home is never a root" rule. */
  home?: string;
}

const refuse = (reason: RefusalReason, detail: string): PathRefusal => ({ ok: false, reason, detail });
const isRefusal = (v: unknown): v is PathRefusal => typeof v === "object" && v !== null && (v as { ok?: unknown }).ok === false;

const MAX_PATH_UTF8 = 4096;
const MAX_SEGMENT_UTF8 = 255;
const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const CONTROL = /[\p{Cc}]/u;
const WIN_FORBIDDEN = /[<>"|?*]/u;
// 8.3 alias: up to 8 base characters with `~<digits>` (Windows may produce `~` at any base length), optional 3-char ext.
const SHORT_NAME = /^[^.]{1,6}~[0-9]+(\.[^.]{0,3})?$/u;

/** Mirrors `is_reserved_device` in zipaudit.rs, plus the console handles Windows also reserves. */
export function isReservedDeviceName(segment: string): boolean {
  const stem = (segment.split(".")[0] ?? "").replace(/ +$/u, "").toLowerCase();
  if (["con", "prn", "aux", "nul", "conin$", "conout$", "clock$"].includes(stem)) return true;
  const port = stem.startsWith("com") ? stem.slice(3) : stem.startsWith("lpt") ? stem.slice(3) : null;
  return port !== null && /^[1-9\u00b9\u00b2\u00b3]$/u.test(port);
}

export interface SyntaxOk { ok: true; windows: boolean; unc: boolean; drive: string | null; segments: string[]; absolute: boolean }

/**
 * Pure, file-system-free refusal rules. Segments come back with `.` and duplicate separators collapsed; `..` is refused
 * outright (RULING: even when it would lexically stay inside, so a rule never depends on a later normalisation).
 */
export function checkSyntax(input: unknown, o: { platform?: NodeJS.Platform; windowsRules?: boolean; allowUnc?: boolean } = {}): SyntaxOk | PathRefusal {
  if (typeof input !== "string") return refuse("not-a-string", "path must be a string");
  if (input.length === 0) return refuse("empty", "empty path");
  if (!input.isWellFormed()) return refuse("invalid-unicode", "path contains a lone surrogate");
  if (Buffer.byteLength(input, "utf8") > MAX_PATH_UTF8) return refuse("too-long", `longer than ${MAX_PATH_UTF8} bytes`);
  if (CONTROL.test(input)) return refuse("control-char", "NUL or control character");
  if (BIDI.test(input)) return refuse("bidi-control", "Unicode bidirectional control");
  const platform = o.platform ?? process.platform;
  const windows = o.windowsRules ?? platform === "win32";

  let rest = input;
  let drive: string | null = null;
  let unc = false;
  let absolute = false;
  if (windows) {
    // Mixed separators are normalised to one; every refusal below sees the normalised form.
    const n = input.replaceAll("/", "\\");
    if (/^\\\\[?.]\\/u.test(n) || /^\\\\[?.]$/u.test(n)) return refuse("device-path", "\\\\?\\ and \\\\.\\ paths are refused");
    if (/^\\\?\?\\/u.test(n)) return refuse("device-path", "NT object path");
    if (n.startsWith("\\\\")) {
      if (!o.allowUnc) return refuse("unc-not-allowed", "UNC paths are refused unless a root is UNC");
      unc = true; absolute = true; rest = n.slice(2);
    } else if (/^[A-Za-z]:/u.test(n)) {
      if (n[2] !== "\\") return refuse("drive-relative", "drive-relative path (C:foo)");
      drive = n[0]!.toUpperCase(); absolute = true; rest = n.slice(3);
    } else if (n.startsWith("\\")) {
      return refuse("drive-relative", "rooted path without a drive");
    } else {
      rest = n;
    }
  } else {
    if (input.includes("\\")) return refuse("backslash", "backslash in a POSIX path (RULING: ambiguous with a separator, refused)");
    absolute = input.startsWith("/");
  }

  const raw = rest.split(windows ? "\\" : "/");
  const segments: string[] = [];
  for (const seg of raw) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") return refuse("dot-dot", "'..' segment");
    if (Buffer.byteLength(seg, "utf8") > MAX_SEGMENT_UTF8) return refuse("too-long", `segment longer than ${MAX_SEGMENT_UTF8} bytes`);
    if (windows) {
      if (seg.includes(":")) return refuse("alternate-stream", `':' in segment ${JSON.stringify(seg)} (drive spec or NTFS stream)`);
      if (WIN_FORBIDDEN.test(seg)) return refuse("forbidden-char", `one of < > " | ? * in ${JSON.stringify(seg)}`);
      if (seg.endsWith(".") || seg.endsWith(" ")) return refuse("trailing-dot-space", `segment ${JSON.stringify(seg)} ends in a dot or space`);
      if (isReservedDeviceName(seg)) return refuse("reserved-device-name", `${JSON.stringify(seg)} is a Windows device name`);
      if (SHORT_NAME.test(seg)) return refuse("short-name", `${JSON.stringify(seg)} looks like an 8.3 short name`);
    }
    segments.push(seg);
  }
  if (segments.length === 0 && !absolute) return refuse("empty", "path has no segments");
  return { ok: true, windows, unc, drive, segments, absolute };
}

/** Absolute lexical form of a syntactically valid path. */
function assemble(s: SyntaxOk): string {
  if (s.windows) {
    if (s.unc) return `\\\\${s.segments.join("\\")}`;
    return `${s.drive}:\\${s.segments.join("\\")}`;
  }
  return `/${s.segments.join("/")}`;
}

/** Deny-side comparison key: NFC, then an upper/lower round trip so ß/ss, İ, K (Kelvin) and friends fold together. */
export function foldForDeny(s: string): string {
  return s.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");
}

/** Returns the first deny entry matching `p` (case- and NFC-folded, segment-aligned), else null. */
export function matchDeny(p: string, deny: readonly DenyEntry[]): DenyEntry | null {
  const segs = p.split(/[\\/]+/u).filter((x) => x !== "").map(foldForDeny);
  for (const e of deny) {
    if ("name" in e) {
      const n = foldForDeny(e.name);
      if (segs.includes(n)) return e;
    } else {
      const want = e.path.split(/[\\/]+/u).filter((x) => x !== "").map(foldForDeny);
      if (want.length > 0 && want.length <= segs.length && want.every((w, i) => w === segs[i])) return e;
    }
  }
  return null;
}

/** Allow-side containment: exact string comparison, whole segments only. */
export function containsExact(root: string, p: string, sep: string): boolean {
  if (p === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return p.startsWith(prefix);
}

const identityOf = (st: { dev: bigint; ino: bigint; birthtimeNs: bigint }): Identity =>
  st.birthtimeNs > 0n ? { dev: st.dev.toString(), ino: st.ino.toString(), birth: st.birthtimeNs.toString() } : { dev: st.dev.toString(), ino: st.ino.toString() };
const sameIdentity = (a: Identity, b: Identity): boolean => a.dev === b.dev && a.ino === b.ino && (a.birth === undefined || b.birth === undefined || a.birth === b.birth);

/** Windows `realpath.native` may return `\\?\C:\…` or `\\?\UNC\…`; strip it and upper-case the drive. */
function normaliseNative(p: string, windows: boolean): string {
  if (!windows) return p;
  let r = p;
  if (r.startsWith("\\\\?\\UNC\\")) r = `\\\\${r.slice(8)}`;
  else if (r.startsWith("\\\\?\\")) r = r.slice(4);
  if (/^[a-z]:/u.test(r)) r = r[0]!.toUpperCase() + r.slice(1);
  return r;
}

function specialTree(p: string, platform: NodeJS.Platform): string | null {
  if (platform === "linux") {
    if (/^\/(proc|sys|dev)(\/|$)/u.test(p)) return p.split("/")[1]!;
    if (/^\/run\/user\//u.test(p)) return "run/user";
  } else if (platform === "darwin") {
    if (/^\/dev(\/|$)/u.test(p)) return "dev";
  }
  return null;
}

type Resolved = { real: string; exists: boolean; identity: Identity; parentIdentity: Identity; hardLinked: boolean };

/** Real-target resolution. Walks up to the deepest existing ancestor; refuses dangling links and non-directories. */
async function resolveReal(abs: string, windows: boolean, platform: NodeJS.Platform): Promise<Resolved | PathRefusal> {
  const sep = windows ? "\\" : "/";
  const pp = windows ? path.win32 : path.posix;
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      const real = normaliseNative(await realpath(cur), windows);
      const st = await stat(real, { bigint: true });
      if (tail.length > 0 && !st.isDirectory()) return refuse("not-directory", `${JSON.stringify(cur)} is not a directory`);
      const id = identityOf(st);
      if (id.ino === "0") return refuse("no-identity", "the file system reports no stable file id (fail closed)");
      let parentIdentity = id; // a missing leaf: the nearest existing ancestor; a filesystem root: itself
      if (tail.length === 0) {
        const parentReal = pp.dirname(real);
        if (parentReal !== real) parentIdentity = identityOf(await stat(parentReal, { bigint: true }));
      }
      const full = tail.length === 0 ? real : real + (real.endsWith(sep) ? "" : sep) + tail.join(sep);
      const hardLinked = tail.length === 0 && st.isFile() && st.nlink > 1n;
      return { real: full, exists: tail.length === 0, identity: id, parentIdentity, hardLinked };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ELOOP") return refuse("link-loop", "symbolic link loop");
      if (code === "ENOTDIR") return refuse("not-directory", "a path component is not a directory");
      if (code !== "ENOENT") return refuse("unresolvable", `cannot resolve the path (${code ?? "error"})`);
    }
    // ENOENT: either genuinely missing, or a dangling link (realpath fails on both). A dangling link would let a later
    // create follow it to wherever it points, so it is refused rather than treated as "missing".
    try {
      const l = await lstat(cur);
      if (l.isSymbolicLink()) return refuse("dangling-link", `${JSON.stringify(cur)} is a link whose target does not exist`);
    } catch { /* really missing */ }
    const parent = pp.dirname(cur);
    if (parent === cur) return refuse("unresolvable", "no existing ancestor");
    tail.unshift(pp.basename(cur));
    cur = parent;
  }
}

interface ResolvedRoot { id: string; real: string }

async function resolveRoots(roots: readonly PathRoot[], o: { windows: boolean; platform: NodeJS.Platform; allowUnc: boolean; home: string }): Promise<ResolvedRoot[] | PathRefusal> {
  const out: ResolvedRoot[] = [];
  for (const r of roots) {
    const s = checkSyntax(r.path, { platform: o.platform, windowsRules: o.windows, allowUnc: o.allowUnc });
    if (isRefusal(s)) return refuse("bad-root", `root ${JSON.stringify(r.id)}: ${s.reason}`);
    if (!s.absolute) return refuse("bad-root", `root ${JSON.stringify(r.id)} is not absolute`);
    const res = await resolveReal(assemble(s), o.windows, o.platform);
    if (isRefusal(res)) return refuse("bad-root", `root ${JSON.stringify(r.id)}: ${res.reason}`);
    if (!res.exists) return refuse("bad-root", `root ${JSON.stringify(r.id)} does not exist`);
    if (r.identity && !sameIdentity(r.identity, res.identity)) return refuse("root-identity-changed", `root ${JSON.stringify(r.id)} was moved or replaced`);
    if (isForbiddenRoot(res.real, o.windows, o.home)) return refuse("bad-root", `root ${JSON.stringify(r.id)} is a home, drive or system tree`);
    out.push({ id: r.id, real: res.real });
  }
  return out;
}

// macOS spells /etc, /var/db and /var/root through /private; the check runs on the real path, so those are listed too.
const POSIX_SYSTEM = ["/etc", "/usr", "/System", "/Library", "/bin", "/sbin", "/boot", "/proc", "/sys", "/dev", "/private/etc", "/private/var/db", "/private/var/root"];
const WIN_SYSTEM = ["C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)", "C:\\ProgramData"];

/** Spec: home, drive roots, `/`, `/Users`, `C:\Users` and system trees are never roots. */
export function isForbiddenRoot(real: string, windows: boolean, home: string): boolean {
  const pp = windows ? path.win32 : path.posix;
  if (pp.parse(real).root === real) return true;
  const eq = (a: string, b: string) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (home && eq(real, pp.resolve(home))) return true;
  const sep = windows ? "\\" : "/";
  const fixed = windows ? ["C:\\Users", ...WIN_SYSTEM] : ["/Users", "/home", ...POSIX_SYSTEM];
  for (const f of fixed) {
    const a = windows ? real.toLowerCase() : real;
    const b = windows ? f.toLowerCase() : f;
    if (a === b || (f !== "/Users" && f !== "/home" && f !== "C:\\Users" && a.startsWith(b + sep))) return true;
  }
  return false;
}

const DENY_SCAN_CAP = 20_000;

interface DenyView { entries: DenyEntry[]; ids: Set<string>; scanOverflow: boolean }

/**
 * Deny entries are resolved the same way as the target: each `path` entry also contributes its real path (so `/tmp/x` and
 * `/private/tmp/x`, or an entry reached through a link, both match the canonical target), and the identities of the
 * files it can be aliased by are collected: a file entry's own dev/ino, and for a directory entry every regular file
 * below it with link count > 1. RULING: if a directory holds more than DENY_SCAN_CAP entries, any hard-linked target is
 * refused (fail closed). `name` entries cannot be resolved and are matched by spelling only.
 */
async function resolveDeny(deny: readonly DenyEntry[], windows: boolean, platform: NodeJS.Platform): Promise<DenyView> {
  const entries: DenyEntry[] = [...deny];
  const ids = new Set<string>();
  let scanOverflow = false;
  let budget = DENY_SCAN_CAP;
  const walk = async (dir: string): Promise<void> => {
    let names: import("node:fs").Dirent[];
    try { names = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const d of names) {
      if (budget-- <= 0) { scanOverflow = true; return; }
      const full = path.join(dir, d.name);
      if (d.isDirectory()) await walk(full);
      else if (d.isFile()) {
        try { const st = await stat(full, { bigint: true }); if (st.nlink > 1n) ids.add(`${st.dev}:${st.ino}`); } catch { /* vanished */ }
      }
    }
  };
  for (const e of deny) {
    if (!("path" in e)) continue;
    const syn = checkSyntax(e.path, { platform, windowsRules: windows, allowUnc: true });
    if (isRefusal(syn) || !syn.absolute) continue; // matched by spelling only
    const res = await resolveReal(assemble(syn), windows, platform);
    if (isRefusal(res)) continue;
    if (res.real !== e.path) entries.push({ path: res.real });
    if (!res.exists) continue;
    const st = await stat(res.real, { bigint: true });
    if (st.isFile()) ids.add(`${st.dev}:${st.ino}`);
    else if (st.isDirectory()) await walk(res.real);
  }
  return { entries, ids, scanOverflow };
}

/**
 * The policy's single entry point for a path argument. Fails closed: anything not positively inside a root (unless
 * `requireRoot: false`), on a deny-list entry, or not resolvable to a real target is a typed refusal.
 */
export async function canonicalisePath(input: string, o: CanonicaliseOptions): Promise<PathResult> {
  const platform = o.platform ?? process.platform;
  const windows = o.windowsRules ?? platform === "win32";
  const access = o.access ?? "read";
  const requireRoot = o.requireRoot ?? true;
  const allowUnc = o.allowUnc ?? false;
  const home = o.home ?? osHomedir();
  const sep = windows ? "\\" : "/";
  const denyView = await resolveDeny(o.deny ?? [], windows, platform);
  const deny = denyView.entries;

  const syn = checkSyntax(input, { platform, windowsRules: windows, allowUnc });
  if (isRefusal(syn)) return syn;

  const roots = await resolveRoots(o.roots, { windows, platform, allowUnc, home });
  if (isRefusal(roots)) return roots;

  let abs: string;
  if (syn.absolute) {
    abs = assemble(syn);
  } else {
    if (o.cwd === undefined) return refuse("relative-no-cwd", "relative path without a cwd");
    const { cwd: _cwd, ...rest } = o;
    const base = await canonicalisePath(o.cwd, { ...rest, access: "read", requireRoot: true });
    if (isRefusal(base)) return refuse(base.reason, `cwd: ${base.detail}`);
    abs = base.canonical + sep + syn.segments.join(sep);
  }

  // Deny list on the spelled path first (a link's own name may be the giveaway), then again on the real target.
  const d1 = matchDeny(abs, deny);
  if (d1) return refuse("deny-listed", "matches the credential deny-list");
  const st1 = specialTree(abs, platform);
  if (st1) return refuse("special-tree", `/${st1} is reachable only through sys.*`);

  const res = await resolveReal(abs, windows, platform);
  if (isRefusal(res)) return res;

  const d2 = matchDeny(res.real, deny);
  if (d2) return refuse("deny-listed", "the real target matches the credential deny-list");
  if (res.exists && res.hardLinked) {
    // A hard link carries no trace of the file it aliases except its identity.
    const st = await stat(res.real, { bigint: true });
    if (denyView.ids.has(`${st.dev}:${st.ino}`)) return refuse("deny-listed", "the target is a hard link to a deny-listed file");
    if (denyView.scanOverflow) return refuse("deny-listed", "hard-linked target while the deny-list scan was incomplete (fail closed)");
  }
  const st2 = specialTree(res.real, platform);
  if (st2) return refuse("special-tree", `the real target is under /${st2}`);
  if (res.real.startsWith("\\\\") && !allowUnc) return refuse("unc-not-allowed", "the real target is a UNC path");
  // Windows names are re-checked on the real target: a junction may lead into a path whose names the rules refuse.
  const rs = checkSyntax(res.real, { platform, windowsRules: windows, allowUnc: true });
  if (isRefusal(rs)) return refuse(rs.reason, `real target: ${rs.detail}`);

  let rootId: string | null = null;
  let best = -1;
  for (const r of roots) {
    if (containsExact(r.real, res.real, sep) && r.real.length > best) { rootId = r.id; best = r.real.length; }
  }
  // A write to a regular file with link count > 1 may alias a file elsewhere: treated as outside the roots.
  if (access === "write" && res.hardLinked) {
    if (requireRoot) return refuse("hard-link", "write to a hard-linked file (link count > 1)");
    rootId = null;
  }
  if (rootId === null && requireRoot) return refuse("outside-root", "the real target is outside every root");

  return { ok: true, canonical: res.real, rootId, exists: res.exists, identity: res.identity, parentIdentity: res.parentIdentity, hardLinked: res.hardLinked, access };
}

/**
 * Open a canonicalised path and verify, after the open, that it is still the file that was checked. The leaf is opened
 * without following links (`O_NOFOLLOW`; on Windows the identity and path re-checks carry the weight, RULING: Node has
 * no `FILE_FLAG_OPEN_REPARSE_POINT`). A target that did not exist is created (only when the caller passed `O_CREAT`) with `O_EXCL`, so a link or file planted
 * since the check is an error rather than a redirect. Residual race: a parent directory swapped between the pre-check
 * and the `open` call is detected after the fact (parent identity, and `/proc/self/fd` on Linux), not prevented.
 */
export async function openVerified(c: CanonicalPath, flags: number): Promise<FileHandle | PathRefusal> {
  const write = (flags & (fsc.O_WRONLY | fsc.O_RDWR | fsc.O_APPEND | fsc.O_TRUNC | fsc.O_CREAT)) !== 0;
  if (write && c.access !== "write") return refuse("unsupported-open", "canonicalised for read, opened for write");
  const windows = process.platform === "win32";
  const pp = windows ? path.win32 : path.posix;
  let f = flags | (fsc.O_NOFOLLOW ?? 0);
  // Only an explicit O_CREAT creates, and then exclusively; a read of a missing file stays ENOENT (`not-found`).
  if (!c.exists && (flags & fsc.O_CREAT) !== 0) f |= fsc.O_EXCL;
  if (c.exists && (f & fsc.O_CREAT) !== 0) f &= ~fsc.O_CREAT;

  const parent = pp.dirname(c.canonical);
  const checkParent = async (): Promise<PathRefusal | null> => {
    try {
      const real = normaliseNative(await realpath(parent), windows);
      if (real !== parent) return refuse("identity-changed", "the parent directory path now resolves elsewhere");
      const pst = identityOf(await stat(parent, { bigint: true }));
      const want = c.exists ? c.parentIdentity : c.identity; // a missing leaf: `identity` is the nearest existing ancestor
      if (!c.exists && pp.dirname(c.canonical) !== c.canonical && !sameIdentity(pst, want)) return refuse("identity-changed", "the parent directory was replaced");
      if (c.exists && !sameIdentity(pst, want)) return refuse("identity-changed", "the parent directory was replaced");
      return null;
    } catch { return c.exists ? refuse("identity-changed", "the parent directory is gone") : refuse("not-found", "the target's parent does not exist"); }
  };
  const pre = await checkParent();
  if (pre) return pre;

  // Windows: libuv maps O_CREAT|O_EXCL to CREATE_NEW, which follows a dangling symbolic link and creates its target
  // (O_NOFOLLOW does not exist there). A missing leaf is therefore re-checked with lstat right before the create, so a
  // link planted since the check is refused without creating anything; the narrow window after the lstat is closed by
  // the post-open check below.
  const creating = windows && !c.exists && (f & fsc.O_CREAT) !== 0;
  if (creating) {
    const planted = await lstat(c.canonical).catch(() => null);
    if (planted) return refuse(planted.isSymbolicLink() ? "link-swap" : "identity-changed", "the target appeared since it was checked");
  }

  let fh: FileHandle;
  try {
    fh = await open(c.canonical, f);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EMLINK") return refuse("link-swap", "the leaf is now a symbolic link");
    if (code === "EEXIST") return refuse("identity-changed", "the target appeared since it was checked");
    if (code === "ENOENT") return refuse(c.exists ? "identity-changed" : "not-found", c.exists ? "the target or its parent vanished" : "the target does not exist");
    return refuse("unresolvable", `open failed (${code ?? "error"})`);
  }
  const fail = async (r: PathRefusal): Promise<PathRefusal> => { await fh.close().catch(() => {}); return r; };
  if (creating) {
    // The file was just created exclusively by this call. If the leaf now is a link (planted in the lstat/open window),
    // the create went through it: remove what this call made at the real location and refuse.
    const lst = await lstat(c.canonical).catch(() => null);
    if (!lst || lst.isSymbolicLink()) {
      const through = await realpath(c.canonical).catch(() => null);
      await fh.close().catch(() => {});
      if (through !== null) await unlink(through).catch(() => {});
      return refuse("link-swap", "the create went through a link planted since the check; the created file was removed");
    }
  }
  try {
    const st = await fh.stat({ bigint: true });
    const id = identityOf(st);
    if (c.exists && !sameIdentity(id, c.identity)) return await fail(refuse("identity-changed", "the opened file is not the one that was checked"));
    if (write && st.isFile() && st.nlink > 1n && !c.hardLinked) return await fail(refuse("hard-link", "the file gained a hard link since it was checked"));
    const post = await checkParent();
    if (post) return await fail(post);
    if (process.platform === "linux") {
      const now = await readlink(`/proc/self/fd/${fh.fd}`).catch(() => null);
      if (now !== null && now.replace(/ \(deleted\)$/u, "") !== c.canonical) return await fail(refuse("identity-changed", "the opened file lives at a different path than the one checked"));
    }
  } catch {
    return await fail(refuse("identity-changed", "post-open verification failed"));
  }
  return fh;
}

export { isRefusal as isPathRefusal };
