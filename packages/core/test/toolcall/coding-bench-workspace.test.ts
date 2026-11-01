/** B1 trusted fixture copies are independent of live provisioner worktrees and always remove their private tree. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { access, readFile, writeFile, symlink, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stageCodingFixture, snapshotCodingSources } from "../../src/toolcall/coding-bench-workspace.ts";

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

test("candidate snapshots refuse links, bound their input, and never carry Git administration", async () => {
  const root = await mkdtemp(join(tmpdir(), "p1b-snapshot-test-"));
  try {
    await writeFile(join(root, "solution.ts"), "export const x = 1;\n");
    await writeFile(join(root, ".git"), "gitdir: private metadata\n");
    const image = await snapshotCodingSources(root);
    assert.deepEqual([...image.keys()], ["solution.ts"]);
    if (process.platform === "win32") {
      await writeFile(join(root, "oversized"), Buffer.alloc(16_777_217));
      await assert.rejects(snapshotCodingSources(root), /limit/u);
    } else {
      await symlink("solution.ts", join(root, "linked.ts"));
      await assert.rejects(snapshotCodingSources(root), /link/u);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
