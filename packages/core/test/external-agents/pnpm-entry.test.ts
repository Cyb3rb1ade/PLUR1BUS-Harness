import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { tempDir } from "../helpers/temp-dir.ts";
import { pnpmEntry } from "./pnpm-entry.fixture.ts";

function installed(root: string, version: string): string {
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pnpm", version }));
  const entry = join(root, "bin", "pnpm.cjs");
  writeFileSync(entry, "// test package entry\n");
  return entry;
}

test("the pinned pnpm package is found through a direct package symlink", () => {
  const root = tempDir("pnpm-entry-link-");
  const entry = installed(join(root, "package"), "10.28.0");
  const bin = join(root, "pnpm");
  symlinkSync(entry, bin);
  assert.equal(pnpmEntry(bin, "10.28.0"), entry);
});

test("action-setup's regular self-update shim resolves the requested package, not its bootstrap", () => {
  const root = tempDir("pnpm-entry-action-");
  const home = join(root, "setup-pnpm", "node_modules", ".bin");
  const bin = join(home, "bin", "pnpm");
  mkdirSync(dirname(bin), { recursive: true });
  writeFileSync(bin, "#!/bin/sh\n# regular command shim\n");
  installed(join(root, "setup-pnpm", "node_modules", "pnpm"), "11.0.0");
  assert.equal(pnpmEntry(bin, "10.28.0", home), null);
  const entry = installed(join(home, ".tools", "pnpm", "10.28.0", "node_modules", "pnpm"), "10.28.0");
  assert.equal(pnpmEntry(bin, "10.28.0", home), entry);
});
