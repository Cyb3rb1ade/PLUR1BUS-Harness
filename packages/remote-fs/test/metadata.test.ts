/** Permission metadata preserves executable skill disclosure when the importer moves to the six-operation port. */
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createLocalFs } from "../src/local.ts";

test("stat retains permission bits needed to disclose executable source files", async () => {
  const root = await mkdtemp(join(tmpdir(), "p1-mode-"));
  try {
    await writeFile(join(root, "runner"), "public instructions");
    await chmod(join(root, "runner"), 0o755);
    const fs = await createLocalFs({ root });
    const info = await fs.stat("runner");
    assert.equal(typeof (info as { mode?: number }).mode, "number");
    if (process.platform !== "win32") assert.equal((info as { mode?: number }).mode! & 0o111, 0o111);
  } finally { await rm(root, { recursive: true, force: true }); }
});
