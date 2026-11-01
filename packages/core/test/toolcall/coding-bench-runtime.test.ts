/** Toolchain copies may use COW, never writable hardlinks or links out of the trusted source tree. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, stat, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { copyCodingRuntime } from "../../src/toolcall/coding-bench-runtime.ts";

test("changing a staged toolchain never changes the trusted original", async () => {
  const root = await mkdtemp(join(tmpdir(), "p1b-runtime-copy-"));
  try {
    const source = join(root, "source"),
      target = join(root, "target");
    await mkdir(source);
    await writeFile(join(source, "compiler"), "original", { mode: 0o700 });
    await copyCodingRuntime(source, target);
    if (process.platform !== "win32") {
      assert.notEqual((await stat(join(source, "compiler"))).ino, (await stat(join(target, "compiler"))).ino);
    }
    await writeFile(join(target, "compiler"), "changed");
    assert.equal(await readFile(join(source, "compiler"), "utf8"), "original");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime traversal refuses a source link that escapes the trusted tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "p1b-runtime-link-"));
  try {
    const source = join(root, "source"),
      target = join(root, "target");
    await mkdir(source);
    await writeFile(join(root, "outside"), "private outside data");
    if (process.platform === "win32") {
      await writeFile(join(source, "first"), "one");
      await writeFile(join(source, "second"), "two");
      await assert.rejects(copyCodingRuntime(source, target, { maxFiles: 1 }), /limit/u);
    } else {
      await symlink("../outside", join(source, "escape"));
      await assert.rejects(copyCodingRuntime(source, target), /link/u);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
