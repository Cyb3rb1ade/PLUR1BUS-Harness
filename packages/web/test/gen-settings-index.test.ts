import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const generator = fileURLToPath(new URL("../scripts/gen-settings-index.mjs", import.meta.url));

test("settings-index generator is byte-stable and --check detects drift", () => {
  const dir = mkdtempSync(join(tmpdir(), "settings-index-gen-"));
  const outFile = join(dir, "settings-index.ts");
  const run = (...args: string[]) => execFileSync(process.execPath, [generator, "--out", outFile, ...args]);

  try {
    run();
    const first = readFileSync(outFile, "utf8");
    run();
    assert.equal(readFileSync(outFile, "utf8"), first);

    // Verify --check succeeds on matching content
    run("--check");

    // Modify file to introduce drift
    writeFileSync(outFile, first.replace("Register local hostctl tools.", "Stale description."));
    const stale = readFileSync(outFile, "utf8");

    const result = spawnSync(process.execPath, [generator, "--out", outFile, "--check"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr.toString(), /settings-index: drift/);
    assert.equal(readFileSync(outFile, "utf8"), stale);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
