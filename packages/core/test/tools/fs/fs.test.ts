// B2: file tools. Every test works inside one mkdtemp directory that `after` removes; nothing outside it is touched.
// Red-team cases: symlink escape, swap races (via the PLUR1BUS_ALLOW_TEST_INTERNALS race seam), oversize, device/FIFO
// files, case-insensitive deny hits, hard links, Windows path syntax (pure, runs on every OS).
process.env.PLUR1BUS_ALLOW_TEST_INTERNALS = "1";
import { after, before, beforeEach, describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFsOps, createFsTools, FsFailure, FS_CAPABILITIES } from "../../../src/tools/fs/index.ts";
import type { FsConfig } from "../../../src/tools/fs/index.ts";

const T = { timeout: 30_000 };
const win = process.platform === "win32";
const mac = process.platform === "darwin";
let base = "", root = "", outside = "";
let n = 0;

const cfg = (extra: Partial<FsConfig> = {}): FsConfig => ({ roots: [{ id: "ws", path: root }], home: join(base, "home"), ...extra });
const ops = (extra: Partial<FsConfig> = {}) => createFsOps(cfg(extra));
const fails = (p: Promise<unknown>, code: string, reason?: string) =>
  assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof FsFailure, `expected FsFailure, got ${String(e)}`);
    assert.equal(e.code, code, e.message);
    if (reason) assert.equal(e.reason, reason, e.message);
    return true;
  });

let symlinkOk: Promise<boolean> | undefined;
const canSymlink = (): Promise<boolean> => (symlinkOk ??= (async () => {
  try { await symlink(join(base, "nope"), join(base, "probe-link")); return true; } catch { return false; }
})());
async function needSymlink(t: TestContext): Promise<boolean> {
  if (await canSymlink()) return true;
  t.skip("this runner cannot create symbolic links");
  return false;
}
const dirLink = (target: string, at: string) => symlink(target, at, win ? "junction" : "dir");
const dirEntries = async (d: string) => (await readdir(d)).sort();

before(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "p1-fs-")));
  await mkdir(join(base, "home"));
});
after(async () => { await rm(base, { recursive: true, force: true }); });
beforeEach(async () => {
  root = join(base, `ws${++n}`);
  outside = join(base, `out${n}`);
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "outside-secret");
});

describe("happy path", () => {
  it("writes, reads, stats and lists; results carry root-relative paths only", T, async () => {
    const o = ops();
    await mkdir(join(root, "sub"));
    const w = await o.write({ path: join(root, "sub", "a.txt"), content: "héllo" });
    assert.deepEqual(w, { rootId: "ws", path: "sub/a.txt", bytesWritten: 6, created: true });
    const r = await o.read({ path: join(root, "sub", "a.txt") });
    assert.equal(r.content, "héllo");
    assert.equal(r.encoding, "utf8");
    assert.equal(r.truncated, false);
    const s = await o.stat({ path: join(root, "sub", "a.txt") });
    assert.equal(s.type, "file");
    assert.equal(s.size, 6);
    await writeFile(join(root, "sub", "b.bin"), Buffer.from([1, 2, 3]));
    const l = await o.list({ path: join(root, "sub") });
    assert.deepEqual(l.entries, [{ name: "a.txt", type: "file", size: 6 }, { name: "b.bin", type: "file", size: 3 }]);
    assert.equal(l.path, "sub");
    assert.ok(!JSON.stringify([w, r, s, l]).includes(root), "no host absolute path in results");
  });

  it("resolves relative paths against cwd (default: the first root)", T, async () => {
    const o = ops();
    await o.write({ path: "rel.txt", content: "x" });
    assert.equal(await readFile(join(root, "rel.txt"), "utf8"), "x");
    assert.equal((await o.read({ path: "rel.txt" })).content, "x");
  });

  it("a directory is stat'ed as a directory and the root lists as ''", T, async () => {
    const o = ops();
    assert.equal((await o.stat({ path: root })).type, "directory");
    assert.equal((await o.list({ path: root })).path, "");
  });

  it("not-found is its own code, not a policy refusal", T, async () => {
    const o = ops();
    await fails(o.read({ path: join(root, "missing.txt") }), "not-found");
    await fails(o.stat({ path: join(root, "missing.txt") }), "not-found");
    await fails(o.list({ path: join(root, "missing") }), "not-found");
  });

  it("list reports a link as a link without following it; hides deny-listed names; truncates", T, async (t) => {
    await writeFile(join(root, ".env"), "KEY=1");
    for (const f of ["c", "a", "b"]) await writeFile(join(root, f), f);
    if (await canSymlink()) await symlink(join(outside, "secret.txt"), join(root, "ln"));
    const o = ops({ deny: [{ name: ".env" }] });
    const l = await o.list({ path: root });
    const names = l.entries.map((e) => e.name);
    assert.ok(!names.includes(".env"));
    assert.deepEqual(names.filter((x) => x.length === 1), ["a", "b", "c"]);
    if (await canSymlink()) assert.deepEqual(l.entries.find((e) => e.name === "ln"), { name: "ln", type: "symlink" });
    else t.diagnostic("symlink part skipped");
    const t2 = await o.list({ path: root, maxEntries: 2 });
    assert.equal(t2.entries.length, 2);
    assert.equal(t2.truncated, true);
  });
});

describe("path policy (red team)", () => {
  it("refuses '..', absolute paths outside, and a backslash on POSIX", T, async () => {
    const o = ops();
    await fails(o.read({ path: `${root}${win ? "\\" : "/"}..${win ? "\\" : "/"}out${n}${win ? "\\" : "/"}secret.txt` }), "path-refused", "dot-dot");
    await fails(o.read({ path: "../secret.txt" }), "path-refused", "dot-dot");
    await fails(o.read({ path: join(outside, "secret.txt") }), "path-refused", "outside-root");
    await fails(o.write({ path: join(outside, "new.txt"), content: "x" }), "path-refused", "outside-root");
    await fails(o.list({ path: outside }), "path-refused", "outside-root");
    if (!win) await fails(o.read({ path: "a\\b" }), "path-refused", "backslash");
    assert.deepEqual(await dirEntries(outside), ["secret.txt"]);
  });

  it("refuses a root's parent, and non-string / empty / NUL paths", T, async () => {
    const o = ops();
    await fails(o.list({ path: base }), "path-refused", "outside-root");
    await fails(o.read({ path: 5 as never }), "invalid-arguments");
    await fails(o.read({ path: "" }), "path-refused", "empty");
    await fails(o.read({ path: "a\0b" }), "path-refused", "control-char");
  });

  it("Windows drive-relative, rooted, UNC, device and stream paths are refused (pure syntax, any OS)", T, async () => {
    const o = ops({ platform: "win32" });
    const bad: [string, string][] = [
      ["C:foo", "drive-relative"], ["\\foo", "drive-relative"], ["\\\\server\\share\\x", "unc-not-allowed"], ["//server/share/x", "unc-not-allowed"],
      ["\\\\?\\C:\\x", "device-path"], ["\\\\.\\PhysicalDrive0", "device-path"], ["C:\\a\\f.txt:stream", "alternate-stream"],
      ["C:\\a\\CON", "reserved-device-name"], ["C:\\a\\x.txt.", "trailing-dot-space"], ["C:\\a\\..\\b", "dot-dot"],
    ];
    for (const [p, reason] of bad) {
      await fails(o.read({ path: p }), "path-refused", reason);
      await fails(o.write({ path: p, content: "x" }), "path-refused", reason);
    }
  });

  it("deny-list hits case-insensitively on every OS, even for a file that does not exist", T, async () => {
    const o = ops({ deny: [{ name: ".env" }, { path: join(root, "private") }] });
    await fails(o.read({ path: join(root, ".ENV") }), "path-refused", "deny-listed");
    await fails(o.write({ path: join(root, ".Env"), content: "x" }), "path-refused", "deny-listed");
    await fails(o.read({ path: join(root, "PRIVATE", "k.txt") }), "path-refused", "deny-listed");
    await fails(o.write({ path: join(root, "Private", "k.txt"), content: "x" }), "path-refused", "deny-listed");
    assert.deepEqual(await dirEntries(root), []);
  });

  it("on a case-insensitive file system a differently-cased name reaches the same file and the result shows the on-disk name", T, async (t) => {
    if (!win && !mac) return t.skip("case-sensitive file system");
    await writeFile(join(root, "Notes.TXT"), "n");
    const o = ops();
    const r = await o.read({ path: join(root, "notes.txt") });
    assert.equal(r.content, "n");
    assert.equal(r.path, "Notes.TXT");
    // and a deny entry in another case still matches the real file
    const d = ops({ deny: [{ path: join(root, "NOTES.txt") }] });
    await fails(d.read({ path: join(root, "notes.TXT") }), "path-refused", "deny-listed");
  });

  it("symlink escape: file link, directory link, link in the middle of a path", T, async (t) => {
    if (!(await needSymlink(t))) return;
    await symlink(join(outside, "secret.txt"), join(root, "flink"));
    await dirLink(outside, join(root, "dlink"));
    const o = ops();
    await fails(o.read({ path: join(root, "flink") }), "path-refused", "outside-root");
    await fails(o.stat({ path: join(root, "flink") }), "path-refused", "outside-root");
    await fails(o.read({ path: join(root, "dlink", "secret.txt") }), "path-refused", "outside-root");
    await fails(o.list({ path: join(root, "dlink") }), "path-refused", "outside-root");
    await fails(o.write({ path: join(root, "flink"), content: "pwn", overwrite: true }), "path-refused", "outside-root");
    await fails(o.write({ path: join(root, "dlink", "new.txt"), content: "pwn" }), "path-refused", "outside-root");
    assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "outside-secret");
    assert.deepEqual(await dirEntries(outside), ["secret.txt"]);
  });

  it("a link that stays inside the root is fine, and a write through it lands on the real target", T, async (t) => {
    if (!(await needSymlink(t))) return;
    await mkdir(join(root, "real"));
    await dirLink(join(root, "real"), join(root, "alias"));
    const o = ops();
    const w = await o.write({ path: join(root, "alias", "f.txt"), content: "in" });
    assert.equal(w.path, "real/f.txt");
    assert.equal(await readFile(join(root, "real", "f.txt"), "utf8"), "in");
  });

  it("dangling link: a create through it is refused and nothing appears at its target", T, async (t) => {
    if (!(await needSymlink(t))) return;
    await symlink(join(outside, "planted.txt"), join(root, "dangling"));
    const o = ops();
    await fails(o.write({ path: join(root, "dangling"), content: "pwn" }), "path-refused", "dangling-link");
    await fails(o.write({ path: join(root, "dangling"), content: "pwn", overwrite: true }), "path-refused", "dangling-link");
    assert.deepEqual(await dirEntries(outside), ["secret.txt"]);
  });

  it("a write to a hard-linked file is refused (it may alias a file elsewhere)", T, async () => {
    await writeFile(join(root, "h1"), "orig");
    try { await link(join(root, "h1"), join(root, "h2")); } catch { return; /* no hard links here */ }
    const o = ops();
    await fails(o.write({ path: join(root, "h2"), content: "x", overwrite: true }), "path-refused", "hard-link");
    assert.equal(await readFile(join(root, "h1"), "utf8"), "orig");
  });
});

describe("swap races (check, then use)", () => {
  it("read: the leaf is replaced by a link to a secret between check and open -> refused, secret not returned", T, async (t) => {
    if (!(await needSymlink(t))) return;
    await writeFile(join(root, "f.txt"), "inside");
    const o = ops({ testHooks: { afterCheck: async () => { await rm(join(root, "f.txt")); await symlink(join(outside, "secret.txt"), join(root, "f.txt")); } } });
    await assert.rejects(o.read({ path: join(root, "f.txt") }), (e: unknown) => {
      assert.ok(e instanceof FsFailure);
      assert.ok(e.code === "changed" || e.code === "path-refused", e.message);
      assert.ok(!JSON.stringify(e).includes("outside-secret"));
      return true;
    });
  });

  it("read: the leaf is replaced by another regular file -> identity check refuses", T, async () => {
    await writeFile(join(root, "f.txt"), "inside");
    await writeFile(join(root, "other.txt"), "swapped-in");
    const o = ops({ testHooks: { afterCheck: async () => { await rm(join(root, "f.txt")); await rename(join(root, "other.txt"), join(root, "f.txt")); } } });
    await fails(o.read({ path: join(root, "f.txt") }), "changed");
  });

  it("read: the parent directory is swapped for a link to the outside -> refused", T, async (t) => {
    if (!(await needSymlink(t))) return;
    await mkdir(join(root, "d"));
    await writeFile(join(root, "d", "secret.txt"), "inside");
    const o = ops({ testHooks: { afterCheck: async () => { await rename(join(root, "d"), join(root, "d-moved")); await dirLink(outside, join(root, "d")); } } });
    await assert.rejects(o.read({ path: join(root, "d", "secret.txt") }), (e: unknown) => {
      assert.ok(e instanceof FsFailure);
      assert.ok(!JSON.stringify(e).includes("outside-secret"));
      return true;
    });
  });

  it("write(overwrite): the destination becomes a link to a file outside before the swap -> refused, outside untouched, no temp left", T, async (t) => {
    if (!(await needSymlink(t))) return;
    await writeFile(join(root, "f.txt"), "orig");
    const o = ops({ testHooks: { afterCheck: async (op) => { if (op === "write") { await rm(join(root, "f.txt")); await symlink(join(outside, "secret.txt"), join(root, "f.txt")); } } } });
    await assert.rejects(o.write({ path: join(root, "f.txt"), content: "pwn", overwrite: true }), (e: unknown) => e instanceof FsFailure);
    assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "outside-secret");
    assert.deepEqual((await dirEntries(root)).filter((x) => x.endsWith(".p1tmp")), []);
  });

  it("write(create): a link planted at the new name is not followed", T, async (t) => {
    if (!(await needSymlink(t))) return;
    const o = ops({ testHooks: { afterCheck: async (op) => { if (op === "write") await symlink(join(outside, "planted.txt"), join(root, "new.txt")); } } });
    await assert.rejects(o.write({ path: join(root, "new.txt"), content: "pwn" }), (e: unknown) => e instanceof FsFailure);
    assert.deepEqual(await dirEntries(outside), ["secret.txt"]);
    assert.deepEqual((await dirEntries(root)).filter((x) => x.endsWith(".p1tmp")), []);
  });

  it("write(create): a file that appears at the name meanwhile is never clobbered", T, async () => {
    const o = ops({ testHooks: { afterCheck: async (op) => { if (op === "write") await writeFile(join(root, "new.txt"), "someone-else"); } } });
    await assert.rejects(o.write({ path: join(root, "new.txt"), content: "mine" }), (e: unknown) => e instanceof FsFailure);
    assert.equal(await readFile(join(root, "new.txt"), "utf8"), "someone-else");
    assert.deepEqual((await dirEntries(root)).filter((x) => x.endsWith(".p1tmp")), []);
  });

  it("write(overwrite): the destination replaced by another file -> refused, the new file survives", T, async () => {
    await writeFile(join(root, "f.txt"), "orig");
    const o = ops({ testHooks: { afterCheck: async (op) => { if (op === "write") { await rm(join(root, "f.txt")); await writeFile(join(root, "f.txt"), "theirs"); } } } });
    await fails(o.write({ path: join(root, "f.txt"), content: "mine", overwrite: true }), "changed");
    assert.equal(await readFile(join(root, "f.txt"), "utf8"), "theirs");
  });
});

describe("limits, binary and special files", () => {
  it("read: a file over the limit is refused unless a range is asked for; the range is bounded", T, async () => {
    await writeFile(join(root, "big.txt"), "a".repeat(100));
    const o = ops({ limits: { maxReadBytes: 40 } });
    await fails(o.read({ path: join(root, "big.txt") }), "too-large");
    const r = await o.read({ path: join(root, "big.txt"), offset: 10, length: 30 });
    assert.equal(r.content.length, 30);
    assert.equal(r.truncated, true);
    assert.equal(r.size, 100);
    await fails(o.read({ path: join(root, "big.txt"), length: 41 }), "invalid-arguments");
    const tail = await o.read({ path: join(root, "big.txt"), offset: 70 });
    assert.equal(tail.content.length, 30);
    assert.equal(tail.truncated, false);
    assert.equal((await o.read({ path: join(root, "big.txt"), offset: 500 })).content, "");
  });

  it("write: oversize content is refused before any file or temp file exists", T, async () => {
    const o = ops({ limits: { maxWriteBytes: 10 } });
    await fails(o.write({ path: join(root, "w.txt"), content: "x".repeat(11) }), "too-large");
    await fails(o.write({ path: join(root, "w.txt"), content: Buffer.alloc(11).toString("base64"), encoding: "base64" }), "too-large");
    assert.deepEqual(await dirEntries(root), []);
    assert.equal((await o.write({ path: join(root, "w.txt"), content: "x".repeat(10) })).bytesWritten, 10);
  });

  it("binary vs text: NUL and invalid UTF-8 are refused as text, returned as base64 on request", T, async () => {
    const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]);
    await writeFile(join(root, "a.png"), bin);
    await writeFile(join(root, "bad.txt"), Buffer.from([0x61, 0xff, 0xfe]));
    const o = ops();
    await fails(o.read({ path: join(root, "a.png") }), "binary-content");
    await fails(o.read({ path: join(root, "a.png"), encoding: "utf8" }), "binary-content");
    await fails(o.read({ path: join(root, "bad.txt") }), "binary-content");
    const b = await o.read({ path: join(root, "a.png"), encoding: "base64" });
    assert.equal(b.encoding, "base64");
    assert.deepEqual(Buffer.from(b.content, "base64"), bin);
  });

  it("a ranged read that cuts a multi-byte character at the end is still text", T, async () => {
    await writeFile(join(root, "u.txt"), "aé€😀"); // 1 + 2 + 3 + 4 bytes
    const o = ops();
    const r = await o.read({ path: join(root, "u.txt"), length: 5 }); // cuts inside the euro sign
    assert.equal(r.content, "aé");
    assert.equal(r.truncated, true);
    assert.equal(r.bytesRead, 3);
  });

  it("write round-trips base64 bytes and rejects malformed base64 / lone surrogates", T, async () => {
    const o = ops();
    const bytes = Buffer.from([0, 255, 128, 7]);
    await o.write({ path: join(root, "b"), content: bytes.toString("base64"), encoding: "base64" });
    assert.deepEqual(await readFile(join(root, "b")), bytes);
    await fails(o.write({ path: join(root, "c"), content: "not base64!", encoding: "base64" }), "invalid-arguments");
    await fails(o.write({ path: join(root, "c"), content: "\ud800" }), "invalid-arguments");
  });

  it("a FIFO inside the root is refused without blocking; a directory is not a file", T, async (t) => {
    const o = ops();
    await mkdir(join(root, "dir"));
    await fails(o.read({ path: join(root, "dir") }), "not-a-file");
    await fails(o.write({ path: join(root, "dir"), content: "x", overwrite: true }), "not-a-file");
    if (win) return t.skip("no FIFOs on Windows");
    try { execFileSync("mkfifo", [join(root, "pipe")]); } catch { return t.skip("mkfifo unavailable"); }
    await fails(o.read({ path: join(root, "pipe") }), "not-a-file");
    await fails(o.write({ path: join(root, "pipe"), content: "x", overwrite: true }), "not-a-file");
    assert.ok((await lstat(join(root, "pipe"))).isFIFO());
  });

  it("device files: /dev paths and a link to a device are refused", T, async (t) => {
    if (win) return t.skip("no /dev on Windows");
    const o = ops();
    await fails(o.read({ path: "/dev/zero" }), "path-refused");
    await fails(o.read({ path: "/dev/null", encoding: "base64" }), "path-refused");
    if (!(await canSymlink())) return;
    await symlink("/dev/zero", join(root, "zero"));
    await fails(o.read({ path: join(root, "zero") }), "path-refused");
    await fails(o.write({ path: join(root, "zero"), content: "x", overwrite: true }), "path-refused");
  });

  it("an aborted call fails with `aborted` and writes nothing", T, async () => {
    const o = ops();
    const ac = new AbortController();
    ac.abort();
    await fails(o.write({ path: join(root, "x"), content: "x" }, { signal: ac.signal }), "aborted");
    await fails(o.read({ path: join(root, "x") }, { signal: ac.signal }), "aborted");
    assert.deepEqual(await dirEntries(root), []);
  });
});

describe("atomic write", () => {
  it("create-only refuses an existing file (default) and replaces it only with overwrite: true", T, async () => {
    const o = ops();
    await o.write({ path: join(root, "f"), content: "one" });
    await fails(o.write({ path: join(root, "f"), content: "two" }), "exists");
    assert.equal(await readFile(join(root, "f"), "utf8"), "one");
    const w = await o.write({ path: join(root, "f"), content: "two", overwrite: true });
    assert.equal(w.created, false);
    assert.equal(await readFile(join(root, "f"), "utf8"), "two");
    assert.deepEqual(await dirEntries(root), ["f"]);
  });

  it("a failure before the swap leaves the original intact and no temp file", T, async () => {
    await writeFile(join(root, "f"), "original");
    const o = ops({ testHooks: { afterCheck: async (op) => { if (op === "write") throw new FsFailure("io-error", "injected"); } } });
    await fails(o.write({ path: join(root, "f"), content: "new-content", overwrite: true }), "io-error");
    assert.equal(await readFile(join(root, "f"), "utf8"), "original");
    assert.deepEqual(await dirEntries(root), ["f"]);
  });

  it("the parent must exist: no implicit mkdir", T, async () => {
    const o = ops();
    await fails(o.write({ path: join(root, "no", "such", "f"), content: "x" }), "not-found");
    assert.deepEqual(await dirEntries(root), []);
  });

  it("POSIX: created files are 0600, an overwrite keeps the permission bits", T, async (t) => {
    if (win) return t.skip("POSIX modes");
    const o = ops();
    await o.write({ path: join(root, "p"), content: "x" });
    assert.equal((await stat(join(root, "p"))).mode & 0o777, 0o600);
    await writeFile(join(root, "q"), "x", { mode: 0o640 });
    await (await import("node:fs/promises")).chmod(join(root, "q"), 0o640);
    await o.write({ path: join(root, "q"), content: "y", overwrite: true });
    assert.equal((await stat(join(root, "q"))).mode & 0o777, 0o640);
  });

  it("a long file name still yields a valid temp name", T, async () => {
    const o = ops();
    const name = "n".repeat(200);
    await o.write({ path: join(root, name), content: "x" });
    assert.equal(await readFile(join(root, name), "utf8"), "x");
  });
});

describe("tool specs", () => {
  it("four tools with closed schemas, D109 effects, and matching capability rows", T, () => {
    const { tools, index } = createFsTools(cfg());
    assert.deepEqual(tools.map((x) => x.name).sort(), ["file.list", "file.read", "file.stat", "file.write"]);
    for (const x of tools) assert.equal((x.inputSchema as { additionalProperties?: boolean }).additionalProperties, false, x.name);
    const eff = Object.fromEntries(tools.map((x) => [x.name, x.effect]));
    assert.deepEqual(eff, { "file.read": "read", "file.write": "local-write", "file.list": "read", "file.stat": "read" });
    assert.equal(tools.find((x) => x.name === "file.write")!.parallelSafe, false);
    assert.equal(index, FS_CAPABILITIES);
    for (const row of index) assert.equal(tools.find((x) => x.name === row.name)!.effect, row.effect);
    assert.equal(new Set(index.map((r) => r.version)).size, 4);
  });

  it("execute returns structured results: values on success, code/hint on failure, never a path or a stack", T, async () => {
    const { tools } = createFsTools(cfg());
    const by = Object.fromEntries(tools.map((x) => [x.name, x]));
    const w = await by["file.write"]!.execute({ path: join(root, "t.txt"), content: "hi" }, {});
    assert.equal(w.isError, false);
    const r = await by["file.read"]!.execute({ path: join(root, "t.txt") }, {});
    assert.deepEqual(r.isError === false && (r.value as { content: string }).content, "hi");
    const bad = await by["file.read"]!.execute({ path: join(outside, "secret.txt") }, {});
    assert.equal(bad.isError, true);
    if (bad.isError) {
      assert.equal(bad.error.code, "path-refused");
      assert.equal(bad.error.reason, "outside-root");
      assert.ok(bad.error.hint.length > 0 && bad.error.userAction.length > 0);
      assert.ok(!JSON.stringify(bad).includes(outside) && !JSON.stringify(bad).includes("\\n    at "));
    }
  });

  it("unknown or malformed arguments are invalid-arguments", T, async () => {
    const { tools } = createFsTools(cfg());
    const read = tools.find((x) => x.name === "file.read")!;
    for (const args of [{ path: "a", extra: 1 }, null, "x", [], { path: "a", offset: -1 }, { path: "a", encoding: "latin1" }]) {
      const out = await read.execute(args, {});
      assert.equal(out.isError, true, JSON.stringify(args));
      if (out.isError) assert.equal(out.error.code, "invalid-arguments");
    }
  });

  it("an unexpected exception becomes internal-error without its message", T, async () => {
    const { tools } = createFsTools(cfg());
    const out = await tools[0]!.execute({ get path(): string { throw new Error("secret-detail"); } }, {});
    assert.equal(out.isError, true);
    assert.ok(!JSON.stringify(out).includes("secret-detail"));
  });

  it("the race seam is ignored without PLUR1BUS_ALLOW_TEST_INTERNALS", T, async () => {
    const saved = process.env.PLUR1BUS_ALLOW_TEST_INTERNALS;
    delete process.env.PLUR1BUS_ALLOW_TEST_INTERNALS;
    try {
      let called = false;
      const o = ops({ testHooks: { afterCheck: async () => { called = true; } } });
      await writeFile(join(root, "f"), "x");
      await o.read({ path: join(root, "f") });
      assert.equal(called, false);
    } finally { process.env.PLUR1BUS_ALLOW_TEST_INTERNALS = saved; }
  });

  it("createFsOps without a root throws", T, () => {
    assert.throws(() => createFsOps({ roots: [] }));
  });
});
