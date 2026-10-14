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

test("Out::fail: code, key and the last argument as exit", () => {
  const src = `fn run(out: &Out) {
    out.fail("E_INVALID_PARAMS", "bad", json!({ "a": [1, 2] }), 2);
    out.fail(
        "E_STORAGE",
        &format!("cannot write {}, sorry", p),
        json!({}),
        1,
    );
  }`;
  assert.deepEqual(codes(src), [
    ["Out::fail", "E_INVALID_PARAMS", 2],
    ["Out::fail", "E_STORAGE", 1],
  ]);
  const [first] = extract(src);
  assert.equal(first.context, "run");
  assert.equal(first.line, 2);
});

test("the definition of fail and calls with another arity are ignored", () => {
  const src = `pub fn fail(&self, code: &str, message: &str, extra: Value, exit: i32) -> ! { std::process::exit(exit) }
  fn other() { x.fail(1, 2); }`;
  assert.deepEqual(codes(src), [["exit", "", null]]);
});

test("a non-literal exit is reported with code null", () => {
  const [f] = extract(`fn f(out: &Out, e: E) { out.fail(e.code, "m", json!({}), exit_code_for(e.code)) }`);
  assert.equal(f.code, null);
  assert.equal(f.expr, "exit_code_for(e.code)");
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

test("(code, exit) tuples as in BackupError::code", () => {
  const src = `fn code(&self) { match self.reason { "core-running" => ("E_LOCKED", 3), _ => ("E_INVALID_PARAMS", 1) } }`;
  assert.deepEqual(codes(src), [["code-map", "E_LOCKED", 3], ["code-map", "E_INVALID_PARAMS", 1]]);
});

test("comments and string contents do not produce sites", () => {
  const src = `// out.fail("E_X", "m", json!({}), 9);
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
    ...extract(`fn a(out: &Out) { out.fail("E_X", "m", json!({}), 4); out.fail("E_Y", "m", json!({}), 1); }`),
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
  const r = cli(`fn run(out: &Out) {\n    out.fail("E_X", "m", json!({}), 42);\n}`, md("| 0 | ok |\n| 1 | fail |"));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /exit 42 +.*a\.rs:2 +Out::fail run E_X/);
});

test("--check is green once the code is in the table", () => {
  const r = cli(`fn run(out: &Out) { out.fail("E_X", "m", json!({}), 42); }`, md("| 42 | new |"));
  assert.equal(r.status, 0, r.stderr);
});

test("--check is red when the section is missing", () => {
  const r = cli(`fn f() { exit(1) }`, "# T\n\n## Exit codes\n");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no "## CLI-Exit-Codes" section/);
});

test("a char literal or raw string holding a bracket does not hide an exit site", () => {
  // splitArgs only knew "..." strings: `')'` closed the call early and the site (with its exit code) was dropped, so an
  // undocumented code passed the check.
  assert.deepEqual(codes(`fn a(o: &Out) { o.fail("E_X", format!("{}", ')'), None, 77); }`), [["Out::fail", "E_X", 77]]);
  assert.deepEqual(codes(`fn a(o: &Out) { o.fail("E_X", r#"a"b)"#, None, 78); }`), [["Out::fail", "E_X", 78]]);
  assert.deepEqual(codes(`fn a() { std::process::exit(if c == '(' { 80 } else { 81 }); }`).map((c) => c[2]), [80, 81]);
  assert.deepEqual(splitArgs(`f(')', 2)`, 1)?.args, ["')'", "2"]);
});

test("a char literal brace does not end an exit_code_for body or a test module early", () => {
  const body = `fn exit_code_for(code: &str) -> i32 {
    let _brace = '}';
    match code {
        "E_A" => 3,
        _ => 1,
    }
}`;
  assert.deepEqual(codes(body).map((c) => [c[1], c[2]]), [["E_A", 3], ["(any other code)", 1]]);
  const withTests = `fn real() { std::process::exit(4); }\n#[cfg(test)]\nmod tests {\n    fn t() { let _c = '{'; std::process::exit(99); }\n}\nfn after() { std::process::exit(5); }\n`;
  assert.deepEqual(codes(dropTestModules(withTests)).map((c) => c[2]), [4, 5]);
});
