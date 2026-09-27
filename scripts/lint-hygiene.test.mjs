// Unit test for scripts/lint-hygiene.mjs (run by `pnpm lint`): the supervisor dependency-budget rule (spec §4,
// 2a-H3b-b Task 3) flags installer crates under a copy of `crates/plur1bus/src/supervisor/`, and only there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./lint-hygiene.mjs", import.meta.url));

function lintTree(files) {
  const root = mkdtempSync(join(tmpdir(), "p1b-hygiene-"));
  try {
    for (const [rel, text] of Object.entries(files)) {
      const p = join(root, ...rel.split("/"));
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, text);
    }
    return spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("flags `use ureq;` under supervisor/", () => {
  const r = lintTree({ "crates/plur1bus/src/supervisor/child.rs": "use std::fs;\nuse ureq;\n" });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /crates\/plur1bus\/src\/supervisor\/child\.rs:2: supervisor dependency budget/);
});

test("flags every installer name under supervisor/", () => {
  for (const line of [
    "use flate2::read::GzDecoder;",
    "let a = tar::Archive::new(r);",
    "use tar::{Archive, EntryType};",
    "let z = zip::ZipArchive::new(f);",
    "use minisign_verify::PublicKey;",
    "crate::install::fetch::fetch_bytes(u, 1, d);",
    "use crate::install::archive::extract;",
  ]) {
    const r = lintTree({ "crates/plur1bus/src/supervisor/mod.rs": `${line}\n` });
    assert.equal(r.status, 1, `${line}: ${r.stderr}`);
  }
});

test("the installer itself and a clean supervisor pass", () => {
  const r = lintTree({
    "crates/plur1bus/src/install/fetch.rs": "use ureq;\nuse flate2;\n",
    "crates/plur1bus/src/supervisor/mod.rs": "use std::fs;\n// a tarball is not a tar:: import\n",
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /hygiene ok/);
});
