import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  documentedCodes,
  dropTestModules,
  extract,
  missing,
  splitArgs,
  stripComments,
} from "./check-cli-exit-codes.mjs";

const script = fileURLToPath(new URL("./check-cli-exit-codes.mjs", import.meta.url));
const codes = (src, file) => extract(src, file).map((f) => [f.kind, f.key, f.code]);

const table = { E_INVALID_PARAMS: 2, E_LOCKED: 3, "(any other code)": 1 };
const derived = (src, file) => extract(src, file, {}, table).map((f) => [f.kind, f.key, f.code]);

test("Out::fail: the exit is derived from the code through the table", () => {
  const src = `fn run(out: &Out) {
    out.fail("E_INVALID_PARAMS", "bad", json!({ "a": [1, 2] }));
    out.fail(
        "E_STORAGE",
        &format!("cannot write {}, sorry", p),
        json!({}),
    );
    out.fail(code, "m", json!({}));
  }`;
  assert.deepEqual(derived(src), [
    ["Out::fail", "E_INVALID_PARAMS", 2],
    ["Out::fail", "E_STORAGE", 1],
    ["Out::fail", "<code>", null],
  ]);
  const [first] = extract(src, "<memory>", {}, table);
  assert.equal(first.context, "run");
  assert.equal(first.line, 2);
});

test("Out::fail_exit: code, key and the last argument as exit", () => {
  const src = `fn run(out: &Out) {
    out.fail_exit("E_CANCELLED", "m", json!({}), crate::output::EXIT_INTERRUPTED);
    out.fail_exit(code, "m", json!({}), exit);
  }`;
  const f = extract(src, "<memory>", { EXIT_INTERRUPTED: 130 });
  assert.deepEqual(f.map((x) => [x.kind, x.key, x.code]), [
    ["Out::fail_exit", "E_CANCELLED", 130],
    ["Out::fail_exit", "<code>", null],
  ]);
});

test("the definition of fail and calls with another arity are ignored", () => {
  const src = `pub fn fail(&self, code: &str, message: &str, extra: Value) -> ! { std::process::exit(2) }
  fn other() { x.fail(1, 2); x.fail(1, 2, 3, 4); }`;
  assert.deepEqual(codes(src), [["exit", "", 2]]);
});

test("a non-literal exit is reported with code null", () => {
  const [f] = extract(`fn f(out: &Out, e: E) { out.fail_exit(e.code, "m", json!({}), importer_exit(e)) }`);
  assert.equal(f.code, null);
  assert.equal(f.expr, "importer_exit(e)");
});

test("process::exit, output::exit and bare exit, with if/else literals", () => {
  const src = `fn a() { std::process::exit(130) }
  fn b() { crate::output::exit(if clean { 0 } else { 1 }) }
  fn c() { exit(3) }
  fn d(x: i32) { std::process::exit(x) }`;
  assert.deepEqual(
    extract(src).map((f) => [f.context, f.code]),
    [["a", 130], ["b", 0], ["b", 1], ["c", 3], ["d", null]],
  );
});

test("EXIT_* constants resolve, also through super::", () => {
  const src = `pub const EXIT_PANIC: i32 = 70;\nfn die() { std::process::exit(super::EXIT_PANIC) }`;
  assert.deepEqual(extract(src).filter((f) => f.kind === "exit").map((f) => f.code), [70]);
  assert.deepEqual(extract("fn x() { exit(super::EXIT_PANIC) }", "a.rs", { EXIT_PANIC: 70 }).map((f) => f.code), [70]);
});

test("supervisor fail(layout, N, msg) is recognised, but only as a free function", () => {
  const src = `fn fail(layout: &Layout, code: i32, msg: &str) -> ! { std::process::exit(code) }
  fn run() { fail(layout, 3, "already running"); self.fail(layout, 9, "x"); }`;
  const f = extract(src, "crates/plur1bus/src/supervisor/mod.rs").filter((x) => x.kind === "supervisor::fail");
  assert.deepEqual(f.map((x) => x.code), [3]);
});

test("exit_code_for and fn exit(&self) arms, including alternatives and the default", () => {
  const src = `fn exit_code_for(c: &str) -> i32 { match c { "E_LOCKED" => 3, "E_NOT_AVAILABLE" | "E_APPROVAL_REQUIRED" => 2, _ => 1 } }`;
  assert.deepEqual(
    extract(src).map((f) => [f.key, f.code]),
    [["E_LOCKED", 3], ["E_NOT_AVAILABLE", 2], ["E_APPROVAL_REQUIRED", 2], ["(any other code)", 1]],
  );
  const m = `fn exit(&self) -> i32 { match self.code.as_str() { "E_LOCKED" => 3, _ => 1 } }`;
  assert.deepEqual(extract(m).map((f) => f.code), [3, 1]);
});

test("comments and string contents do not produce sites", () => {
  const src = `// out.fail_exit("E_X", "m", json!({}), 9);
  /* std::process::exit(8) */
  fn f() { let s = "std::process::exit(7)"; let r = r#"exit(6)"#; }`;
  assert.deepEqual(extract(src), []);
  assert.equal(stripComments(src).length, src.length);
});

test("#[cfg(test)] modules are dropped", () => {
  const src = `fn f() { std::process::exit(1) }\n#[cfg(test)]\nmod tests { fn t() { std::process::exit(99) } fn u() { let _ = "}"; } }\nfn g() { exit(2) }`;
  assert.deepEqual(extract(dropTestModules(src)).map((f) => f.code), [1, 2]);
});

test("splitArgs keeps nested brackets and strings together", () => {
  const src = `f(a, "x, y)", g(1, 2), [3, 4], { 5, 6 })`;
  assert.deepEqual(splitArgs(src, 1).args, ["a", `"x, y)"`, "g(1, 2)", "[3, 4]", "{ 5, 6 }"]);
  assert.equal(splitArgs("f(a, b", 1), null);
});

const md = (rows) => `# T\n\n## Exit codes\n\n| Exit |\n|---|\n| 9 |\n\n## CLI-Exit-Codes\n\n| Exit | Meaning |\n|---|---|\n${rows}\n\n### Inconsistencies\n\n| 77 | not a row of the table |\n\n## Next\n\n| 55 | x |\n`;

test("documentedCodes reads only the CLI-Exit-Codes table: lists, ranges and the section end", () => {
  assert.deepEqual(
    [...documentedCodes(md("| 0 | ok |\n| 2, 3 | two |\n| `4..6` | range |\n| 130 | x |"))].sort((a, b) => a - b),
    [0, 2, 3, 4, 5, 6, 130, 77].sort((a, b) => a - b),
  );
  assert.equal(documentedCodes("# T\n\n## Exit codes\n"), null);
});

test("missing: undocumented literal codes only; dynamic and constants are skipped", () => {
  const found = [
    ...extract(`fn a(out: &Out) { out.fail_exit("E_X", "m", json!({}), 4); out.fail("E_Y", "m", json!({})); }`, "<memory>", {}, { "(any other code)": 1 }),
    ...extract(`const EXIT_Z: i32 = 99;\nfn b(x: i32) { std::process::exit(x) }`),
  ];
  assert.deepEqual(missing(found, new Set([0, 1])).map((f) => f.code), [4]);
});

test("--check passes on the repository (docs/errors.md lists every exit code in use)", () => {
  const r = spawnSync(process.execPath, [script, "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /all documented/);
});

function cli(rs, doc) {
  const root = mkdtempSync(join(tmpdir(), "p1b-exit-codes-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.rs"), rs);
    writeFileSync(join(root, "errors.md"), doc);
    return spawnSync(process.execPath, [script, "--check"], {
      encoding: "utf8",
      env: { ...process.env, P1B_EXIT_SRC: join(root, "src"), P1B_EXIT_DOC: join(root, "errors.md") },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("--check goes red for an exit code that the table lacks, and names the site", () => {
  const r = cli(`fn run(out: &Out) {\n    out.fail_exit("E_X", "m", json!({}), 42);\n}`, md("| 0 | ok |\n| 1 | fail |"));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /exit 42 +.*a\.rs:2 +Out::fail_exit run E_X/);
});

test("--check is green once the code is in the table", () => {
  const r = cli(`fn run(out: &Out) { out.fail_exit("E_X", "m", json!({}), 42); }`, md("| 42 | new |"));
  assert.equal(r.status, 0, r.stderr);
});

test("--check is red when the section is missing", () => {
  const r = cli(`fn f() { exit(1) }`, "# T\n\n## Exit codes\n");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no "## CLI-Exit-Codes" section/);
});

test("--check follows the derived exit of Out::fail through exit_code_for", () => {
  const rs = `fn exit_code_for(c: &str) -> i32 { match c { "E_LOCKED" => 7, _ => 1 } }\nfn run(out: &Out) { out.fail("E_LOCKED", "m", json!({})); }`;
  const red = cli(rs, md("| 0 | ok |\n| 1 | fail |"));
  assert.equal(red.status, 1);
  assert.match(red.stderr, /exit 7 /);
  assert.equal(cli(rs, md("| 1, 7 | x |")).status, 0);
});
