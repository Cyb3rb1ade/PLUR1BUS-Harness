/** Read-only source access must enforce trust and budgets before returning any contents. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { createLocalFs, createNativeSourceFs, wslShareLinkStat } from "../src/local.ts";
import { RemoteFsError } from "../src/types.ts";

async function fixture(run: (root: string, outside: string) => Promise<void>): Promise<void> {
  const base = await realpath(await mkdtemp(join(tmpdir(), "p1-remote-fs-")));
  const root = join(base, "source");
  const outside = join(base, "outside");
  try {
    await mkdir(root);
    await writeFile(join(root, "card.md"), "public-card");
    await writeFile(outside, "OUTSIDE-CONTENTS");
    await run(root, outside);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

test("the local source exposes precisely the six read operations", async () => fixture(async root => {
  const fs = await createLocalFs({ root });
  assert.deepEqual(Object.keys(fs).sort(), ["lstat", "readFile", "readdir", "readlink", "realpath", "stat"]);
  assert.ok(Object.isFrozen(fs));
  assert.equal((await fs.stat("card.md")).type, "file");
  assert.equal((await fs.lstat("card.md")).size, 11);
  assert.deepEqual(await fs.readdir("."), ["card.md"]);
  assert.equal((await fs.readFile("card.md", 11)).toString(), "public-card");
  assert.equal(await fs.realpath("card.md"), join(root, "card.md"));
}));

test("the per-file and per-run budgets count actual repeated file bytes", async () => fixture(async root => {
  const fs = await createLocalFs({ root, limits: { maxFileBytes: 11, maxTotalBytes: 15 } });
  await assert.rejects(fs.readFile("card.md", 10), { reason: "file-limit" });
  assert.equal((await fs.readFile("card.md", 11)).length, 11);
  await assert.rejects(fs.readFile("card.md", 11), { reason: "total-limit" });
  assert.equal((await fs.stat("card.md")).type, "file");
}));

test("native discovery reads explicit paths with one cumulative byte budget and rejects invalid path input", async () => fixture(async (root, outside) => {
  const fs = await createNativeSourceFs({ limits: { maxFileBytes: 64, maxTotalBytes: 20 } });
  assert.deepEqual(Object.keys(fs).sort(), ["lstat", "readFile", "readdir", "readlink", "realpath", "stat"]);
  assert.ok(Object.isFrozen(fs));
  assert.equal((await fs.readFile(join(root, "card.md"), 64)).toString(), "public-card");
  await assert.rejects(fs.readFile(outside, 64), { reason: "total-limit" });
  await assert.rejects(fs.stat("invalid\0path"), { reason: "path-denied" });
  assert.equal((await fs.stat(outside)).type, "file");
}));

test("lexical escapes and escaped symlinks cannot return external data or metadata", async () => fixture(async (root, outside) => {
  await symlink(outside, join(root, "escape"));
  const fs = await createLocalFs({ root });
  for (const path of [outside, "../outside", "escape"]) {
    await assert.rejects(fs.readFile(path, 1024), { reason: "path-denied" });
    await assert.rejects(fs.stat(path), { reason: "path-denied" });
  }
  assert.equal((await fs.lstat("escape")).type, "symlink");
  await assert.rejects(fs.realpath("escape"), { reason: "path-denied" });
  await assert.rejects(fs.readlink("escape"), { reason: "path-denied" });
}));

test("internal symlinks remain readable and their target stays inside the selected root", async () => fixture(async root => {
  await symlink("card.md", join(root, "alias"));
  const fs = await createLocalFs({ root });
  assert.equal(await fs.readlink("alias"), "card.md");
  assert.equal((await fs.readFile("alias", 11)).toString(), "public-card");
}));

test("an explicitly selected alias pins its canonical root once while inner links still cannot escape", async () => fixture(async (root, outside) => {
  const alias = root + "-alias";
  await symlink(root, alias, "junction");
  await symlink(outside, join(root, "escape"));
  const canonical = await realpath(root);
  const fs = await createLocalFs({ root: alias });
  assert.equal((await fs.readFile(join(alias, "card.md"), 11)).toString(), "public-card");
  assert.equal(await fs.realpath(alias), canonical);
  assert.equal((await fs.readFile(join(root, "card.md"), 11)).toString(), "public-card");
  await assert.rejects(fs.readFile(join(alias, "escape"), 1024), { reason: "path-denied" });
  await assert.rejects(fs.stat(alias + "-other/card.md"), { reason: "path-denied" });
  await rm(alias);
  await symlink(join(root, ".."), alias, "junction");
  assert.equal((await fs.readFile(join(alias, "card.md"), 11)).toString(), "public-card", "root alias replacement never changes the pinned authority");
}));

test("depth and directory-entry limits are cumulative and deterministic", async () => fixture(async root => {
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested", "deep"), "x");
  const depth = await createLocalFs({ root, limits: { maxDepth: 1 } });
  await assert.rejects(depth.stat("nested/deep"), { reason: "depth-limit" });
  const entries = await createLocalFs({ root, limits: { maxEntries: 2 } });
  assert.equal((await entries.readdir(".")).length, 2);
  await assert.rejects(entries.readdir("."), { reason: "entry-limit" });
}));

test("abort, deadline and invalid limits refuse reads with fixed sanitized errors", async () => fixture(async root => {
  const abort = new AbortController();
  const fs = await createLocalFs({ root, signal: abort.signal });
  abort.abort(new Error("SECRET-BACKEND-DETAIL"));
  await assert.rejects(fs.readFile("card.md", 11), { reason: "aborted", message: "remote-fs: aborted" });
  await assert.rejects(createLocalFs({ root, limits: { timeoutMs: Infinity } }), { reason: "invalid-limit" });
  const timeout = await createLocalFs({ root, limits: { timeoutMs: 5 } });
  await new Promise(resolve => setTimeout(resolve, 15));
  await assert.rejects(timeout.stat("card.md"), { reason: "timeout" });
  await assert.rejects(timeout.readFile("card.md", -1), { reason: "timeout" });
}));

test("a Linux symlink on a WSL share that Windows cannot lstat is a link by the share's own listing", async () => {
  const eisdir = Object.assign(new Error("EISDIR"), { code: "EISDIR" });
  const entry = (name: string, link: boolean) => ({ name, isSymbolicLink: () => link }) as unknown as Dirent;
  const listed: string[] = [];
  const list = async (directory: string) => { listed.push(directory); return (async function* () {
    yield entry("SKILL.md", false); yield entry("leaked_key", true);
  })(); };
  for (const share of ["\\\\wsl.localhost\\Ubuntu\\root\\notes", "\\\\wsl$\\Ubuntu\\root\\notes"]) {
    assert.deepEqual(await wslShareLinkStat(`${share}\\leaked_key`, eisdir, "win32", list), { type: "symlink", size: 0, mode: 0, mtimeMs: 0 });
    assert.equal(listed.pop(), share);
    // A listed entry that is no link, and an entry the listing does not name, keep the native error.
    assert.equal(await wslShareLinkStat(`${share}\\SKILL.md`, eisdir, "win32", list), undefined);
    assert.equal(await wslShareLinkStat(`${share}\\gone`, eisdir, "win32", list), undefined);
  }
  // Any other error, path or platform is never answered from a listing.
  listed.length = 0;
  const missing = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  assert.equal(await wslShareLinkStat("\\\\wsl.localhost\\Ubuntu\\root\\leaked_key", missing, "win32", list), undefined);
  assert.equal(await wslShareLinkStat("C:\\Users\\a\\leaked_key", eisdir, "win32", list), undefined);
  assert.equal(await wslShareLinkStat("\\\\wsl.localhost\\Ubuntu\\root\\leaked_key", eisdir, "linux", list), undefined);
  assert.deepEqual(listed, []);
});

test("a link the host cannot resolve is denied, a missing target is not found, and native failures name their call", async () => fixture(async root => {
  await symlink("loop", join(root, "loop"));
  await symlink("missing-target", join(root, "dangling"));
  await writeFile(join(root, "plain"), "x");
  for (const fs of [await createLocalFs({ root }), await createNativeSourceFs()]) {
    const at = (name: string) => join(root, name);
    await assert.rejects(fs.stat(at("loop")), { reason: "path-denied" });
    await assert.rejects(fs.readFile(at("loop"), 16), { reason: "path-denied" });
    assert.equal((await fs.lstat(at("loop"))).type, "symlink");
    await assert.rejects(fs.stat(at("dangling")), { reason: "not-found" });
    // Reading a file as a directory is a native failure: its code and call are kept, its path is not.
    await assert.rejects(fs.readdir(at("plain")), (error: unknown) => error instanceof RemoteFsError && error.reason === "unavailable"
      && error.detail === "ENOTDIR opendir" && !error.message.includes(root));
  }
}));
