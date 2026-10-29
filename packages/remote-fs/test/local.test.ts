/** Read-only source access must enforce trust and budgets before returning any contents. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { createLocalFs, createNativeSourceFs, realpathWith } from "../src/local.ts";

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

test("a WSL share falls back to the lstat walk when Windows' native realpath refuses it", async () => {
  const eisdir = Object.assign(new Error("EISDIR"), { code: "EISDIR" });
  const missing = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  const refuse = (error: Error) => async (): Promise<string> => { throw error; };
  const walk = async (path: string) => `walked:${path}`;
  for (const share of ["\\\\wsl.localhost\\Ubuntu\\root\\source", "\\\\wsl$\\Ubuntu\\root\\source"])
    assert.equal(await realpathWith(share, "win32", refuse(eisdir), walk), `walked:${share}`);
  // A missing path, any other path and any other platform keep the native answer.
  await assert.rejects(realpathWith("\\\\wsl.localhost\\Ubuntu\\missing", "win32", refuse(missing), walk), { code: "ENOENT" });
  await assert.rejects(realpathWith("C:\\Users\\a", "win32", refuse(eisdir), walk), { code: "EISDIR" });
  await assert.rejects(realpathWith("\\\\wsl.localhost\\Ubuntu\\root", "linux", refuse(eisdir), walk), { code: "EISDIR" });
  assert.equal(await realpathWith("/x", "linux", async () => "/native", walk), "/native");
});
