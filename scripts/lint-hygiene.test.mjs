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

// X1-R2: the supervisor never parses package bytes. The supervisor-safe ext files carry the same budget as
// `supervisor/`, minus the installer names the ext layer may not need either; the worker-side files (`inspect.rs`,
// `stage.rs`) are the only ones that may name the parser crates.
const EXT_SAFE = ["mod", "paths", "state", "index", "overlays", "host", "worker", "commit", "lifecycle", "remove", "list"];

test("flags package-parsing names in the supervisor-safe ext files", () => {
  for (const line of [
    "use plur1bus_ext::verify;",
    "use plur1bus_ext::zipaudit::audit;",
    "let p = plur1bus_ext::pack::pack_dir(d);",
    "plur1bus_ext::normalise::normalise_skill(x);",
    "use crate::install::archive::extract;",
    "let z = zip::ZipArchive::new(f);",
    "use flate2::read::GzDecoder;",
    "use minisign_verify::PublicKey;",
  ]) {
    for (const f of EXT_SAFE) {
      const r = lintTree({ [`crates/plur1bus/src/ext/${f}.rs`]: `use std::fs;\n${line}\n` });
      assert.equal(r.status, 1, `${f}.rs: ${line}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, new RegExp(`crates/plur1bus/src/ext/${f}\\.rs:2: supervisor must not parse package bytes`));
    }
  }
});

test("the worker-side ext files and the light plur1bus_ext modules pass", () => {
  const r = lintTree({
    "crates/plur1bus/src/ext/stage.rs": "use plur1bus_ext::verify;\nuse zip::ZipArchive;\nuse crate::install::archive::extract;\n",
    "crates/plur1bus/src/ext/inspect.rs": "use plur1bus_ext::verify;\nuse plur1bus_ext::zipaudit;\n",
    "crates/plur1bus/src/ext/commit.rs": "use plur1bus_ext::compat::capability_hash;\nuse plur1bus_ext::refusal::Refusal;\nuse plur1bus_ext::manifest::FileEntry;\nuse plur1bus_ext::trust::TrustStore;\n// verify, pack and normalise in prose are fine\nlet verified = 1; // plur1bus_ext_verify\n",
    "crates/plur1bus/src/ext/host.rs": "use plur1bus_ext::compat::HostFacts;\n",
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /hygiene ok/);
});
