// Parity vectors (mode V, differential) for the file-system half of the D109 path layer (P4-K K2, plan P4-21):
// `canonicalisePath` and `openVerified` of `packages/core/src/policy/paths.ts`. `crates/plur1bus-core/src/policy/fs_vectors.rs`
// replays every case. Recorded, never edited by hand.
//
// Differential: each case describes a small file tree (directories, files, symbolic and hard links, FIFOs) and a list of
// steps (canonicalise, open, change the tree, read a file back, list a directory). The exporter builds the tree in a fresh
// temporary directory and runs the steps against the TypeScript functions; the Rust replay builds the same tree from the same
// description and must give the same answers. Paths in the file are written with placeholders, because the temporary
// directory has another name on every run: `$ROOT` is the real path of the case directory (on macOS below `/private`) and
// `$TMP` the same directory as the temporary-directory variable spells it (on macOS through `/var`, elsewhere the same).
// Identities (device, inode, birth time) differ per run and are not recorded; what they decide is.
//
// Operating system: the answers are those of the file system the exporter ran on, so the file is named after it
// (`darwin.json`, the only one recorded). A case marked `portable: false` depends on that file system (case and Unicode
// normalisation insensitivity, path length limits, permission bits); the Rust replay runs it only on the recording system
// and counts the rest. On another system this exporter neither writes nor compares the file, and says so.
//
// A FIFO is canonicalised but never opened here: `openVerified` blocks on it (K2-D6 in the ledger of P4-K).
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/parity/export-policy-fs.ts [--check]
import { execFileSync } from "node:child_process";
import { constants as fsc, chmodSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalisePath, openVerified, type CanonicalPath, type PathResult } from "../../packages/core/src/policy/paths.ts";
import { exporterMain } from "./lib.mjs";

export const RECORDED_ON = "darwin";

type Op =
  | { mkdir: string } | { file: string; text: string } | { symlink: string; target: string } | { link: string; to: string }
  | { fifo: string } | { rm: string } | { rename: string; to: string } | { chmod: string; mode: number };
type RootSpec = { id: string; path: string; identity?: { dev: string; ino: string } | { fromStep: number } };
type Opts = { roots?: RootSpec[]; cwd?: string; deny?: unknown; access?: "read" | "write"; requireRoot?: boolean; home?: string; scanCap?: number };
type Flag = "O_RDONLY" | "O_WRONLY" | "O_RDWR" | "O_APPEND" | "O_TRUNC" | "O_CREAT" | "O_EXCL";
type Step =
  | { op: "canon"; input: string; options?: Opts }
  | { op: "open"; of: number; flags: Flag[] }
  | { op: "fs"; do: Op[] }
  | { op: "read"; path: string }
  | { op: "list"; path: string };
type Case = { name: string; portable?: boolean; tree?: Op[]; steps: Step[]; divergence?: string };

// The tree of `paths.test.ts`: a root with a file and a subdirectory, and a directory outside it with a secret.
const BASE: Op[] = [
  { mkdir: "root/sub" }, { mkdir: "outside" }, { file: "root/file.txt", text: "inside" }, { file: "root/sub/deep.txt", text: "deep" },
  { file: "outside/secret.txt", text: "outside-secret" },
];
const WS: RootSpec[] = [{ id: "ws", path: "$ROOT/root" }];
const c = (input: string, options: Opts = {}): Step => ({ op: "canon", input, options });
const open = (of: number, ...flags: Flag[]): Step => ({ op: "open", of, flags });
const fsDo = (...ops: Op[]): Step => ({ op: "fs", do: ops });
const read = (path: string): Step => ({ op: "read", path });
const list = (path: string): Step => ({ op: "list", path });

const CASES: Case[] = [
  // --- conformance (paths.test.ts "conformance (every OS)") ---------------------------------------------------------------
  { name: "existing-file", steps: [c("$ROOT/root/file.txt"), open(0, "O_RDONLY"), open(0, "O_WRONLY"), open(0, "O_RDWR"), open(0, "O_RDONLY", "O_APPEND")] },
  { name: "relative-cwd", steps: [c("deep.txt", { cwd: "$ROOT/root/sub" }), c("deep.txt"), c("x", { cwd: "$ROOT/outside" }), c("./sub//deep.txt", { cwd: "$ROOT/root" }), c("x", { cwd: "$ROOT/root/nope" }), c("x", { cwd: "rel" })] },
  { name: "missing-tail", steps: [c("$ROOT/root/sub/new/deeper/f.txt", { access: "write" }), open(0, "O_WRONLY", "O_CREAT"), list("$ROOT/root/sub"), c("$ROOT/root/sub/new.txt", { access: "write" }), open(3, "O_WRONLY", "O_CREAT"), read("$ROOT/root/sub/new.txt")] },
  { name: "dot-and-separators", steps: [c("$ROOT/root/./sub//deep.txt"), c("$ROOT/root/sub/"), c("$ROOT//root")] },
  { name: "outside-root", steps: [c("$ROOT/outside/secret.txt"), c("$ROOT/outside/secret.txt", { requireRoot: false }), c("$ROOT/outside/new.txt", { requireRoot: false, access: "write" })] },
  { name: "nested-roots", steps: [c("$ROOT/root/sub/deep.txt", { roots: [{ id: "outer", path: "$ROOT/root" }, { id: "inner", path: "$ROOT/root/sub" }] }), c("$ROOT/root/file.txt", { roots: [{ id: "inner", path: "$ROOT/root/sub" }, { id: "outer", path: "$ROOT/root" }] }), c("$ROOT/root/x", { roots: [{ id: "a", path: "$ROOT/root" }, { id: "b", path: "$ROOT/root/" }] })] },
  { name: "file-as-directory", steps: [c("$ROOT/root/file.txt/x"), c("$ROOT/root/file.txt/x/y", { access: "write" })] },
  { name: "dangling-link", tree: [{ symlink: "root/dangling", target: "$ROOT/outside/does-not-exist" }], steps: [c("$ROOT/root/dangling", { access: "write" }), c("$ROOT/root/dangling"), c("$ROOT/root/dangling/x", { access: "write" })] },
  { name: "bad-roots", steps: [
    c("$ROOT/root/file.txt", { roots: [{ id: "x", path: "/" }] }), c("$ROOT/root/file.txt", { roots: [{ id: "x", path: "$ROOT/root", identity: { dev: "1", ino: "2" } }] }),
    c("$ROOT/root"), c("$ROOT/root/file.txt", { roots: [{ id: "x", path: "$ROOT/root", identity: { fromStep: 2 } }] }), c("$ROOT/root/file.txt", { roots: [{ id: "x", path: "$ROOT/missing" }] }),
    c("$ROOT/root/file.txt", { roots: [{ id: "x", path: "root" }] }), c("$ROOT/root/file.txt", { roots: [{ id: "x", path: "$ROOT/root/../root" }] }), c("$ROOT/root/file.txt", { roots: [{ id: "x", path: "$ROOT/root/file.txt" }] }),
    c("$ROOT/root/file.txt", { roots: [] }), c("$ROOT/root/file.txt", { roots: [{ id: "x", path: "$ROOT/root" }], home: "$ROOT/root" }), c("$ROOT/root/file.txt", { roots: [{ id: "x", path: "$ROOT/root\u202e" }] }),
  ] },
  { name: "deny-spelled-and-real", tree: [{ mkdir: "root/.ssh" }, { file: "root/.ssh/id", text: "k" }, { symlink: "root/innocent", target: "$ROOT/root/.ssh" }], steps: [
    c("$ROOT/root/.ssh/id", { deny: [{ path: "$ROOT/root/.ssh" }] }), c("$ROOT/root/.SSH/id", { deny: [{ path: "$ROOT/root/.ssh" }] }), c("$ROOT/root/sub/.env", { deny: [{ name: ".ENV" }], access: "write" }),
    c("$ROOT/root/innocent/id", { deny: [{ path: "$ROOT/root/.ssh" }] }), c("$ROOT/root/innocent/id", { deny: [{ name: ".ssh" }] }), c("$ROOT/root/file.txt", { deny: [{ path: "$ROOT/root/.ssh" }] }),
    c("$ROOT/root/innocent/id", { deny: [{ path: "$ROOT/root/innocent" }] }), c("$ROOT/root/file.txt", { deny: [{ path: "$ROOT/root" }] }),
  ] },
  { name: "hard-link-outside", tree: [{ link: "root/hard.txt", to: "outside/secret.txt" }], steps: [
    c("$ROOT/root/hard.txt"), c("$ROOT/root/hard.txt", { access: "write" }), c("$ROOT/root/hard.txt", { access: "write", requireRoot: false }), open(0, "O_RDONLY"), open(2, "O_WRONLY"), read("$ROOT/outside/secret.txt"),
  ] },
  { name: "create-inside", steps: [c("$ROOT/root/created.txt", { access: "write" }), open(0, "O_WRONLY", "O_CREAT"), read("$ROOT/root/created.txt"), open(0, "O_WRONLY", "O_CREAT"), c("$ROOT/root/created.txt", { access: "write" }), open(4, "O_WRONLY", "O_CREAT", "O_TRUNC"), read("$ROOT/root/created.txt")] },
  { name: "write-existing", tree: [{ file: "root/w.txt", text: "before" }], steps: [c("$ROOT/root/w.txt", { access: "write" }), open(0, "O_WRONLY", "O_TRUNC"), read("$ROOT/root/w.txt"), open(0, "O_WRONLY", "O_APPEND"), read("$ROOT/root/w.txt"), open(0, "O_RDWR"), read("$ROOT/root/w.txt")] },
  { name: "directory-not-file", tree: [{ mkdir: "root/d" }], steps: [c("$ROOT/root/d"), open(0, "O_RDONLY"), c("$ROOT/root/d", { access: "write" }), open(2, "O_WRONLY"), open(2, "O_RDONLY")] },
  { name: "fifo", tree: [{ fifo: "root/p" }], steps: [c("$ROOT/root/p"), c("$ROOT/root/p", { access: "write" }), c("$ROOT/root/p/x", { access: "write" })] },
  // --- red team: root escapes ---------------------------------------------------------------------------------------------
  { name: "dot-dot-escapes", tree: [{ symlink: "root/linkdir", target: "$ROOT/root/sub" }], steps: [
    c("$ROOT/root/../outside/secret.txt", { cwd: "$ROOT/root" }), c("$ROOT/root/sub/../../outside/secret.txt", { cwd: "$ROOT/root" }), c("../outside/secret.txt", { cwd: "$ROOT/root" }),
    c("$ROOT/root/sub/..", { cwd: "$ROOT/root" }), c("$ROOT/root/./..", { cwd: "$ROOT/root" }), c("..", { cwd: "$ROOT/root" }), c("$ROOT/root/linkdir/../file.txt"), c("linkdir/../../outside", { cwd: "$ROOT/root" }),
  ] },
  { name: "backslash-escapes", tree: [{ file: "root/a\\b", text: "bs" }, { symlink: "root/bs", target: "$ROOT/root/a\\b" }], steps: [
    c("$ROOT/root\\..\\outside\\secret.txt", { cwd: "$ROOT/root" }), c("sub\\..\\..\\outside", { cwd: "$ROOT/root" }), c("$ROOT/root/sub/..\\..\\outside/secret.txt", { cwd: "$ROOT/root" }),
    c("$ROOT/root/bs"), c("$ROOT/root/bs", { requireRoot: false }),
  ] },
  { name: "link-out-of-root", tree: [{ symlink: "root/link-file", target: "$ROOT/outside/secret.txt" }, { symlink: "root/link-dir", target: "$ROOT/outside" }], steps: [
    c("$ROOT/root/link-file"), c("$ROOT/root/link-dir/secret.txt"), c("$ROOT/root/link-dir/new.txt", { access: "write" }), list("$ROOT/outside"), c("$ROOT/root/link-file", { requireRoot: false }),
    c("$ROOT/root/link-dir", { requireRoot: false }),
  ] },
  { name: "link-inside-root", tree: [{ symlink: "root/sublink", target: "$ROOT/root/sub" }, { symlink: "root/rel", target: "sub/deep.txt" }], steps: [
    c("$ROOT/root/sublink/deep.txt"), c("$ROOT/root/rel"), open(1, "O_RDONLY"), c("$ROOT/root/sublink/fresh.txt", { access: "write" }), open(3, "O_WRONLY", "O_CREAT"), read("$ROOT/root/sub/fresh.txt"),
  ] },
  { name: "chain-and-loop", tree: [
    { symlink: "root/chain-a", target: "$ROOT/root/chain-b" }, { symlink: "root/chain-b", target: "$ROOT/root/chain-a" }, { symlink: "root/hop2", target: "$ROOT/outside/secret.txt" },
    { symlink: "root/hop1", target: "$ROOT/root/hop2" }, { symlink: "root/self", target: "self" }, { symlink: "root/in2", target: "$ROOT/root/file.txt" }, { symlink: "root/in1", target: "$ROOT/root/in2" },
  ], steps: [c("$ROOT/root/chain-a"), c("$ROOT/root/chain-a/x", { access: "write" }), c("$ROOT/root/hop1"), c("$ROOT/root/self"), c("$ROOT/root/in1"), open(4, "O_RDONLY")] },
  { name: "relative-link-target", tree: [{ symlink: "root/link-dotdot", target: "../outside" }], steps: [c("$ROOT/root/link-dotdot/secret.txt"), c("$ROOT/root/link-dotdot/secret.txt", { requireRoot: false })] },
  { name: "sibling-prefix", tree: [{ mkdir: "root-evil" }, { file: "root-evil/f", text: "x" }], steps: [c("$ROOT/root-evil/f")] },
  { name: "homoglyph-roots", tree: [{ mkdir: "root/h\u0430ve" }], steps: [
    c("$ROOT/root/have", { roots: [{ id: "h", path: "$ROOT/root/h\u0430ve" }], access: "write" }), c("$ROOT/root/h\u0430ve/f", { roots: [{ id: "h", path: "$ROOT/root/have" }], access: "write" }),
  ] },
  { name: "unicode-nfd", portable: false, tree: [{ mkdir: "root/caf\u00e9" }, { file: "root/caf\u00e9/x", text: "x" }], steps: [
    c("$ROOT/root/cafe\u0301/x", { roots: [{ id: "c", path: "$ROOT/root/caf\u00e9" }] }), c("$ROOT/root/caf\u00e9/x", { roots: [{ id: "c", path: "$ROOT/root/cafe\u0301" }] }),
  ] },
  { name: "case-insensitive-volume", portable: false, tree: [{ mkdir: "root/Docs" }, { file: "root/Docs/Note.txt", text: "n" }], steps: [
    c("$ROOT/root/docs/note.txt"), c("$ROOT/root/DOCS/NOTE.TXT", { roots: [{ id: "d", path: "$ROOT/root/Docs" }] }), c("$ROOT/root/Docs/Note.txt", { roots: [{ id: "d", path: "$ROOT/root/docs" }] }),
    c("$ROOT/root/docs/new.txt", { access: "write" }), open(3, "O_WRONLY", "O_CREAT"), list("$ROOT/root/Docs"), c("$ROOT/ROOT/file.txt"),
  ] },
  { name: "tricky-characters", steps: [c("$ROOT/root/file\u202etxt.exe"), c("$ROOT/root/file.txt\u0000.png"), c("$ROOT/root/a\u0085b"), c("$ROOT/root/a\tb", { access: "write" })] },
  { name: "long-names", tree: [{ file: `root/${"n".repeat(255)}`, text: "long" }], steps: [c(`$ROOT/root/${"n".repeat(255)}`), c(`$ROOT/root/${"n".repeat(256)}`), c(`$ROOT/root/${"é".repeat(127)}`, { access: "write" })] },
  { name: "long-path", portable: false, steps: [c(`$ROOT/root/${Array.from({ length: 6 }, () => "d".repeat(200)).join("/")}/f`, { access: "write" }), c(`$ROOT/root/${Array.from({ length: 21 }, () => "d".repeat(200)).join("/")}`)] },
  { name: "special-trees", tree: [{ symlink: "root/devlink", target: "/dev/null" }], steps: [c("/dev/null", { requireRoot: false }), c("$ROOT/root/devlink"), c("$ROOT/root/devlink", { requireRoot: false })] },
  // --- red team: swaps between check and use (sequential; the races inside one call are the Rust double's) -----------------
  { name: "swap-leaf-for-link", tree: [{ file: "root/race-leaf.txt", text: "original" }], steps: [
    c("$ROOT/root/race-leaf.txt"), fsDo({ rm: "root/race-leaf.txt" }, { symlink: "root/race-leaf.txt", target: "$ROOT/outside/secret.txt" }), open(0, "O_RDONLY"),
  ] },
  { name: "swap-leaf-for-file", tree: [{ file: "root/race-ident.txt", text: "original" }], steps: [
    c("$ROOT/root/race-ident.txt"), fsDo({ rename: "root/race-ident.txt", to: "root/kept.txt" }, { file: "root/race-ident.txt", text: "swapped-in" }), open(0, "O_RDONLY"),
  ] },
  { name: "swap-write-for-link", tree: [{ file: "root/race-write.txt", text: "original" }], steps: [
    c("$ROOT/root/race-write.txt", { access: "write" }), fsDo({ rm: "root/race-write.txt" }, { symlink: "root/race-write.txt", target: "$ROOT/outside/secret.txt" }), open(0, "O_WRONLY", "O_TRUNC"),
    read("$ROOT/outside/secret.txt"),
  ] },
  // The truncation comes after the identity check, so the other file keeps its contents (P4D-43; formerly K2-D5).
  { name: "swap-write-for-hard-link", tree: [{ file: "root/t.txt", text: "original" }], steps: [
    c("$ROOT/root/t.txt", { access: "write" }), fsDo({ rm: "root/t.txt" }, { link: "root/t.txt", to: "outside/secret.txt" }), open(0, "O_WRONLY", "O_TRUNC"), read("$ROOT/outside/secret.txt"),
  ] },
  // A target missing at the check is opened only to create it; whatever appeared there since is `not-found` (P4D-43).
  { name: "late-hard-link-without-create", steps: [
    c("$ROOT/root/late.txt", { access: "write" }), fsDo({ link: "root/late.txt", to: "outside/secret.txt" }), open(0, "O_WRONLY", "O_TRUNC"), read("$ROOT/outside/secret.txt"),
  ] },
  { name: "late-file-read-without-create", steps: [
    c("$ROOT/root/late-read.txt"), fsDo({ file: "root/late-read.txt", text: "planted" }), open(0, "O_RDONLY"),
  ] },
  { name: "planted-link-at-create", steps: [
    c("$ROOT/root/race-create.txt", { access: "write" }), fsDo({ symlink: "root/race-create.txt", target: "$ROOT/outside/planted.txt" }), open(0, "O_WRONLY", "O_CREAT"), list("$ROOT/outside"),
  ] },
  { name: "planted-file-at-create", steps: [c("$ROOT/root/race-file.txt", { access: "write" }), fsDo({ file: "root/race-file.txt", text: "planted" }), open(0, "O_WRONLY", "O_CREAT"), read("$ROOT/root/race-file.txt")] },
  { name: "swap-parent-for-link", tree: [{ mkdir: "root/swapdir" }, { file: "root/swapdir/f.txt", text: "in" }, { file: "outside/f.txt", text: "out" }], steps: [
    c("$ROOT/root/swapdir/f.txt"), fsDo({ rename: "root/swapdir", to: "root/swapdir.old" }, { symlink: "root/swapdir", target: "$ROOT/outside" }), open(0, "O_RDONLY"),
  ] },
  { name: "swap-parent-at-create", tree: [{ mkdir: "root/swapnew" }], steps: [
    c("$ROOT/root/swapnew/n.txt", { access: "write" }), fsDo({ rename: "root/swapnew", to: "root/swapnew.old" }, { symlink: "root/swapnew", target: "$ROOT/outside" }), open(0, "O_WRONLY", "O_CREAT"),
    list("$ROOT/outside"),
  ] },
  { name: "swap-parent-for-directory", tree: [{ mkdir: "root/pd" }, { file: "root/pd/f.txt", text: "in" }], steps: [
    c("$ROOT/root/pd/f.txt"), fsDo({ rename: "root/pd", to: "root/pd.old" }, { mkdir: "root/pd" }, { file: "root/pd/f.txt", text: "other" }), open(0, "O_RDONLY"),
  ] },
  { name: "parent-gone", tree: [{ mkdir: "root/gone" }, { file: "root/gone/f.txt", text: "g" }], steps: [
    c("$ROOT/root/gone/f.txt"), c("$ROOT/root/gone/new.txt", { access: "write" }), fsDo({ rm: "root/gone" }), open(0, "O_RDONLY"), open(1, "O_WRONLY", "O_CREAT"),
  ] },
  { name: "leaf-vanished", tree: [{ file: "root/v.txt", text: "v" }], steps: [c("$ROOT/root/v.txt"), fsDo({ rm: "root/v.txt" }), open(0, "O_RDONLY")] },
  { name: "gains-hard-link", tree: [{ file: "root/race-hard.txt", text: "original" }], steps: [
    c("$ROOT/root/race-hard.txt", { access: "write" }), c("$ROOT/root/race-hard.txt"), fsDo({ link: "outside/linkback.txt", to: "root/race-hard.txt" }), open(0, "O_WRONLY"), open(1, "O_RDONLY"),
  ] },
  // --- review round 1 regressions -----------------------------------------------------------------------------------------
  { name: "deny-entry-through-link", tree: [{ mkdir: "root/realdeny" }, { file: "root/realdeny/token", text: "t" }, { symlink: "alias-deny", target: "$ROOT/root/realdeny" }], steps: [
    c("$ROOT/root/realdeny/token", { deny: [{ path: "$ROOT/alias-deny" }] }), c("$ROOT/root/realdeny/new", { deny: [{ path: "$ROOT/alias-deny/new" }], access: "write" }),
    c("$ROOT/root/realdeny/token", { deny: [{ path: "$ROOT/alias-deny/missing/deeper" }] }), c("$ROOT/root/realdeny/token", { deny: [{ path: "$TMP/root/realdeny" }] }),
  ] },
  { name: "read-never-creates", tree: [], steps: [
    c("$ROOT/root/missing-read.txt"), open(0, "O_RDONLY"), c("$ROOT/root/missing-read.txt", { access: "write" }), open(2, "O_WRONLY"), c("$ROOT/root/no/such/dir/f", { access: "write" }),
    open(4, "O_WRONLY", "O_CREAT"), list("$ROOT/root"),
  ] },
  { name: "path-entry-alias", tree: [{ file: "root/single-link.txt", text: "inside" }, { link: "root/protected-alias.txt", to: "outside/secret.txt" }], steps: [
    c("$ROOT/root/single-link.txt", { deny: [{ path: "$ROOT/outside" }] }), c("$ROOT/root/protected-alias.txt", { deny: [{ path: "$ROOT/outside" }] }),
    c("$ROOT/root/protected-alias.txt", { deny: [{ path: "$ROOT/outside/secret.txt" }] }), c("$ROOT/root/protected-alias.txt", { deny: [{ path: "$ROOT/root/sub" }] }),
    c("$ROOT/root/protected-alias.txt", { deny: [{ path: "$ROOT/outside" }], scanCap: 0 }), c("$ROOT/root/protected-alias.txt", { deny: [{ path: "$ROOT/root/sub" }], scanCap: 0 }),
  ] },
  { name: "gains-protected-alias", tree: [{ file: "root/new-alias.txt", text: "inside" }], steps: [
    c("$ROOT/root/new-alias.txt", { deny: [{ path: "$ROOT/outside" }] }), fsDo({ link: "outside/new-alias.txt", to: "root/new-alias.txt" }), open(0, "O_RDONLY"),
  ] },
  { name: "name-entry-alias", tree: [{ mkdir: "root/nm" }, { file: "root/nm/.env", text: "TOKEN=1" }, { link: "root/nm/notes.txt", to: "root/nm/.env" }], steps: [
    c("$ROOT/root/nm/notes.txt", { deny: [{ name: ".env" }] }), c("$ROOT/root/nm/notes.txt", { deny: [{ name: ".npmrc" }] }), c("$ROOT/root/nm/notes.txt"),
    c("$ROOT/root/nm/notes.txt", { deny: [{ name: ".env" }], access: "write", requireRoot: false }),
  ] },
  { name: "name-entry-folded", tree: [{ mkdir: "root/fold" }, { file: "root/fold/.ENV", text: "TOKEN=2" }, { link: "root/fold/plain.txt", to: "root/fold/.ENV" }], steps: [c("$ROOT/root/fold/plain.txt", { deny: [{ name: ".env" }] })] },
  { name: "name-entry-directory", tree: [{ mkdir: "root/keys/.ssh" }, { file: "root/keys/.ssh/id_ed25519", text: "KEY" }, { link: "root/keys/innocent.txt", to: "root/keys/.ssh/id_ed25519" }], steps: [
    c("$ROOT/root/keys/innocent.txt", { deny: [{ name: ".ssh" }] }), c("$ROOT/root/keys/innocent.txt", { deny: [{ name: ".SSH" }] }),
  ] },
  { name: "name-entry-second-root", tree: [{ mkdir: "second-root" }, { file: "second-root/.env", text: "TOKEN=3" }, { link: "root/from-second.txt", to: "second-root/.env" }], steps: [
    c("$ROOT/root/from-second.txt", { roots: [...WS, { id: "two", path: "$ROOT/second-root" }], deny: [{ name: ".env" }] }), c("$ROOT/root/from-second.txt", { deny: [{ name: ".env" }] }),
  ] },
  { name: "name-entry-via-symlink", tree: [{ mkdir: "root/viasym" }, { file: "root/viasym/.env", text: "TOKEN=4" }, { link: "root/viasym/real.txt", to: "root/viasym/.env" }, { symlink: "root/viasym/sym.txt", target: "$ROOT/root/viasym/real.txt" }], steps: [
    c("$ROOT/root/viasym/sym.txt", { deny: [{ name: ".env" }] }),
  ] },
  { name: "name-entry-unprotected-links", tree: [{ file: "root/plain-a.txt", text: "x" }, { link: "root/plain-b.txt", to: "root/plain-a.txt" }], steps: [
    c("$ROOT/root/plain-b.txt", { deny: [{ name: ".env" }] }), open(0, "O_RDONLY"), c("$ROOT/root/plain-b.txt", { deny: [{ name: ".env" }], access: "write" }),
  ] },
  { name: "name-scan-cap", tree: [{ mkdir: "root/capped" }, { file: "root/capped/a", text: "a" }, { file: "root/capped/b", text: "b" }, { file: "root/capped/c", text: "c" }, { link: "root/capped/a2", to: "root/capped/a" }], steps: [
    c("$ROOT/root/capped/a2", { deny: [{ name: ".env" }], scanCap: 2, roots: [{ id: "cap", path: "$ROOT/root/capped" }] }), c("$ROOT/root/capped/b", { deny: [{ name: ".env" }], scanCap: 2, roots: [{ id: "cap", path: "$ROOT/root/capped" }] }),
    c("$ROOT/root/capped/a2", { deny: [{ name: ".env" }], scanCap: 5, roots: [{ id: "cap", path: "$ROOT/root/capped" }] }),
  ] },
  { name: "name-entry-root-below-protected", tree: [{ mkdir: "holder/.ssh/second-root" }, { file: "holder/.ssh/second-root/key", text: "KEY" }, { link: "root/from-ssh-root.txt", to: "holder/.ssh/second-root/key" }], steps: [
    c("$ROOT/root/from-ssh-root.txt", { roots: [...WS, { id: "two", path: "$ROOT/holder/.ssh/second-root" }], deny: [{ name: ".ssh" }] }),
  ] },
  { name: "name-scan-unreadable", portable: false, tree: [{ mkdir: "root/locked" }, { file: "root/lk-a.txt", text: "x" }, { link: "root/lk-b.txt", to: "root/lk-a.txt" }, { chmod: "root/locked", mode: 0o000 }], steps: [
    c("$ROOT/root/lk-b.txt", { deny: [{ name: ".env" }] }), c("$ROOT/root/lk-a.txt", { deny: [{ path: "$ROOT/root/locked" }] }), fsDo({ chmod: "root/locked", mode: 0o755 }),
  ] },
  { name: "name-entry-gains-link", tree: [{ file: "root/gain-name.txt", text: "g" }], steps: [
    c("$ROOT/root/gain-name.txt", { deny: [{ name: ".env" }] }), c("$ROOT/root/gain-name.txt"), fsDo({ link: "root/gain-name.alias", to: "root/gain-name.txt" }), open(0, "O_RDONLY"), open(1, "O_RDONLY"),
  ] },
  { name: "name-entry-swap-to-protected", tree: [{ file: "root/.env", text: "TOKEN=5" }, { file: "root/swap-env.txt", text: "harmless" }], steps: [
    c("$ROOT/root/swap-env.txt", { deny: [{ name: ".env" }] }), fsDo({ rm: "root/swap-env.txt" }, { link: "root/swap-env.txt", to: "root/.env" }), open(0, "O_RDONLY"),
  ] },
  // --- paths-hardening.test.ts --------------------------------------------------------------------------------------------
  { name: "invalid-deny-entries", steps: [
    ...[{ name: ".ssh/config" }, { name: "" }, { name: ".." }, { path: "" }, { path: "~/.ssh" }, { path: "/srv/agents/../claude" }, { path: "C:\\agents\\..\\claude" }, { path: "/srv/./claude" }, { name: 7 }, { glob: "*.pem" }, null, ".env"]
      .map((entry) => c("$ROOT/root/sub/deep.txt", { deny: [entry] })),
    c("$ROOT/root/sub/deep.txt", { deny: { name: ".env" } }), c("$ROOT/root/sub/deep.txt", { deny: [{ name: ".env" }, { path: "$ROOT/elsewhere" }] }), c("$ROOT/root/sub/deep.txt", { deny: [] }),
  ] },
  { name: "home-through-link", tree: [{ mkdir: "data/u/work" }, { file: "data/u/f.txt", text: "f" }, { file: "data/u/work/g.txt", text: "g" }, { symlink: "home-u", target: "$ROOT/data/u" }], steps: [
    c("$ROOT/data/u/f.txt", { roots: [{ id: "h", path: "$ROOT/data/u" }], home: "$ROOT/home-u" }), c("$ROOT/data/u/f.txt", { roots: [{ id: "h", path: "$ROOT/home-u" }], home: "$ROOT/data/u" }),
    c("$ROOT/data/u/f.txt", { roots: [{ id: "h", path: "$ROOT/home-u" }], home: "$ROOT/home-u" }), c("$ROOT/home-u/work/g.txt", { roots: [{ id: "w", path: "$ROOT/home-u/work" }], home: "$ROOT/home-u" }),
    c("$ROOT/data/u/f.txt", { roots: [{ id: "h", path: "$ROOT/data/u" }], home: "$ROOT/data/u/" }), c("$ROOT/data/u/f.txt", { roots: [{ id: "h", path: "$ROOT/data/u" }], home: "$ROOT/data/u/work/.." }),
  ] },
  // --- system-tree.test.ts ------------------------------------------------------------------------------------------------
  { name: "system-tree-flag", tree: [{ mkdir: "home/u/work" }, { symlink: "homelink", target: "$ROOT/home" }], steps: [
    ...["$ROOT/home/u", "/", "$ROOT/home/u/newdir/x.txt", "$ROOT/home/u/work/a.txt", "$ROOT", "$ROOT/homelink/u"].map((p) => c(p, { roots: [{ id: "ws", path: "$ROOT/home/u/work" }], requireRoot: false, home: "$ROOT/home/u" })),
    ...["$ROOT/home/u", "$ROOT/homelink/u"].map((p) => c(p, { roots: [{ id: "ws", path: "$ROOT/home/u/work" }], requireRoot: false, home: "$ROOT/homelink/u" })),
  ] },
  { name: "system-tree-etc", portable: false, steps: [c("/etc", { requireRoot: false }), c("/etc/nonexistent-p4k/x", { requireRoot: false, access: "write" })] },
  // --- macOS: the temporary directory spelled through /var (elsewhere both spellings are one, and the deny step differs) ---
  { name: "spelled-through-var", portable: false, steps: [
    c("$ROOT/root/file.txt", { roots: [{ id: "v", path: "$TMP/root" }] }), c("$TMP/root/file.txt"), c("$TMP/root/file.txt", { deny: [{ path: "$ROOT/root/file.txt" }] }),
    c("$TMP/root/new.txt", { access: "write" }), open(3, "O_WRONLY", "O_CREAT"), read("$ROOT/root/new.txt"),
  ] },
];

const FLAGS: Record<Flag, number> = { O_RDONLY: fsc.O_RDONLY, O_WRONLY: fsc.O_WRONLY, O_RDWR: fsc.O_RDWR, O_APPEND: fsc.O_APPEND, O_TRUNC: fsc.O_TRUNC, O_CREAT: fsc.O_CREAT, O_EXCL: fsc.O_EXCL };

/** Replaces the placeholders in every string of `v`. */
function fill(v: unknown, real: string, spelled: string): unknown {
  if (typeof v === "string") return v.replaceAll("$ROOT", real).replaceAll("$TMP", spelled);
  if (Array.isArray(v)) return v.map((x) => fill(x, real, spelled));
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, real, spelled)]));
  return v;
}

/** The inverse for recorded text: the real case directory first (on macOS it contains the spelled one after `/private`). */
function mask(s: string, real: string, spelled: string): string {
  const r = s.replaceAll(real, "$ROOT");
  return spelled === real ? r : r.replaceAll(spelled, "$TMP");
}

function applyOp(dir: string, op: Op, real: string, spelled: string): void {
  const at = (p: string) => join(dir, p);
  if ("mkdir" in op) mkdirSync(at(op.mkdir), { recursive: true });
  else if ("file" in op) { mkdirSync(dirname(at(op.file)), { recursive: true }); writeFileSync(at(op.file), op.text); }
  else if ("symlink" in op) symlinkSync(fill(op.target, real, spelled) as string, at(op.symlink));
  else if ("link" in op) linkSync(at(op.to), at(op.link));
  else if ("fifo" in op) execFileSync("mkfifo", [at(op.fifo)]);
  else if ("rm" in op) rmSync(at(op.rm), { recursive: true });
  else if ("rename" in op) renameSync(at(op.rename), at(op.to));
  else chmodSync(at(op.chmod), op.mode);
}

const errCode = (e: unknown): string => (e as NodeJS.ErrnoException).code ?? "error";

function projection(r: PathResult, real: string, spelled: string): Record<string, unknown> {
  if (!r.ok) return { ok: false, reason: r.reason, detail: mask(r.detail, real, spelled) };
  return { ok: true, canonical: mask(r.canonical, real, spelled), rootId: r.rootId, exists: r.exists, hardLinked: r.hardLinked, denyGuarded: r.denyGuarded, systemTree: r.systemTree, access: r.access };
}

async function runCase(k: Case): Promise<Record<string, unknown>> {
  const spelled = mkdtempSync(join(tmpdir(), "p4k-fs-"));
  const real = realpathSync(spelled);
  const results: unknown[] = [];
  const canon: (PathResult | null)[] = [];
  try {
    for (const op of [...BASE, ...(k.tree ?? [])]) applyOp(real, op, real, spelled);
    for (const step of k.steps) {
      canon.push(null);
      if (step.op === "canon") {
        const o = (step.options ?? {}) as Opts;
        const roots = (o.roots ?? WS).map((r) => {
          const id = r.identity && "fromStep" in r.identity ? (canon[r.identity.fromStep] as CanonicalPath).identity : r.identity;
          return { id: r.id, path: fill(r.path, real, spelled) as string, ...(id ? { identity: id } : {}) };
        });
        const options = { ...(fill(o, real, spelled) as Opts), roots, home: fill(o.home ?? "$ROOT/no-home", real, spelled) as string };
        const r = await canonicalisePath(fill(step.input, real, spelled) as string, options as never);
        canon[canon.length - 1] = r;
        results.push(projection(r, real, spelled));
      } else if (step.op === "open") {
        const flags = step.flags.reduce((n, f) => n | FLAGS[f], 0);
        const r = await openVerified(canon[step.of] as CanonicalPath, flags);
        if ("ok" in r) { results.push(projection(r, real, spelled)); continue; }
        const out: Record<string, unknown> = { ok: true };
        try {
          const acc = flags & (fsc.O_WRONLY | fsc.O_RDWR);
          if (acc !== fsc.O_WRONLY) { try { out.text = await r.readFile("utf8"); } catch (e) { out.readError = errCode(e); } }
          if (acc !== fsc.O_RDONLY) { try { await r.write("W"); out.wrote = true; } catch (e) { out.writeError = errCode(e); } }
        } finally { await r.close(); }
        results.push(out);
      } else if (step.op === "fs") {
        for (const op of step.do) applyOp(real, op, real, spelled);
        results.push(null);
      } else if (step.op === "read") {
        try { results.push({ text: readFileSync(fill(step.path, real, spelled) as string, "utf8") }); } catch (e) { results.push({ error: errCode(e) }); }
      } else {
        try { results.push({ names: readdirSync(fill(step.path, real, spelled) as string).sort() }); } catch (e) { results.push({ error: errCode(e) }); }
      }
    }
  } finally {
    // A case may leave a directory without permissions behind when it fails half-way; give them back before removing.
    try { execFileSync("chmod", ["-R", "u+rwx", real]); } catch { /* removal below reports what is left */ }
    rmSync(real, { recursive: true, force: true });
  }
  return { name: k.name, portable: k.portable ?? true, tree: k.tree ?? [], steps: k.steps, results, ...(k.divergence ? { divergence: k.divergence } : {}) };
}

export async function buildPolicyFsVectors() {
  if (process.platform !== RECORDED_ON) throw new Error(`the file-system path vectors are recorded on ${RECORDED_ON}, not ${process.platform}`);
  const cases = [];
  for (const k of CASES) cases.push(await runCase(k));
  return { [RECORDED_ON]: { platform: RECORDED_ON, base: BASE, cases } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.platform !== RECORDED_ON) {
    // The vectors hold the answers of this one operating system's file system; another one would record other answers.
    console.log(`skip  fixtures/parity/policy-fs/${RECORDED_ON}.json: recorded on ${RECORDED_ON}, this machine is ${process.platform}; not compared, not written`);
    process.exitCode = process.argv.includes("--check") ? 0 : 1;
  } else {
    process.exitCode = await exporterMain({ area: "policy-fs", build: buildPolicyFsVectors });
  }
}
