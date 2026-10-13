// core/import fs-atomic.ts: writeAtomicSync, copyAtomicSync, isInsideDir, cleanEmptyDirs. The importer writes its snapshot, the
// ledger repair and every rollback restore through these, so the properties that matter are: a reader never sees a half-written
// target, a failure leaves the old target and no temp file behind, and containment is by whole path segment.
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { _testFsAtomicHooks, cleanEmptyDirs, copyAtomicSync, isInsideDir, writeAtomicSync } from "../../src/import/fs-atomic.ts";
import { mulberry32, useTempDirs } from "./helpers.ts";

const posixOnly = process.platform === "win32" ? "POSIX file modes and symlinks" : undefined;
const tmpDir = useTempDirs();
afterEach(() => { _testFsAtomicHooks.beforeRename = undefined; });
const listing = (d: string) => readdirSync(d).sort();

describe("writeAtomicSync", () => {
  it("creates missing parent directories and writes strings as UTF-8 and buffers byte-exact", () => {
    const d = tmpDir();
    writeAtomicSync(path.join(d, "a", "b", "c.txt"), "ünïcode ✓\n");
    assert.equal(readFileSync(path.join(d, "a", "b", "c.txt"), "utf8"), "ünïcode ✓\n");
    const bytes = Buffer.from([0, 255, 13, 10, 128, 0]);
    writeAtomicSync(path.join(d, "bin"), bytes);
    assert.deepEqual(readFileSync(path.join(d, "bin")), bytes);
  });

  it("writes empty content and replaces an existing file completely (no remnant of a longer old content)", () => {
    const d = tmpDir();
    const target = path.join(d, "t");
    writeFileSync(target, "a long previous content that is longer than the new one");
    writeAtomicSync(target, "new");
    assert.equal(readFileSync(target, "utf8"), "new");
    writeAtomicSync(target, "");
    assert.equal(statSync(target).size, 0);
  });

  it("leaves no temporary file next to the target after a success", () => {
    const d = tmpDir();
    writeAtomicSync(path.join(d, "t.json"), "{}");
    writeAtomicSync(path.join(d, "t.json"), "{\"a\":1}");
    assert.deepEqual(listing(d), ["t.json"]);
  });

  it("file mode: 0o600 by default, the given mode otherwise (masked by the umask), and new directories are private", { skip: posixOnly }, () => {
    const d = tmpDir();
    const umask = process.umask();
    writeAtomicSync(path.join(d, "new", "secret"), "x");
    assert.equal(statSync(path.join(d, "new", "secret")).mode & 0o777, 0o600 & ~umask);
    assert.equal(statSync(path.join(d, "new")).mode & 0o777, 0o700 & ~umask);
    writeAtomicSync(path.join(d, "open"), "x", 0o644);
    assert.equal(statSync(path.join(d, "open")).mode & 0o777, 0o644 & ~umask);
  });

  it("is atomic: while the temp file is complete, the target still holds the old content (or does not exist yet)", () => {
    const d = tmpDir();
    const target = path.join(d, "t");
    const seen: { tmp: string; tmpContent: string; targetContent: string | null }[] = [];
    _testFsAtomicHooks.beforeRename = (tmp, targetPath) => {
      assert.equal(targetPath, target);
      seen.push({ tmp, tmpContent: readFileSync(tmp, "utf8"), targetContent: existsSync(target) ? readFileSync(target, "utf8") : null });
    };
    writeAtomicSync(target, "first");
    writeAtomicSync(target, "second");
    assert.deepEqual(seen.map((s) => [s.tmpContent, s.targetContent]), [["first", null], ["second", "first"]]);
    for (const s of seen) {
      assert.equal(path.dirname(s.tmp), d, "the temp file is in the target's directory (same filesystem, so rename is atomic)");
      assert.ok(path.basename(s.tmp).startsWith(".t.tmp."), path.basename(s.tmp));
    }
    assert.notEqual(seen[0]!.tmp, seen[1]!.tmp, "every write uses its own temp name");
    assert.equal(readFileSync(target, "utf8"), "second");
  });

  it("a failure between write and rename keeps the old target byte-identical, removes the temp file and rethrows the same error", () => {
    const d = tmpDir();
    const target = path.join(d, "t");
    writeFileSync(target, "old-content");
    const boom = new Error("injected failure before rename");
    _testFsAtomicHooks.beforeRename = () => { throw boom; };
    assert.throws(() => writeAtomicSync(target, "new-content"), (e: unknown) => e === boom);
    assert.equal(readFileSync(target, "utf8"), "old-content");
    assert.deepEqual(listing(d), ["t"]);
  });

  it("a failure for a target that did not exist leaves neither the target nor a temp file", () => {
    const d = tmpDir();
    _testFsAtomicHooks.beforeRename = () => { throw new Error("injected"); };
    assert.throws(() => writeAtomicSync(path.join(d, "sub", "t"), "x"), /injected/);
    assert.deepEqual(listing(path.join(d, "sub")), [], "only the (empty) directory that was created for it remains");
    assert.ok(!existsSync(path.join(d, "sub", "t")));
  });

  it("the hook only runs when the temp file is complete: it sees every byte of a large payload", () => {
    const d = tmpDir();
    const SEED = 0x9a71c;
    const rnd = mulberry32(SEED);
    const payload = Buffer.from(Array.from({ length: 300_000 }, () => Math.floor(rnd() * 256)));
    let tmpSize = -1;
    _testFsAtomicHooks.beforeRename = (tmp) => { tmpSize = statSync(tmp).size; };
    writeAtomicSync(path.join(d, "big"), payload);
    assert.equal(tmpSize, payload.length, `seed=0x${SEED.toString(16)}`);
    assert.ok(readFileSync(path.join(d, "big")).equals(payload), `seed=0x${SEED.toString(16)}`);
  });

  it("errors from creating the temp file (target directory not writable, or a file in the way) propagate and leave nothing behind", { skip: posixOnly }, () => {
    const d = tmpDir();
    writeFileSync(path.join(d, "afile"), "x");
    assert.throws(() => writeAtomicSync(path.join(d, "afile", "t"), "x"), { code: "EEXIST" }, "mkdir on an existing file");
    if (process.getuid?.() !== 0) {
      mkdirSync(path.join(d, "ro"));
      chmodSync(path.join(d, "ro"), 0o500);
      try { assert.throws(() => writeAtomicSync(path.join(d, "ro", "t"), "x"), { code: "EACCES" }); } finally { chmodSync(path.join(d, "ro"), 0o700); }
      assert.deepEqual(listing(path.join(d, "ro")), []);
    }
  });

  it("renaming onto a directory fails with the OS error, removes the temp file and keeps the directory", { skip: posixOnly }, () => {
    const d = tmpDir();
    mkdirSync(path.join(d, "dir"));
    writeFileSync(path.join(d, "dir", "keep"), "k");
    assert.throws(() => writeAtomicSync(path.join(d, "dir"), "x"), (e: unknown) => ["EISDIR", "ENOTEMPTY", "EEXIST"].includes((e as NodeJS.ErrnoException).code ?? ""));
    assert.deepEqual(listing(d), ["dir"]);
    assert.equal(readFileSync(path.join(d, "dir", "keep"), "utf8"), "k");
  });

  it("writing through a symlinked target path replaces the link itself, not the file it points to", { skip: posixOnly }, () => {
    const d = tmpDir();
    const outside = path.join(d, "outside");
    writeFileSync(outside, "outside-original");
    symlinkSync(outside, path.join(d, "link"));
    writeAtomicSync(path.join(d, "link"), "replacement");
    assert.equal(readFileSync(outside, "utf8"), "outside-original", "rename replaces the directory entry; the link target is untouched");
    assert.equal(readFileSync(path.join(d, "link"), "utf8"), "replacement");
    assert.ok(!lstatSync(path.join(d, "link")).isSymbolicLink(), "the link was replaced by a regular file");
  });
});

describe("copyAtomicSync", () => {
  it("copies bytes exactly, leaves the source untouched and applies the mode", { skip: posixOnly }, () => {
    const d = tmpDir();
    const bytes = Buffer.from([1, 2, 3, 0, 255]);
    writeFileSync(path.join(d, "src"), bytes);
    const before = statSync(path.join(d, "src")).mtimeMs;
    copyAtomicSync(path.join(d, "src"), path.join(d, "out", "dst"), 0o640);
    assert.ok(readFileSync(path.join(d, "out", "dst")).equals(bytes));
    assert.ok(readFileSync(path.join(d, "src")).equals(bytes));
    assert.equal(statSync(path.join(d, "src")).mtimeMs, before);
    assert.equal(statSync(path.join(d, "out", "dst")).mode & 0o777, 0o640 & ~process.umask());
  });

  it("a missing source throws ENOENT and creates nothing", () => {
    const d = tmpDir();
    assert.throws(() => copyAtomicSync(path.join(d, "missing"), path.join(d, "out", "dst")), { code: "ENOENT" });
    assert.ok(!existsSync(path.join(d, "out")), "the source is read before any directory is created");
  });

  it("a failure in the middle keeps an existing destination", () => {
    const d = tmpDir();
    writeFileSync(path.join(d, "src"), "new");
    writeFileSync(path.join(d, "dst"), "old");
    _testFsAtomicHooks.beforeRename = () => { throw new Error("injected"); };
    assert.throws(() => copyAtomicSync(path.join(d, "src"), path.join(d, "dst")), /injected/);
    assert.equal(readFileSync(path.join(d, "dst"), "utf8"), "old");
    assert.deepEqual(listing(d), ["dst", "src"]);
  });
});

describe("isInsideDir", () => {
  it("is true for the root itself and for descendants, also for paths that do not exist", () => {
    const d = tmpDir();
    mkdirSync(path.join(d, "a", "b"), { recursive: true });
    assert.equal(isInsideDir(d, d), true);
    assert.equal(isInsideDir(d, path.join(d, "a")), true);
    assert.equal(isInsideDir(d, path.join(d, "a", "b")), true);
    assert.equal(isInsideDir(d, path.join(d, "a", "not", "there", "yet")), true);
    assert.equal(isInsideDir(d + path.sep, path.join(d, "a")), true, "a trailing separator on the root");
  });

  it("compares whole segments: a sibling that shares a name prefix is outside", () => {
    const d = tmpDir();
    mkdirSync(path.join(d, "imports"));
    mkdirSync(path.join(d, "imports-evil"));
    assert.equal(isInsideDir(path.join(d, "imports"), path.join(d, "imports-evil")), false);
    assert.equal(isInsideDir(path.join(d, "imports"), path.join(d, "imports-evil", "x")), false);
    assert.equal(isInsideDir(path.join(d, "imports"), path.join(d, "importsX")), false);
  });

  it("the parent, a sibling and an unrelated path are outside", () => {
    const d = tmpDir();
    mkdirSync(path.join(d, "root"));
    assert.equal(isInsideDir(path.join(d, "root"), d), false);
    assert.equal(isInsideDir(path.join(d, "root"), path.join(d, "other")), false);
    assert.equal(isInsideDir(path.join(d, "root"), path.parse(d).root), false);
  });

  it("'..' segments are resolved before the comparison", () => {
    const d = tmpDir();
    mkdirSync(path.join(d, "root", "sub"), { recursive: true });
    assert.equal(isInsideDir(path.join(d, "root"), path.join(d, "root", "sub", "..", "x")), true);
    assert.equal(isInsideDir(path.join(d, "root"), path.join(d, "root", "..", "outside")), false);
    assert.equal(isInsideDir(path.join(d, "root"), path.join(d, "root", "sub", "..", "..", "x")), false);
    assert.equal(isInsideDir(path.join(d, "root", "..", "root"), path.join(d, "root", "a")), true);
  });

  it("a symlink inside the root that points outside makes the target outside (real paths are compared)", { skip: posixOnly }, () => {
    const d = tmpDir();
    mkdirSync(path.join(d, "root"));
    mkdirSync(path.join(d, "outside"));
    writeFileSync(path.join(d, "outside", "secret"), "s");
    symlinkSync(path.join(d, "outside"), path.join(d, "root", "escape"));
    assert.equal(isInsideDir(path.join(d, "root"), path.join(d, "root", "escape")), false);
    assert.equal(isInsideDir(path.join(d, "root"), path.join(d, "root", "escape", "secret")), false);
  });

  it("a symlink inside the root that points elsewhere inside is inside; a symlinked root works through its real path", { skip: posixOnly }, () => {
    const d = tmpDir();
    mkdirSync(path.join(d, "root", "real"), { recursive: true });
    symlinkSync(path.join(d, "root", "real"), path.join(d, "root", "alias"));
    assert.equal(isInsideDir(path.join(d, "root"), path.join(d, "root", "alias")), true);
    symlinkSync(path.join(d, "root"), path.join(d, "rootlink"));
    assert.equal(isInsideDir(path.join(d, "rootlink"), path.join(d, "root", "real")), true);
    assert.equal(isInsideDir(path.join(d, "root"), path.join(d, "rootlink", "real")), true);
  });

  it("a dangling symlink is judged by its own (unresolvable) path, not by what it points to", { skip: posixOnly }, () => {
    const d = tmpDir();
    mkdirSync(path.join(d, "root"));
    symlinkSync(path.join(d, "nowhere"), path.join(d, "root", "dangling"));
    assert.equal(isInsideDir(path.join(d, "root"), path.join(d, "root", "dangling")), true);
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - on darwin and win32 the comparison ignores case, elsewhere it does not", () => {
    const real = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      for (const [platform, expected] of [["linux", false], ["darwin", true], ["win32", true]] as const) {
        Object.defineProperty(process, "platform", { ...real, value: platform });
        assert.equal(isInsideDir("/Nonexistent/Root", "/nonexistent/root/child"), expected, platform);
        assert.equal(isInsideDir("/Nonexistent/Root", "/nonexistent/rootX"), false, `${platform}: whole segments`);
      }
    } finally {
      Object.defineProperty(process, "platform", real);
    }
  });
});

describe("cleanEmptyDirs", () => {
  it("removes the chain of empty directories upwards and stops at the first non-empty one and never removes the stop directory", () => {
    const d = tmpDir();
    mkdirSync(path.join(d, "stop", "a", "b", "c"), { recursive: true });
    cleanEmptyDirs(path.join(d, "stop", "a", "b", "c"), path.join(d, "stop"));
    assert.deepEqual(listing(path.join(d, "stop")), []);

    mkdirSync(path.join(d, "stop", "x", "y", "z"), { recursive: true });
    writeFileSync(path.join(d, "stop", "x", "keep"), "k");
    cleanEmptyDirs(path.join(d, "stop", "x", "y", "z"), path.join(d, "stop"));
    assert.deepEqual(listing(path.join(d, "stop", "x")), ["keep"], "z and y are gone, x holds a file");
  });

  it("does nothing when the directory is the stop directory, is outside it, or is not empty", () => {
    const d = tmpDir();
    mkdirSync(path.join(d, "stop"), { recursive: true });
    mkdirSync(path.join(d, "elsewhere", "empty"), { recursive: true });
    mkdirSync(path.join(d, "stop", "full"));
    writeFileSync(path.join(d, "stop", "full", "f"), "f");
    cleanEmptyDirs(path.join(d, "stop"), path.join(d, "stop"));
    cleanEmptyDirs(path.join(d, "elsewhere", "empty"), path.join(d, "stop"));
    cleanEmptyDirs(path.join(d, "stop", "full"), path.join(d, "stop"));
    assert.ok(existsSync(path.join(d, "stop")) && existsSync(path.join(d, "elsewhere", "empty")) && existsSync(path.join(d, "stop", "full", "f")));
  });

  it("never walks above the stop directory, also for a name-prefix sibling", () => {
    const d = tmpDir();
    mkdirSync(path.join(d, "home", "agents", "a"), { recursive: true });
    mkdirSync(path.join(d, "home-evil", "x"), { recursive: true });
    cleanEmptyDirs(path.join(d, "home-evil", "x"), path.join(d, "home"));
    assert.ok(existsSync(path.join(d, "home-evil", "x")), "a sibling sharing a name prefix is not below the stop directory");
    cleanEmptyDirs(path.join(d, "home", "agents", "a"), path.join(d, "home"));
    assert.ok(existsSync(path.join(d, "home")), "the stop directory is kept");
    assert.ok(!existsSync(path.join(d, "home", "agents")));
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - a directory that no longer exists ends the clean-up: its empty parents stay", () => {
    const d = tmpDir();
    mkdirSync(path.join(d, "stop", "a", "b"), { recursive: true });
    cleanEmptyDirs(path.join(d, "stop", "a", "b", "already-removed"), path.join(d, "stop"));
    assert.ok(existsSync(path.join(d, "stop", "a", "b")), "readdirSync throws ENOENT and the catch ends the walk");
  });

  it("never removes a directory containing a dotfile or a symlink", { skip: posixOnly }, () => {
    const d = tmpDir();
    mkdirSync(path.join(d, "stop", "a", "b"), { recursive: true });
    writeFileSync(path.join(d, "stop", "a", "b", ".hidden"), "h");
    cleanEmptyDirs(path.join(d, "stop", "a", "b"), path.join(d, "stop"));
    assert.ok(existsSync(path.join(d, "stop", "a", "b", ".hidden")));
    mkdirSync(path.join(d, "stop", "c"));
    symlinkSync(path.join(d, "nowhere"), path.join(d, "stop", "c", "dangling"));
    cleanEmptyDirs(path.join(d, "stop", "c"), path.join(d, "stop"));
    assert.ok(existsSync(path.join(d, "stop", "c")), "a dangling link is an entry");
  });
});
