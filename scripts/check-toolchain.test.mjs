import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkToolchain } from "./check-toolchain.mjs";

test("accepts node 24.16+, pnpm 10+, cargo 1.95+", () => {
  const ok = checkToolchain({ node: "v24.21.0", pnpm: "10.28.0", cargo: "cargo 1.95.0 (f2d3ce0bd 2026-03-21)" });
  assert.deepEqual(ok, { ok: true, problems: [] });
});

test("names every tool that is too old", () => {
  const bad = checkToolchain({ node: "v22.22.2", pnpm: "9.1.0", cargo: "cargo 1.80.0" });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.problems.map((p) => p.tool), ["node", "pnpm", "cargo"]);
});

test("the command line runs from a path with spaces and fails when pnpm and cargo are missing", () => {
  // The entry-point guard compared import.meta.url with `file://${argv[1]}`, which never matches a path with spaces
  // (percent-encoded in the URL) nor a Windows path: the script then did nothing and exited 0.
  const root = mkdtempSync(join(tmpdir(), "p1b-toolchain-"));
  try {
    const dir = join(root, "with space");
    mkdirSync(dir);
    copyFileSync(fileURLToPath(new URL("./check-toolchain.mjs", import.meta.url)), join(dir, "check-toolchain.mjs"));
    const empty = join(root, "empty-bin");
    mkdirSync(empty);
    const r = spawnSync(process.execPath, [join(dir, "check-toolchain.mjs")], { encoding: "utf8", env: { PATH: empty } });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /toolchain: pnpm missing/);
    assert.match(r.stderr, /toolchain: cargo missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
