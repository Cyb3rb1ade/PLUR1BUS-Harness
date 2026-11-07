/** B1 trusted fixture copies are independent of live provisioner worktrees and always remove their private tree. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { access, readFile, writeFile, symlink, mkdtemp, rm, mkdir, truncate } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodingSnapshotInvalid, stageCodingFixture, snapshotCodingSources, writeCodingImage } from "../../src/toolcall/coding-bench-workspace.ts";

test("an original fixture gets only its public files, with no Git or private checker material", async () => {
  const signal = new AbortController().signal;
  const files = new Map([
    ["README.md", { text: "public instructions\n", mode: 0o600 }],
    ["src/solution.ts", { text: "export const value = 1;\n", mode: 0o600 }],
  ]);
  const workspace = await stageCodingFixture(files, signal);
  try {
    assert.equal(await readFile(join(workspace.tree, "src/solution.ts"), "utf8"), "export const value = 1;\n");
    await assert.rejects(access(join(workspace.tree, ".git")));
    await assert.rejects(access(join(workspace.tree, "reference")));
    await assert.rejects(access(join(workspace.tree, "checker.mjs")));
  } finally {
    await workspace.close();
  }
  await assert.rejects(access(workspace.root));
  await workspace.close();
});

test("escaping source paths and Git administration files are refused before provisioning", async () => {
  for (const name of ["../escape", "/escape", ".git/config", "src/../../escape", "src\\escape"]) {
    await assert.rejects(
      stageCodingFixture(new Map([[name, { text: "x", mode: 0o600 }]]), new AbortController().signal),
    );
  }
});

test("candidate snapshots bound regular files and never carry Git administration", async () => {
  const root = await mkdtemp(join(tmpdir(), "p1b-snapshot-test-"));
  try {
    await writeFile(join(root, "solution.ts"), "export const x = 1;\n");
    await writeFile(join(root, ".git"), "gitdir: private metadata\n");
    const { image, ignoredEntries } = await snapshotCodingSources(root, "solution.ts");
    assert.deepEqual([...image.keys()], ["solution.ts"]);
    assert.equal(ignoredEntries, 0);
    await writeFile(join(root, "oversized"), "");
    await truncate(join(root, "oversized"), 16_777_217);
    await assert.rejects(snapshotCodingSources(root, "solution.ts"), /limit/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshots skip and count links and special fixtures without reading, following or restoring them", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "p1b-snapshot-fixtures-"));
  try {
    const tree = join(root, "tree");
    const restored = join(root, "restored");
    await mkdir(tree);
    await mkdir(restored);
    await writeFile(join(tree, "solution.ts"), "export const x = 1;\n");
    await writeFile(join(root, "outside"), "must not enter the image");
    await symlink("../outside", join(tree, "external"));
    await symlink("missing", join(tree, "dangling"));
    await symlink(".", join(tree, "cycle"));
    await symlink("../", join(tree, ".build"));
    await promisify(execFile)("mkfifo", [join(tree, "pipe")]);
    await writeFile(join(tree, "fixture:unportable"), "unportable fixture");
    const snapshot = await snapshotCodingSources(tree, "solution.ts");
    assert.equal(snapshot.ignoredEntries, 6);
    assert.deepEqual([...snapshot.image.keys()], ["solution.ts"]);
    await writeCodingImage(restored, snapshot.image);
    assert.equal(await readFile(join(restored, "solution.ts"), "utf8"), "export const x = 1;\n");
    for (const name of ["external", "dangling", "cycle", ".build", "pipe", "fixture:unportable"]) {
      await assert.rejects(access(join(restored, name)));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the actual entry must be a regular file, even when its link target is regular", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "p1b-snapshot-entry-"));
  try {
    await writeFile(join(root, "regular.ts"), "export const x = 1;\n");
    await symlink("regular.ts", join(root, "solution.ts"));
    await assert.rejects(snapshotCodingSources(root, "solution.ts"), (error) =>
      error instanceof CodingSnapshotInvalid && error.ignoredEntries === 1);
    await rm(join(root, "solution.ts"));
    await promisify(execFile)("mkfifo", [join(root, "solution.ts")]);
    await assert.rejects(snapshotCodingSources(root, "solution.ts"), /entry missing or nonregular/u);
    await rm(join(root, "solution.ts"));
    await mkdir(join(root, "solution.ts"));
    await assert.rejects(snapshotCodingSources(root, "solution.ts"), /entry missing or nonregular/u);
    await assert.rejects(snapshotCodingSources(root, "missing.ts"), /entry missing or nonregular/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ignored fixture entries still consume the entry limit and nested trees retain their depth limit", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "p1b-snapshot-limits-"));
  try {
    const many = join(root, "many");
    await mkdir(many);
    for (let index = 0; index < 2049; index++) await symlink("missing", join(many, String(index)));
    await assert.rejects(snapshotCodingSources(many, "solution.ts"), (error) =>
      error instanceof CodingSnapshotInvalid && /entry limit/u.test(error.message) && error.ignoredEntries === 2048);
    const deep = join(root, "deep");
    await mkdir(join(deep, ...Array.from({ length: 33 }, () => "dir")), { recursive: true });
    await assert.rejects(snapshotCodingSources(deep, "solution.ts"), /depth limit/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
