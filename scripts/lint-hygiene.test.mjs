// Unit tests for scripts/lint-hygiene.mjs (run by `pnpm lint`), including fixture-backed positive and negative cases
// for every rule.
import "./never-list.test.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./lint-hygiene.mjs", import.meta.url));
const fixtureDir = fileURLToPath(new URL("./fixtures/hygiene/", import.meta.url));

function fixture(id, kind) {
  const path = join(fixtureDir, `${id}-${kind}.${id === "HYG-013" && kind === "reject" ? "json" : "txt"}`);
  const text = readFileSync(path, "utf8");
  return id === "HYG-013" && kind === "reject" ? JSON.parse(text).join(" ") : text;
}

function lintTree(files, { links = {}, cwd = "" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "p1b-hygiene-"));
  try {
    for (const [rel, text] of Object.entries(files)) {
      const p = join(root, ...rel.split("/"));
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, text);
    }
    for (const [rel, target] of Object.entries(links)) symlinkSync(target, join(root, ...rel.split("/")));
    for (const args of [["init", "--quiet"], ["add", "--all"]]) {
      const git = spawnSync("git", args, { cwd: root, encoding: "utf8" });
      assert.equal(git.status, 0, git.stderr);
    }
    return spawnSync(process.execPath, [script], { cwd: join(root, cwd), encoding: "utf8" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const RULE_FIXTURES = [
  ["HYG-001", "packages/sample/src/example.ts"],
  ["HYG-002", "packages/sample/src/example.ts"],
  ["HYG-003", "packages/sample/src/example.ts"],
  ["HYG-004", "packages/sample/src/example.ts"],
  ["HYG-005", "crates/plur1bus/src/supervisor/example.rs"],
  ["HYG-006", "crates/plur1bus/src/supervisor/example.rs"],
  ["HYG-007", "crates/plur1bus/src/ext/state.rs"],
  ["HYG-008", "crates/plur1bus/src/ext/state.rs"],
  ["HYG-009", "crates/plur1bus/src/ext/state.rs"],
  ["HYG-010", "crates/plur1bus/src/ext/state.rs"],
  ["HYG-011", "crates/plur1bus/src/ext/unclassified.rs", "crates/plur1bus/src/ext/record.rs"],
  ["HYG-012", "x.p12", "x.txt"],
  ["HYG-013", "docs/synthetic.txt"],
];

for (const [id, rejectPath, allowPath = rejectPath] of RULE_FIXTURES) {
  test(`${id} detects its forbidden fixture and accepts its clean fixture`, () => {
    const reject = lintTree({ [rejectPath]: fixture(id, "reject") });
    assert.equal(reject.status, 1, `${id}: ${reject.stdout}${reject.stderr}`);
    assert.match(reject.stderr, new RegExp(`\\[${id}\\]`));

    const allow = lintTree({ [allowPath]: fixture(id, "allow") });
    assert.equal(allow.status, 0, `${id}: ${allow.stdout}${allow.stderr}`);
  });
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
const EXT_WORKER = ["inspect", "stage"];

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

test("flags grouped imports, also over several lines", () => {
  for (const text of [
    "use plur1bus_ext::{compat, verify};\n",
    "use plur1bus_ext::{\n    compat::HostFacts,\n    zipaudit,\n};\n",
    "use plur1bus_ext::{pack::pack_dir, refusal::Refusal};\n",
    "use zip::{ZipArchive, ZipWriter};\n",
    "use crate::install::{archive, fetch};\n",
    "use crate::install::{\n    fetch,\n    archive::extract,\n};\n",
  ]) {
    for (const f of EXT_SAFE) {
      const r = lintTree({ [`crates/plur1bus/src/ext/${f}.rs`]: text });
      assert.equal(r.status, 1, `${f}.rs: ${text}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /supervisor must not parse package bytes/);
    }
    const w = lintTree({ "crates/plur1bus/src/ext/stage.rs": text });
    assert.equal(w.status, 0, `stage.rs: ${text}: ${w.stderr}`);
  }
  const ok = lintTree({
    "crates/plur1bus/src/ext/state.rs": "use plur1bus_ext::{\n    manifest::FileEntry,\n    refusal::Refusal,\n};\nuse crate::install::{targets, pins};\n",
  });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
});

test("every file under ext/ is supervisor-safe or worker-side", () => {
  for (const f of [...EXT_SAFE, ...EXT_WORKER]) {
    const r = lintTree({ [`crates/plur1bus/src/ext/${f}.rs`]: "//! placeholder\n" });
    assert.equal(r.status, 0, `${f}.rs: ${r.stdout}${r.stderr}`);
  }
  const r = lintTree({ "crates/plur1bus/src/ext/newfile.rs": "//! not classified\n" });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /ext\/newfile\.rs:1: ext file is in neither EXT_SAFE nor EXT_WORKER/);
});

// HM2 (F23): the Python client under clients/ and the host adapters under hosts/ are scanned too, .py included.
// The forbidden names are assembled at run time, so this file does not trip the rule it tests.
const HOST = ["Open", "Claw"].join("");
test("flags the host name in clients/ and hosts/, .py and README.md included", () => {
  for (const [rel, text] of [
    ["hosts/hermes/plur1bus/mapping.py", `import os\nHOST = '${HOST}'\n`],
    ["clients/python/plur1bus-memory-client/README.md", `# client\nWorks like the ${HOST.toLowerCase()} plugin.\n`],
    ["clients/python/plur1bus-memory-client/src/plur1bus_memory_client/client.py", `x = 1\nENV = '${HOST.toUpperCase()}_STATE_DIR'\n`],
    ["hosts/hermes/tests/test_x.py", "import os\nCMD = \"/forget\"\n"],
  ]) {
    const r = lintTree({ [rel]: text });
    assert.equal(r.status, 1, `${rel}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, new RegExp(`${rel.replaceAll(".", "\\.")}:2: `));
  }
});

test("a clean clients/ and hosts/ tree passes, bytecode caches are skipped", () => {
  const r = lintTree({
    "clients/python/plur1bus-memory-client/src/plur1bus_memory_client/client.py": "import socket\n# Hermes host mode\n",
    "clients/python/plur1bus-memory-client/README.md": "# plur1bus-memory-client\n",
    "hosts/hermes/plur1bus/plugin.yaml": "name: plur1bus\n",
    "hosts/hermes/plur1bus/__pycache__/cached.py": `HOST = '${HOST.toLowerCase()}'\n`,
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /hygiene ok/);
});

// Only synthetic headers are constructed here; no key material is stored.
test("rejects tracked secret and image files without printing their contents", () => {
  for (const name of ["x.p12", "x.p8", "x.pfx", "x.key", "x.pem", "x.keystore", "x.oci.tar"]) {
    const r = lintTree({ [name]: "synthetic-sensitive-content" });
    assert.equal(r.status, 1, name);
    assert.match(r.stderr, /forbidden tracked file/);
    assert.doesNotMatch(r.stderr, /synthetic-sensitive-content/);
  }
});
test("rejects private key headers regardless of extension or directory", () => {
  for (const header of ["-----BEGIN " + "PRIVATE KEY-----", "-----BEGIN RSA " + "PRIVATE KEY-----", "untrusted comment: " + "minisign secret key"]) {
    const r = lintTree({ "docs/synthetic.txt": header });
    assert.equal(r.status, 1, header);
    assert.match(r.stderr, /private key header/);
    assert.doesNotMatch(r.stderr, /BEGIN/);
  }
});
test("allows a public key and applies existing source hygiene to apps", () => {
  assert.equal(lintTree({ "apps/desktop/keys/update.pub": "synthetic-public-value" }).status, 0);
  assert.equal(lintTree({ "apps/desktop/src/test.rs": "use host_services; // " + "open" + "claw" }).status, 1);
});

test("allows the plan's quoted header example but still rejects a key in that file", () => {
  const path = "docs/superpowers/plans/2026-09-27-desktop-app-d1.md";
  const header = "untrusted comment: " + "minisign secret key";
  assert.equal(lintTree({ [path]: `Example: \`${header}\`` }).status, 0);
  assert.equal(lintTree({ [path]: `Example: \`${header}\`\n${header}` }).status, 1);
});

const HOST_NAME = ["Open", "Claw"].join("");
test("a dangling symlink does not end the walk early (files after it are still scanned)", () => {
  // "a-dangling.ts" sorts before "z.ts" and before "packages/zz"; the walk used to throw on it and silently skip the rest.
  const r = lintTree(
    { "packages/s/z.ts": `const a = "${HOST_NAME}";\n`, "packages/zz/y.ts": `const b = "${HOST_NAME}";\n` },
    { links: { "packages/s/a-dangling.ts": "/nonexistent-target" } },
  );
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /packages\/s\/z\.ts:1:/);
  assert.match(r.stderr, /packages\/zz\/y\.ts:1:/);
});

test("run from a subdirectory it still scans the whole repository", () => {
  const r = lintTree({ "packages/s/z.ts": `const a = "${HOST_NAME}";\n`, "tests/keep.txt": "x\n" }, { cwd: "tests" });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /packages\/s\/z\.ts:1:/);
});

test("paths with spaces are scanned and reported, and many files share one blob read", () => {
  const files = { "packages/a b/c d.ts": `const a = "${HOST_NAME}";\n` };
  for (let i = 0; i < 300; i++) files[`packages/bulk/f${i}.ts`] = "export const same = 1;\n";
  const r = lintTree(files);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /packages\/a b\/c d\.ts:1:/);
  assert.match(r.stderr, /hygiene: 1 violation/);
});

test("D110 foreign-client lint applies before importer exemptions and scans desktop TSX", () => {
  for (const path of ["packages/core/src/import/probe.ts", "desktop/src/probe.tsx", "apps/desktop/ui/src/probe.tsx"]) {
    const r = lintTree({ [path]: 'const forbidden = "CODEX_' + 'APP_SERVER_LOGIN_CLIENT_ID";\n' });
    assert.equal(r.status, 1); assert.match(r.stderr, /HYG-014/);
    assert.doesNotMatch(r.stderr, /APP_SERVER_LOGIN_CLIENT_ID/);
  }
});
test("D110 workflow lint rejects an offline job using a provider credential", () => {
  const r = lintTree({ ".github/workflows/ci.yml": 'jobs:\n  offline:\n    env:\n      KEY: ${{ secrets.OPENAI_API_KEY }}\n' });
  assert.equal(r.status, 1); assert.match(r.stderr, /HYG-015/);
});
test('HYG-003 permits Rust test container mounts without per-file exceptions and still rejects commands', () => {
  const mounts = readFileSync(join(fixtureDir, 'HYG-003-mounts.txt'), 'utf8');
  const allowed = lintTree({ 'crates/example/tests/container.rs': mounts });
  assert.equal(allowed.status, 0, allowed.stderr);
  const state = '/' + 'state', forget = '/' + 'forget';
  for (const text of [fixture('HYG-003', 'reject'), `dispatch(${JSON.stringify(forget)});`, `dispatch(${JSON.stringify(state)});`, mounts.split('\n')[0] + ` dispatch(${JSON.stringify(forget)});`, mounts.split('\n')[0] + ` dispatch(${JSON.stringify(state)});`]) {
    const denied = lintTree({ 'crates/example/tests/container.rs': text });
    assert.equal(denied.status, 1, text);
    assert.match(denied.stderr, /HYG-003/);
  }
});
