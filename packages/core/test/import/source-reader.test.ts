/** Source selections canonicalize their configured authority without granting sibling or link escapes. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createLocalFs } from "@plur1bus/remote-fs";
import { SourceReader } from "../../src/import/source-reader.ts";

test("a configured source alias and its selected descendant use the same canonical authority", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "p1-source-selection-")));
  try {
    const root = join(base, "source");
    const alias = join(base, "source-alias");
    const selected = join(root, "selected");
    const outside = join(base, "outside");
    await mkdir(selected, { recursive: true });
    await mkdir(outside);
    await writeFile(join(selected, "card.md"), "selected source");
    await symlink(root, alias, "junction");
    await symlink(outside, join(root, "escape"), "junction");
    const reader = new SourceReader({ fs: await createLocalFs({ root: alias }), root: alias });

    assert.equal(await reader.select(join(alias, "selected")), selected);
    assert.equal(await reader.select(selected), selected);
    assert.equal(await reader.text(join(alias, "selected", "card.md"), 64), "selected source");
    await assert.rejects(reader.select(outside), { reason: "path-denied" });
    await assert.rejects(reader.select(join(alias, "escape")), { reason: "path-denied" });

    await rm(alias);
    await symlink(outside, alias, "junction");
    assert.equal(await reader.select(join(alias, "selected")), selected,
      "replacing the chosen alias cannot change the authority pinned by the filesystem port");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("the native source reader reads explicit local paths outside the working directory", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "p1-native-source-")));
  try {
    await writeFile(join(root, "card.md"), "native source");
    const reader = await SourceReader.local();
    assert.equal(await reader.select(root), root);
    assert.equal(await reader.text(join(root, "card.md"), 64), "native source");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
