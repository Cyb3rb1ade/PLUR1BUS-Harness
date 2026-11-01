/** Missing #820/K2a APIs must stop before creating a substitute worktree or granting arbitrary temporary roots. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { access, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sep } from "node:path";
import { realTempDir } from "../helpers/real-temp-dir.ts";
import { codingProvisionerApi, provisionCodingCard } from "../../src/toolcall/coding-bench-provisioner.ts";

test("live workspaces require the shared provisioner and opaque native mount, without a fallback creator", async () => {
  const root = await realTempDir("p1b-coding-provisioner-");
  const path = fileURLToPath(new URL("../../src/tools/sandbox/worktree-mount.ts", import.meta.url));
  let installed = true;
  try {
    await access(path);
  } catch {
    installed = false;
  }
  try {
    const files = new Map([["README.md", { text: "Public starting state.\n", mode: 0o600 }]]);
    if (!installed) {
      await assert.rejects(codingProvisionerApi(), /requires merged #820 and K2a/u);
      await assert.rejects(provisionCodingCard(root, files, new AbortController().signal), /requires merged/u);
      assert.deepEqual(await readdir(root), []);
      return;
    }
    assert.equal(typeof (await codingProvisionerApi()).fromStore, "function");
    if (process.platform === "win32") {
      await assert.rejects(provisionCodingCard(root, files, new AbortController().signal), /unavailable/u);
    } else {
      const workspace = await provisionCodingCard(root, files, new AbortController().signal);
      try {
        assert.ok(workspace.worktree.startsWith(workspace.home + sep + "state" + sep + "worktrees" + sep));
        assert.ok(workspace.binding.cardId);
        assert.equal(typeof workspace.binding.worktreeMount, "object");
      } finally {
        await workspace.close();
      }
    }
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
