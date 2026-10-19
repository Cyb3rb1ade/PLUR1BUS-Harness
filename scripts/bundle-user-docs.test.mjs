import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const modPath = fileURLToPath(new URL("../packages/web/scripts/bundle-user-docs.ts", import.meta.url));
const { bundleDocs, checkBundle } = await import(modPath);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), "p1b-help-bundle-"));
  try {
    const docs = join(root, "docs");
    const out = join(root, "out");
    for (const lang of ["de", "en"]) {
      mkdirSync(join(docs, lang), { recursive: true });
      writeFileSync(join(docs, lang, "index.md"), `# Index ${lang}\n`);
      writeFileSync(join(docs, lang, "page.md"), `# Page ${lang}\n\nBody\n`);
    }
    return fn(docs, out);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("freshly generated bundle passes check and check does not write", () => fixture((docs, out) => {
  bundleDocs({ userDocsDir: docs, outDir: out });
  assert.deepEqual(checkBundle({ userDocsDir: docs, outDir: out }), []);
}));

test("edited source doc, missing file and stale file are all reported", () => fixture((docs, out) => {
  bundleDocs({ userDocsDir: docs, outDir: out });
  writeFileSync(join(docs, "en", "page.md"), "# Page en\n\nChanged\n");
  writeFileSync(join(docs, "de", "neu.md"), "# Neu\n");
  writeFileSync(join(out, "en", "old.ts"), "export const doc = {};\n");
  assert.deepEqual(checkBundle({ userDocsDir: docs, outDir: out }), [
    "differs: de-index.ts",
    "differs: en/page.ts",
    "missing: de/neu.ts",
    "stale (no source doc): en/old.ts",
  ]);
}));

test("check mode leaves the bundle untouched; regeneration prunes stale files", () => fixture((docs, out) => {
  bundleDocs({ userDocsDir: docs, outDir: out });
  writeFileSync(join(out, "en", "old.ts"), "x\n");
  const before = readFileSync(join(out, "en", "old.ts"), "utf8");
  checkBundle({ userDocsDir: docs, outDir: out });
  assert.equal(readFileSync(join(out, "en", "old.ts"), "utf8"), before);
  bundleDocs({ userDocsDir: docs, outDir: out });
  assert.deepEqual(checkBundle({ userDocsDir: docs, outDir: out }), []);
}));

test("CLI --check exits 0 on the committed bundle", () => {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings=ExperimentalWarning", modPath, "--check"], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("CLI --check fails on a stale bundle when the checkout path contains spaces", () => {
  // The entry guard compared import.meta.url with a raw `file://${argv[1]}` string, so under a path with spaces (or on
  // Windows) the CLI silently did nothing and exited 0 whatever the bundle looked like.
  // Keep this regression about spaces; macOS /var and /tmp aliases are separate entry-guard behavior.
  const root = mkdtempSync(join(realpathSync(tmpdir()), "p1b-help-cli-"));
  try {
    const repo = join(root, "with space");
    mkdirSync(join(repo, "packages/web/scripts"), { recursive: true });
    copyFileSync(modPath, join(repo, "packages/web/scripts/bundle-user-docs.ts"));
    for (const lang of ["de", "en"]) {
      mkdirSync(join(repo, "docs/user", lang), { recursive: true });
      writeFileSync(join(repo, "docs/user", lang, "index.md"), `# Index ${lang}\n`);
    }
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings=ExperimentalWarning", join(repo, "packages/web/scripts/bundle-user-docs.ts"), "--check"], { encoding: "utf8" });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /out of date/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
