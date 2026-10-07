// scripts/audit-deps.mjs: licence evaluation, exceptions, collectors and the CLI, all on small fixture trees in temp
// directories with an injected command runner (no installs, no network, no real pnpm/cargo/python).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateLicense, judge, main, parseArgs, parseCargoAudit, parseCargoMetadata, parseExceptions, parsePnpmAudit,
  parsePnpmLicenses, parsePolicy, parsePyproject, pythonLicense, requirementName, FAILING,
} from "../audit-deps.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const POLICY_MD = readFileSync(join(REPO, "docs/dependency-policy.md"), "utf8");
const policy = parsePolicy(POLICY_MD);
const verdict = (expr) => evaluateLicense(expr, policy.allowed).verdict;

describe("policy document", () => {
  it("lists exactly the agreed licences", () => {
    assert.deepEqual([...policy.allowed].sort(), ["0bsd", "apache-2.0", "bsd-2-clause", "bsd-3-clause", "cc0-1.0", "isc", "mit", "mpl-2.0", "unicode-3.0", "unicode-dfs-2016"]);
  });
  it("rejects a document without the marker block or with an empty one", () => {
    assert.throws(() => parsePolicy("# nothing"), /missing/);
    assert.throws(() => parsePolicy("<!-- audit-deps:allowed -->\n<!-- /audit-deps:allowed -->"), /empty/);
  });
});

describe("evaluateLicense", () => {
  it("allows every listed licence", () => {
    for (const l of ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "MPL-2.0", "Unicode-3.0", "0BSD", "CC0-1.0", "mit"]) assert.equal(verdict(l), "ok", l);
  });
  it("forbids strong copyleft", () => {
    for (const l of ["GPL-3.0-only", "AGPL-3.0-or-later", "SSPL-1.0", "GPL-2.0+"]) assert.equal(verdict(l), "forbidden", l);
  });
  it("treats missing, placeholder and unparsable licences as unknown", () => {
    for (const l of [null, undefined, "", "UNKNOWN", "UNLICENSED", "SEE LICENSE IN LICENSE.txt", "MIT AND", "(MIT", "MIT OR OR ISC", "LicenseRef-Proprietary", "weird $text"]) assert.equal(verdict(l), "unknown", String(l));
  });
  it("reports a well-formed but unlisted licence as not-listed", () => {
    assert.equal(verdict("Zlib"), "not-listed");
    assert.ok(FAILING.has("not-listed"));
  });
  it("OR needs one allowed alternative", () => {
    assert.equal(verdict("MIT OR GPL-3.0-only"), "ok");
    assert.equal(verdict("(GPL-2.0-only OR Apache-2.0)"), "ok");
    assert.equal(verdict("GPL-3.0-only OR AGPL-3.0-only"), "forbidden");
    assert.equal(verdict("Zlib OR BSL-1.0"), "not-listed");
  });
  it("AND needs every part allowed", () => {
    assert.equal(verdict("MIT AND Apache-2.0"), "ok");
    assert.equal(verdict("MIT AND GPL-3.0-only"), "forbidden");
    assert.equal(verdict("MIT AND Zlib"), "not-listed");
  });
  it("handles precedence, parentheses, WITH and cargo's legacy slash", () => {
    assert.equal(verdict("MIT OR GPL-3.0-only AND Zlib"), "ok"); // AND binds tighter
    assert.equal(verdict("(MIT OR ISC) AND Zlib"), "not-listed");
    assert.equal(verdict("Apache-2.0 WITH LLVM-exception"), "ok");
    assert.equal(verdict("GPL-2.0-only WITH Classpath-exception-2.0"), "forbidden");
    assert.equal(verdict("MIT/Apache-2.0"), "ok");
    assert.equal(verdict("Unlicense/MIT"), "ok");
    assert.equal(verdict("MIT or apache-2.0"), "ok");
  });
  it("flags MPL-2.0 reliance but prefers an alternative that avoids it", () => {
    const only = judge([{ ecosystem: "cargo", name: "a", version: "1", license: "MPL-2.0" }], policy).rows[0];
    assert.equal(only.verdict, "ok");
    assert.match(only.note, /unmodified/);
    const dual = judge([{ ecosystem: "cargo", name: "b", version: "1", license: "MPL-2.0 OR MIT" }], policy).rows[0];
    assert.equal(dual.note, "");
  });
});

describe("exceptions", () => {
  const entry = { ecosystem: "cargo", name: "dual", version: "1.0.0", license: "Zlib" };
  const ex = (o = {}) => ({ ecosystem: "cargo", name: "dual", license: "Zlib", reason: "reviewed, permissive in substance", ...o });

  it("turns a failing entry into an exception, keeping the reason", () => {
    const { rows, stale } = judge([entry], policy, [ex()]);
    assert.equal(rows[0].verdict, "exception");
    assert.match(rows[0].note, /reviewed/);
    assert.deepEqual(stale, []);
  });
  it("honours a version pin and does not cover other versions", () => {
    assert.equal(judge([entry], policy, [ex({ version: "1.0.0" })]).rows[0].verdict, "exception");
    const other = judge([entry], policy, [ex({ version: "2.0.0" })]);
    assert.equal(other.rows[0].verdict, "not-listed");
    assert.equal(other.stale.length, 1);
  });
  it("stops covering a package whose licence changed", () => {
    const { rows } = judge([{ ...entry, license: "GPL-3.0-only" }], policy, [ex()]);
    assert.equal(rows[0].verdict, "forbidden");
    assert.match(rows[0].note, /does not cover/);
  });
  it("reports exceptions that match nothing, and never needs one for an allowed licence", () => {
    const { rows, stale } = judge([{ ...entry, license: "MIT" }], policy, [ex()]);
    assert.equal(rows[0].verdict, "ok");
    assert.equal(stale.length, 1);
  });
  it("validates the exceptions file", () => {
    assert.deepEqual(parseExceptions('{"exceptions":[]}'), []);
    assert.equal(parseExceptions(JSON.stringify({ exceptions: [ex()] })).length, 1);
    assert.throws(() => parseExceptions("{"), /not valid JSON/);
    assert.throws(() => parseExceptions("{}"), /exceptions/);
    assert.throws(() => parseExceptions(JSON.stringify({ exceptions: [ex({ reason: " " })] })), /reason/);
    assert.throws(() => parseExceptions(JSON.stringify({ exceptions: [ex({ ecosystem: "npm" })] })), /ecosystem/);
  });
  it("ships a valid, empty exceptions file", () => {
    assert.deepEqual(parseExceptions(readFileSync(join(REPO, "docs/dependency-exceptions.json"), "utf8")), []);
  });
});

describe("parsers", () => {
  it("pnpm licenses: one row per version, direct names marked", () => {
    const rows = parsePnpmLicenses({
      MIT: [{ name: "left-pad", versions: ["1.3.0", "1.2.0"], license: "MIT" }],
      "(MIT OR CC0-1.0)": [{ name: "type-fest", versions: ["4.0.0"] }],
    }, new Set(["left-pad"]));
    assert.deepEqual(rows.map((r) => [r.name, r.version, r.license, r.direct]), [
      ["left-pad", "1.3.0", "MIT", true], ["left-pad", "1.2.0", "MIT", true], ["type-fest", "4.0.0", "(MIT OR CC0-1.0)", false],
    ]);
  });
  it("cargo metadata: skips workspace members, derives direct deps, reports licence-file-only crates", () => {
    const rows = parseCargoMetadata({
      workspace_members: ["me 0.1.0 (path+file:///x)"],
      packages: [
        { id: "me 0.1.0 (path+file:///x)", name: "me", version: "0.1.0", source: null, license: "MIT", dependencies: [{ name: "serde" }] },
        { id: "serde 1.0.0", name: "serde", version: "1.0.0", source: "registry+x", license: "MIT OR Apache-2.0", dependencies: [{ name: "serde_derive" }] },
        { id: "serde_derive 1.0.0", name: "serde_derive", version: "1.0.0", source: "registry+x", license: "MIT/Apache-2.0", dependencies: [] },
        { id: "ring 0.17.0", name: "ring", version: "0.17.0", source: "registry+x", license: null, license_file: "LICENSE", dependencies: [] },
      ],
    }, "cargo-desktop");
    assert.deepEqual(rows.map((r) => [r.ecosystem, r.name, r.direct, r.license]), [
      ["cargo-desktop", "serde", true, "MIT OR Apache-2.0"],
      ["cargo-desktop", "serde_derive", false, "MIT/Apache-2.0"],
      ["cargo-desktop", "ring", false, "unknown (license-file LICENSE)"],
    ]);
    assert.equal(verdict(rows[2].license), "unknown");
  });
  it("pyproject: reads licence and a multi-line dependency array with comments", () => {
    const p = parsePyproject([
      "[build-system]", 'requires = ["setuptools"]', "", "[project]", 'name = "demo"', 'license = "MIT"  # spdx',
      "dependencies = [", '  "requests>=2; python_version >= \'3.9\'",  # http', '  "tomli",', "]", "", "[tool.x]", 'dependencies = ["no"]',
    ].join("\n"));
    assert.equal(p.name, "demo");
    assert.equal(p.license, "MIT");
    assert.deepEqual(p.dependencies, ["requests>=2; python_version >= '3.9'", "tomli"]);
    assert.deepEqual(parsePyproject('[project]\ndependencies = []\n').dependencies, []);
  });
  it("requirement names and python licence sources", () => {
    assert.equal(requirementName("Foo_Bar[extra]>=1.0; python_version<'3.12'"), "Foo_Bar");
    assert.equal(requirementName("pytest; extra == 'test'"), null);
    assert.equal(pythonLicense({ licenseExpression: "MIT" }), "MIT");
    assert.equal(pythonLicense({ classifiers: ["License :: OSI Approved :: Apache Software License"] }), "Apache-2.0");
    assert.equal(pythonLicense({ license: "BSD" }), "BSD");
    assert.equal(pythonLicense({ license: "x".repeat(200) }), null);
  });
  it("advisory parsers separate findings, clean results and unusable output", () => {
    assert.equal(parsePnpmAudit("not json").status, "skipped");
    assert.equal(parsePnpmAudit('{"error":{"code":"ERR_PNPM_AUDIT_BAD_RESPONSE"}}').status, "skipped");
    assert.equal(parsePnpmAudit('{"advisories":{},"metadata":{"vulnerabilities":{"low":0,"high":0}}}').status, "ok");
    const f = parsePnpmAudit('{"advisories":{"1":{"module_name":"x","title":"bad","severity":"high"}},"metadata":{"vulnerabilities":{"high":1}}}');
    assert.equal(f.status, "findings");
    assert.match(f.findings[0], /x: bad \[high\]/);
    assert.equal(parseCargoAudit("").status, "skipped");
    assert.equal(parseCargoAudit('{"vulnerabilities":{"found":false,"list":[]},"warnings":{"unmaintained":[{"kind":"unmaintained","package":{"name":"a","version":"1"}}]}}').status, "ok");
    assert.equal(parseCargoAudit('{"vulnerabilities":{"found":true,"list":[{"advisory":{"id":"RUSTSEC-1","title":"t"},"package":{"name":"a","version":"1"}}]}}').findings.length, 1);
  });
  it("parses CLI arguments", () => {
    assert.deepEqual(parseArgs(["--only", "pnpm,python"]).only, ["pnpm", "python"]);
    assert.throws(() => parseArgs(["--only", "npm"]), /unknown ecosystem/);
    assert.throws(() => parseArgs(["--root"]), /needs a value/);
    assert.throws(() => parseArgs(["--bogus"]), /unknown argument/);
  });
});

describe("CLI on a fixture tree", () => {
  let root;
  const out = { log: [], err: [] };
  const io = (run) => ({ run, log: (s) => out.log.push(s), err: (s) => out.err.push(s) });
  const text = () => out.log.join("\n");

  const pnpmDoc = { MIT: [{ name: "left-pad", versions: ["1.3.0"] }] };
  const cargoDoc = (license) => ({ workspace_members: ["w"], packages: [
    { id: "w", name: "w", version: "0.1.0", source: null, license: "MIT", dependencies: [{ name: "dep" }] },
    { id: "dep", name: "dep", version: "1.0.0", source: "registry+x", license, dependencies: [] },
  ] });
  const fakeRun = ({ cargo = "MIT OR Apache-2.0", pnpm = pnpmDoc, pnpmFails = false, python = [] } = {}) => (cmd, args) => {
    if (cmd === "pnpm") return pnpmFails ? { status: 1, stdout: "", stderr: "ERR_PNPM_NO_NODE_MODULES", error: null } : { status: 0, stdout: JSON.stringify(pnpm), stderr: "", error: null };
    if (cmd === "cargo") return { status: 0, stdout: JSON.stringify(cargoDoc(cargo)), stderr: "", error: null };
    if (cmd === "python3") return { status: 0, stdout: JSON.stringify(python), stderr: "", error: null };
    return { status: 1, stdout: "", stderr: "", error: "unexpected command" };
  };

  before(() => {
    root = mkdtempSync(join(tmpdir(), "audit-deps-"));
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs/dependency-policy.md"), POLICY_MD);
    writeFileSync(join(root, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
    writeFileSync(join(root, "package.json"), JSON.stringify({ devDependencies: { "left-pad": "1.3.0" } }));
    writeFileSync(join(root, "Cargo.toml"), "[workspace]\n");
    mkdirSync(join(root, "apps/desktop"), { recursive: true });
    writeFileSync(join(root, "apps/desktop/Cargo.toml"), "[workspace]\n");
    mkdirSync(join(root, "clients/python/plur1bus-memory-client"), { recursive: true });
    writeFileSync(join(root, "clients/python/plur1bus-memory-client/pyproject.toml"), '[project]\nname = "c"\nlicense = "MIT"\ndependencies = ["tinydep>=1"]\n');
    mkdirSync(join(root, "hosts/hermes/plur1bus"), { recursive: true });
    writeFileSync(join(root, "hosts/hermes/plur1bus/plugin.yaml"), "name: plur1bus\nversion: 0.1.0\n");
  });
  after(() => rmSync(root, { recursive: true, force: true }));
  const reset = () => { out.log.length = 0; out.err.length = 0; };
  const py = (license) => [{ name: "tinydep", version: "1.0", installed: true, licenseExpression: license }];

  it("passes on allowed licences and prints a per-ecosystem table", () => {
    reset();
    assert.equal(main(["--root", root], io(fakeRun({ python: py("BSD-3-Clause") }))), 0);
    assert.match(text(), /ecosystem\s+packages\s+direct/);
    assert.match(text(), /cargo-desktop\s+1/);
    assert.match(text(), /python\s+1\s+1/);
    assert.match(text(), /OK: no licence violations/);
  });
  it("fails (1) on a forbidden licence and lists it", () => {
    reset();
    assert.equal(main(["--root", root], io(fakeRun({ cargo: "GPL-3.0-only", python: py("MIT") }))), 1);
    assert.match(text(), /dep\s+1\.0\.0\s+direct\s+GPL-3\.0-only\s+FORBIDDEN/);
    assert.match(text(), /FAIL: 2 /); // reached from both cargo workspaces
  });
  it("fails (1) on an unknown python licence and on a not-installed dependency", () => {
    reset();
    assert.equal(main(["--root", root, "--only", "python"], io(fakeRun({ python: py(null) }))), 1);
    assert.match(text(), /UNKNOWN/);
    reset();
    assert.equal(main(["--root", root, "--only", "python"], io(fakeRun({ python: [{ name: "tinydep", installed: false }] }))), 1);
    assert.match(text(), /not installed/);
  });
  it("accepts a recorded exception from the exceptions file", () => {
    reset();
    const exFile = join(root, "ex.json");
    writeFileSync(exFile, JSON.stringify({ exceptions: [
      { ecosystem: "cargo", name: "dep", license: "GPL-3.0-only OR Zlib", reason: "dual licensed, we pick Zlib" },
      { ecosystem: "cargo-desktop", name: "dep", license: "GPL-3.0-only OR Zlib", reason: "same crate" },
    ] }));
    assert.equal(main(["--root", root, "--only", "cargo,cargo-desktop", "--exceptions", exFile], io(fakeRun({ cargo: "GPL-3.0-only OR Zlib" }))), 0);
    assert.match(text(), /EXCEPTION/);
    assert.match(text(), /we pick Zlib/);
  });
  it("exits 3 when an ecosystem cannot be collected, and 0 with --allow-incomplete", () => {
    reset();
    assert.equal(main(["--root", root, "--only", "pnpm"], io(fakeRun({ pnpmFails: true }))), 3);
    assert.match(text(), /INCOMPLETE pnpm/);
    reset();
    assert.equal(main(["--root", root, "--only", "pnpm", "--allow-incomplete"], io(fakeRun({ pnpmFails: true }))), 0);
  });
  it("a violation outranks an incomplete ecosystem", () => {
    reset();
    assert.equal(main(["--root", root, "--only", "pnpm,cargo"], io(fakeRun({ pnpmFails: true, cargo: "AGPL-3.0-only" }))), 1);
  });
  it("exits 2 on a missing policy block, a malformed exceptions file or a bad flag", () => {
    reset();
    const bad = join(root, "bad-policy.md");
    writeFileSync(bad, "# no block");
    assert.equal(main(["--root", root, "--policy", bad], io(fakeRun())), 2);
    const badEx = join(root, "bad-ex.json");
    writeFileSync(badEx, "[]");
    assert.equal(main(["--root", root, "--exceptions", badEx], io(fakeRun())), 2);
    assert.equal(main(["--nope"], io(fakeRun())), 2);
  });
  it("--json emits machine-readable rows", () => {
    reset();
    assert.equal(main(["--root", root, "--only", "pnpm", "--json"], io(fakeRun())), 0);
    const doc = JSON.parse(text());
    assert.equal(doc.mode, "licenses");
    assert.deepEqual(doc.rows.map((r) => [r.name, r.direct, r.verdict]), [["left-pad", true, "ok"]]);
  });

  describe("--advisories", () => {
    const missing = () => ({ status: null, stdout: "", stderr: "", error: "spawn ENOENT" });
    it("skips cleanly (exit 0) without tools or network", () => {
      reset();
      assert.equal(main(["--root", root, "--advisories"], io(missing)), 0);
      assert.match(text(), /pnpm audit\s+skipped/);
      assert.match(text(), /cargo-audit is not installed/);
    });
    it("skips when pnpm audit prints no usable JSON (offline)", () => {
      reset();
      const run = (cmd) => (cmd === "pnpm" ? { status: 1, stdout: "", stderr: "ENOTFOUND registry.npmjs.org", error: null } : missing());
      assert.equal(main(["--root", root, "--advisories"], io(run)), 0);
      assert.match(text(), /no JSON/);
    });
    it("exits 1 when an advisory is found", () => {
      reset();
      const run = (cmd, args) => {
        if (cmd === "pnpm") return { status: 1, stdout: '{"advisories":{"1":{"module_name":"x","title":"bad","severity":"high"}},"metadata":{"vulnerabilities":{"high":1}}}', stderr: "", error: null };
        if (args[0] === "audit" && args[1] === "--version") return { status: 0, stdout: "cargo-audit-audit 0.21", stderr: "", error: null };
        return { status: 0, stdout: '{"vulnerabilities":{"found":false,"list":[]},"warnings":{}}', stderr: "", error: null };
      };
      assert.equal(main(["--root", root, "--advisories"], io(run)), 1);
      assert.match(text(), /pnpm audit: x: bad \[high\]/);
      assert.match(text(), /cargo audit \(apps\/desktop\)\s+ok/);
    });
  });
});
