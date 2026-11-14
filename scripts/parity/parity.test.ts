import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURE_ROOT, exporterMain, fixtureText, fixturePath, writeFixture } from "./lib.mjs";
import { buildDispatcherVectors } from "./export-dispatcher.ts";
import { buildWireFixtures } from "./export-wire.ts";
import { buildFormatVectors } from "./export-formats.ts";
import { buildAuthVectors, credentials, substitute } from "./export-auth.ts";
import { buildConfigVectors } from "./export-config.ts";
import { buildLogsVectors } from "./export-logs.ts";
import { buildDoctorVectors } from "./export-doctor.ts";
import { buildMetricsVectors } from "./export-metrics.ts";
import { buildRbacVectors } from "./export-rbac.ts";
import { buildJsVectors } from "./export-js.ts";
import { buildExposureVectors } from "./export-exposure.ts";
import { buildIdentityVectors } from "./export-identity.ts";
import { randomBytes } from "node:crypto";
import { buildIdentityStoreVectors } from "./export-identity-store.ts";
import { buildIdentityAdminVectors } from "./export-identity-admin.ts";
import { buildRbacGuardVectors } from "./export-rbac-guard.ts";
import { buildSensitivityVectors } from "./export-sensitivity.ts";
import { POLICY } from "../../packages/core/src/rbac/policy.ts";
import { canonicalJson } from "../../packages/core/src/tools/dispatcher.ts";

describe("parity fixture writer (mode V)", () => {
  it("writes sorted keys at every depth, two-space indent and one trailing newline", () => {
    assert.equal(fixtureText({ b: [{ z: 1, a: 2 }], a: null }), '{\n  "a": null,\n  "b": [\n    {\n      "a": 2,\n      "z": 1\n    }\n  ]\n}\n');
  });

  it("is deterministic: the same data in another key order gives the same bytes, and a second write changes nothing", () => {
    const root = mkdtempSync(join(tmpdir(), "p1b-parity-fx-"));
    try {
      const first = writeFixture("demo", "one", { x: 1, y: { b: 1, a: 2 } }, { root });
      assert.equal(first.changed, true);
      const bytes = readFileSync(first.path, "utf8");
      const second = writeFixture("demo", "one", { y: { a: 2, b: 1 }, x: 1 }, { root });
      assert.equal(second.changed, false);
      assert.equal(readFileSync(second.path, "utf8"), bytes);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("--check writes nothing and reports a missing or hand-edited fixture", async () => {
    const root = mkdtempSync(join(tmpdir(), "p1b-parity-fx-"));
    const lines: string[] = [];
    try {
      const build = async () => ({ one: { v: 1 } });
      assert.equal(await exporterMain({ area: "demo", build, argv: ["--check"], root, log: (l: string) => lines.push(l) }), 1, "missing file is stale");
      assert.throws(() => readFileSync(fixturePath("demo", "one", root)), /ENOENT/);
      assert.equal(await exporterMain({ area: "demo", build, argv: [], root, log: () => {} }), 0);
      assert.equal(await exporterMain({ area: "demo", build, argv: ["--check"], root, log: () => {} }), 0);
      writeFileSync(fixturePath("demo", "one", root), '{"v":1}\n');
      assert.equal(await exporterMain({ area: "demo", build, argv: ["--check"], root, log: (l: string) => lines.push(l) }), 1, "hand edit is stale");
      assert.match(lines.join("\n"), /never edit them by hand/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects an area or name that could leave the fixture root", () => {
    assert.throws(() => fixturePath("../x", "a"), /parity area/);
    assert.throws(() => fixturePath("a", "A b"), /fixture name/);
  });
});

describe("dispatcher vectors (D120 T1 parity vectors)", () => {
  it("the committed fixtures are exactly what the exporter records", async () => {
    const built = await buildDispatcherVectors();
    for (const [name, data] of Object.entries(built)) {
      assert.equal(readFileSync(fixturePath("dispatcher", name), "utf8"), fixtureText(data), `fixtures/parity/dispatcher/${name}.json is stale: run scripts/parity/export-dispatcher.ts`);
    }
    assert.ok(FIXTURE_ROOT.endsWith("fixtures/parity/"));
  });

  it("canonical JSON: every expected string is what canonicalJson returns for the parsed input", async () => {
    const { "canonical-json": v } = await buildDispatcherVectors() as any;
    assert.ok(v.cases.length >= 20);
    for (const c of v.cases) assert.equal(canonicalJson(JSON.parse(c.inputJson)), c.canonical, c.name);
    const names = v.cases.map((c: any) => c.name);
    for (const must of ["astral-vs-bmp-key-order", "integer-above-2-pow-53", "negative-zero", "exponent-forms", "control-characters"]) assert.ok(names.includes(must), must);
    const astral = v.cases.find((c: any) => c.name === "astral-vs-bmp-key-order");
    assert.ok(astral.canonical.indexOf("\u{1F600}") < astral.canonical.indexOf("～"), "UTF-16 order puts the emoji before U+FF5E; UTF-8 byte order does not");
  });

  it("action hash: produced by the real dispatcher, stable across key order, bound to every input", async () => {
    const { "action-hash": v } = await buildDispatcherVectors() as any;
    assert.ok(v.cases.length >= 8);
    for (const c of v.cases) assert.match(c.actionHash, /^[0-9a-f]{64}$/, c.name);
    const byName = Object.fromEntries(v.cases.map((c: any) => [c.name, c.actionHash]));
    assert.equal(byName["args-key-order-a"], byName["args-key-order-b"]);
    assert.notEqual(byName["args-key-order-a"], byName["args-value-differs"]);
    assert.notEqual(byName["plain"], byName["with-targets"]);
    assert.notEqual(byName["plain"], byName["with-hash-extra"]);
    assert.equal(byName["empty-targets"], byName["plain"], "absent targets hash as []");
    assert.notEqual(byName["with-targets"], byName["targets-order-differs"]);
    assert.notEqual(byName["plain"], byName["tool-name-differs"]);
    assert.equal(new Set(v.cases.map((c: any) => c.actionHash)).size, v.cases.length - 2, "exactly two pairs share a hash: the key-order variants and absent/empty targets");
  });
});

describe("wire fixtures (mode W, P4-03)", () => {
  it("the committed fixtures are exactly what the exporter records, and no minted secret survives", async () => {
    const built = await buildWireFixtures();
    assert.deepEqual(Object.keys(built).sort(), ["openai-http", "voice-ws"]);
    for (const [name, data] of Object.entries(built)) {
      const text = readFileSync(fixturePath("wire", name), "utf8");
      assert.equal(text, fixtureText(data), `fixtures/parity/wire/${name}.json is stale: run scripts/parity/export-wire.ts`);
      // The fake's client-id prefix is assembled the way the fake assembles it, so no credential-like literal sits here.
      assert.ok(!text.includes(["oai", "app_"].join("")), `${name}: a minted client id`);
      assert.doesNotMatch(text, /_token":\s*"(?!\[REDACTED)/, `${name}: an unredacted token value`);
    }
  });
});

describe("format vectors (P4-03 review F6)", () => {
  it("the committed fixtures are exactly what ajv-formats says today, with valid and invalid probes per format", async () => {
    const built = await buildFormatVectors();
    for (const [name, data] of Object.entries(built)) {
      assert.equal(readFileSync(fixturePath("formats", name), "utf8"), fixtureText(data), `fixtures/parity/formats/${name}.json is stale: run scripts/parity/export-formats.ts`);
    }
    const cases = (built["ajv-formats"] as any).cases as Array<{ format: string; valid: boolean }>;
    for (const format of ["date", "date-time", "uri", "uuid"]) {
      assert.ok(cases.some((c) => c.format === format && c.valid), `${format}: a valid probe`);
      assert.ok(cases.some((c) => c.format === format && !c.valid), `${format}: an invalid probe`);
    }
  });
});

describe("auth vectors (P4-10 task review L9)", () => {
  it("the committed fixture is exactly what the exporter records, and holds markers, never a credential", async () => {
    const built = await buildAuthVectors();
    for (const [name, data] of Object.entries(built)) {
      const text = readFileSync(fixturePath("auth", name), "utf8");
      assert.equal(text, fixtureText(data), `fixtures/parity/auth/${name}.json is stale: run scripts/parity/export-auth.ts`);
      // The only long hex runs are the length probes (one repeated letter, e.g. a 256-character userId).
      const runs = text.match(/[0-9a-f]{64,}/gi) ?? [];
      assert.ok(runs.every((r) => new Set(r.toLowerCase()).size === 1), "no credential-like value is recorded");
    }
  });

  it("pins module-api's String() coercion of role and kind (P4D-8) and nothing more", async () => {
    const v = (await buildAuthVectors())["module-api"] as any;
    const noted = v["api-delegation"].filter((c: any) => c.note?.startsWith("P4D-8"));
    assert.deepEqual(noted.map((c: any) => c.name), ["principal-role-in-an-array", "principal-kind-in-an-array", "principal-role-in-nested-arrays"]);
    for (const c of noted) assert.equal(c.valid, true, c.name);
    const twoRoles = v["api-delegation"].find((c: any) => c.name === "principal-role-two-element-array");
    assert.equal(twoRoles.valid, false, "String([a, b]) is \"a,b\": refused on both sides");
    for (const section of ["api-delegation", "engine-delegation", "adoption-nonce"]) assert.ok(v[section].length >= 10, section);
  });

  it("records module-api's request-id rule: integers as JSON.parse reads them, strings, nothing else (fix round 1b F8)", async () => {
    const v = (await buildAuthVectors())["module-api"] as any;
    const valid = (idJson: string) => v["request-id"].find((c: any) => c.idJson === idJson)?.valid;
    for (const id of ["1", "-0", "1.0", "1e3", "\"a\""]) assert.equal(valid(id), true, id);
    for (const id of ["1.5", "1e400", "null", "true", "{}", "[1]"]) assert.equal(valid(id), false, id);
    const infinity = v["request-id"].find((c: any) => c.idJson === "1e400");
    assert.equal(infinity.echoed, "null", "Infinity goes back as null");
    assert.match(v["request-id"].find((c: any) => c.idJson === "{}").detail, /^\/id /);
  });

  it("puts a fresh value in place of every marker", () => {
    const values = credentials();
    const text = substitute('{"a":"@api@","b":"@API@","c":"@other@"}', values);
    assert.doesNotMatch(text, /@[a-zA-Z]+@/);
    const parsed = JSON.parse(text);
    assert.equal(parsed.b, parsed.a.toUpperCase());
    assert.notEqual(parsed.a, parsed.c);
    assert.notEqual(credentials()["@api@"], values["@api@"], "fresh on every run");
  });
});

describe("logs vectors (P4-11 tasks 1 to 3)", () => {
  it("the committed fixtures are exactly what the exporter records, and no credential is recorded in one piece", async () => {
    const built = await buildLogsVectors();
    assert.deepEqual(Object.keys(built).sort(), ["files", "levels", "lines", "methods", "output", "query", "records", "redact", "secret-matcher", "trace"]);
    for (const [name, data] of Object.entries(built)) {
      const text = readFileSync(fixturePath("logs", name), "utf8");
      assert.equal(text, fixtureText(data), `fixtures/parity/logs/${name}.json is stale: run scripts/parity/export-logs.ts`);
      // The canaries of the TypeScript tests are stored as the fragments the tests assemble them from (`{ parts }`).
      assert.doesNotMatch(text, /sk-[A-Za-z0-9-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[0-9A-Za-z-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.eyJ/);
    }
  });

  it("records every divergence between JavaScript and Rust with a note, and covers the cases of the TypeScript tests", async () => {
    const built = await buildLogsVectors() as any;
    const noted = built.redact.text.filter((c: any) => c.note).map((c: any) => c.name);
    for (const name of ["unicode-fold-kelvin-sign-in-a-header-name", "js-whitespace-bom-after-bearer", "js-whitespace-nel-after-bearer", "lone-surrogates-in-the-input-become-replacement-characters"])
      assert.ok(noted.includes(name), name);
    assert.ok(built.redact.value.some((c: any) => c.name === "secrets-only-repeated-key-numbering" && c.note), "the key order of a serde_json::Map is pinned");
    assert.ok(built.redact.maskJson.some((c: any) => c.loneSurrogate && c.note), "a JSON text with a lone surrogate escape is pinned");
    assert.ok(built.redact.text.length > 80 && built.redact.value.length >= 10 && built["secret-matcher"].text.length >= 15);
    // Task 3: the log query and the handlers.
    assert.ok(built.query.scans.length >= 60 && built.query.fingerprint.length > 0 && built.query.mint.length > 0 && built.query.decode.length > 0);
    assert.ok(built.methods.query.length > 0 && built.methods.levels.length > 0 && Object.keys(built.methods.time).length > 0);
    assert.ok(built.query.scans.some((c: any) => c.name === "a-budget-smaller-than-the-first-read"));
    // The residual case (a registered value held by a number) must throw, not mask.
    assert.equal(built.redact.maskJson.find((c: any) => c.name === "number-holds-the-secret").result, "error");
  });

  it("pins the write path: attribute-order differences carry a note and the canonical Rust line, and the cases of the TypeScript tests are covered", async () => {
    const built = await buildLogsVectors() as any;
    const cases = new Map<string, any>(built.records.cases.map((c: any) => [c.name, c]));
    for (const name of ["attributes-in-caller-order", "legacy-line-field-order", "oversized-text-is-cut", "level-change-records", "rate-limit-reports-drops"]) {
      assert.ok(cases.get(name)?.note, `${name} differs from the Rust bytes in attribute order and says so`);
      assert.equal(cases.get(name).canonical.length, cases.get(name).lines.length);
    }
    for (const name of ["started-record", "dedup-then-summary", "legacy-too-long-is-summarised", "legacy-message-cut"]) assert.equal(cases.get(name)?.note, undefined, `${name} is byte-identical`);
    assert.ok(built.levels.cases.length >= 8 && built.trace.parse.length >= 16 && built.output.sanitise.length >= 16 && built.files.cases.length >= 14 && built.lines.cases.length >= 9);
    assert.ok(built.lines.cases.find((c: any) => c.name === "stamped-lines").seek.length >= 13, "seekByTs binary search is exercised on a file above 64 KiB");
  });
});

describe("config vectors (P4-11 task 4a)", () => {
  it("the committed fixtures are exactly what the exporter records, and they cover every area", async () => {
    const built = await buildConfigVectors() as any;
    assert.deepEqual(Object.keys(built).sort(), ["disclosure", "engine", "patch", "validate", "warnings"]);
    for (const [name, data] of Object.entries(built)) {
      const text = readFileSync(fixturePath("config", name), "utf8");
      assert.equal(text, fixtureText(data), `fixtures/parity/config/${name}.json is stale: run scripts/parity/export-config.ts`);
      assert.doesNotMatch(text, /sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[0-9A-Za-z-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.eyJ/);
    }
    assert.ok(built.validate.length >= 60 && built.warnings.some((c: any) => c.warnings.length === 50));
    assert.ok(built.engine.some((c: any) => c.ok) && built.engine.some((c: any) => !c.ok && c.error.reason === "local-only") && built.engine.some((c: any) => c.catalog));
    assert.ok(built.patch.some((c: any) => !c.ok) && built.disclosure.length >= 10);
  });
});

describe("metrics vectors (P4-11 task 5b)", () => {
  it("the committed fixtures are exactly what the exporter records, and they cover refusals, number printing and collation", async () => {
    const built = await buildMetricsVectors() as any;
    assert.deepEqual(Object.keys(built).sort(), ["metrics", "registry"]);
    for (const [name, data] of Object.entries(built)) {
      const text = readFileSync(fixturePath("metrics", name), "utf8");
      assert.equal(text, fixtureText(data), `fixtures/parity/metrics/${name}.json is stale: run scripts/parity/export-metrics.ts`);
      assert.doesNotMatch(text, /sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[0-9A-Za-z-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.eyJ/);
    }
    const cases = new Map<string, any>(built.registry.cases.map((c: any) => [c.name, c]));
    assert.ok(built.registry.cases.length >= 25 && built.metrics.cases.length >= 15 && built.metrics.methods.length > 100);
    assert.ok(cases.get("number-formatting-of-gauge-values").results.at(-1).text.includes("1e+21"));
    assert.ok(cases.get("series-order-follows-icu-locale-compare").results.at(-1).text.includes("a_b"));
    assert.ok(cases.get("refusals-of-the-series-cap").results.some((r: any) => /maxSeries must be an integer/.test(r.error)));
    assert.ok(built.registry.cases.every((c: any) => c.results.length === c.ops.length));
  });
});

describe("doctor vectors (P4-11 task 6)", () => {
  it("the committed fixture is exactly what the exporter records, and it covers refusals, path cleaning and every platform", async () => {
    const built = await buildDoctorVectors() as any;
    assert.deepEqual(Object.keys(built), ["report"]);
    const text = readFileSync(fixturePath("doctor", "report"), "utf8");
    assert.equal(text, fixtureText(built.report), "fixtures/parity/doctor/report.json is stale: run scripts/parity/export-doctor.ts");
    assert.doesNotMatch(text, /sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[0-9A-Za-z-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.eyJ/);
    const cases: any[] = built.report.cases;
    assert.ok(cases.length >= 100);
    assert.ok(cases.some((c) => c.expected.error?.reason === "firstaid-invalid") && cases.some((c) => c.expected.error?.reason === "firstaid-unavailable"));
    for (const platform of ["linux", "darwin", "win32"]) assert.ok(cases.some((c) => c.platform === platform && c.expected.ok));
    const paths = cases.find((c) => c.name === "path-cleaning-foreign-homes-and-mail");
    for (const leak of ["bob", "Carol", "anna", "dave"]) assert.equal(JSON.stringify(paths.expected).includes(leak), false, leak);
    assert.equal(process.env.HOME === "/fake-user", false, "the exporter restores HOME");
  });
});

describe("rbac vectors (P4-12 task 1, R10)", () => {
  it("the committed fixtures are exactly what the exporter records, and the grid covers every policy row", async () => {
    const built = await buildRbacVectors() as any;
    assert.deepEqual(Object.keys(built).sort(), ["break-glass", "cansee", "connection-surface", "grid-agent", "grid-memory-agent", "grid-project", "grid-system", "grid-user", "index", "odd-authorize", "policy", "scopes-object", "scopes-system", "surface-satisfies", "surface-trust"]);
    for (const [name, data] of Object.entries(built)) {
      const text = readFileSync(fixturePath("rbac", name), "utf8");
      assert.equal(text, fixtureText(data), `fixtures/parity/rbac/${name}.json is stale: run scripts/parity/export-rbac.ts`);
      assert.ok(text.length < 5_000_000, `${name}: a fixture file stays under about 5 MB (split it)`);
    }
    assert.equal(built.policy.rows.length, POLICY.length);
    assert.deepEqual(built.policy.actions, POLICY.map((s) => s.action));
    // Packed files: `{fields, tables, cases}`, one `name TAB in TAB expected` line per case.
    const lines = (n: string): string[] => built[n].cases;
    const grids = ["grid-agent", "grid-memory-agent", "grid-project", "grid-system", "grid-user"].flatMap(lines);
    const scopes = [...lines("scopes-system"), ...lines("scopes-object")];
    const glass = lines("break-glass");
    const ROLES = ["owner", "admin", "operator", "member", "viewer"];
    for (const spec of POLICY) for (const role of ROLES) {
      const head = `${spec.action} | ${role} | `;
      assert.ok(grids.some((c) => c.startsWith(head)), `${spec.action} x ${role} is in the grid`);
      // Every row is covered in a full-product class or by its smoke set: token scopes (exact, empty, star, other) ...
      for (const label of ["exact", "empty", "star", "other-action"])
        assert.ok(scopes.some((c) => c.startsWith(`${head}person | `) && c.split("\t")[0].endsWith(` | scopes ${label}`)), `${spec.action} x ${role}: scopes ${label}`);
      // ... and, for user and memory-user rows, break-glass (absent, valid, expired, other target).
      if (spec.resource === "user" || spec.resource === "memory-user")
        for (const label of ["absent", "valid", "expired-by-one", "other-target"])
          assert.ok(glass.some((c) => c.startsWith(`${head}person | own | glass ${label}\t`)), `${spec.action} x ${role}: glass ${label}`);
    }
    // Signature classes: every row in exactly one, the first row of each class runs the full product.
    const classes: { full: string; rows: string[] }[] = built.index.signatureClasses;
    assert.deepEqual(classes.flatMap((c) => c.rows).sort(), POLICY.map((s) => s.action).sort());
    for (const c of classes) {
      assert.equal(c.full, c.rows[0]);
      const ran = (action: string) => scopes.some((l) => l.startsWith(`${action} | owner | person | `) && l.split("\t")[0].endsWith(" | scopes upper-case"));
      assert.ok(ran(c.full), `${c.full}: full scope product`);
      for (const other of c.rows.slice(1)) assert.ok(!ran(other), `${other}: smoke set only`);
    }
    // The deny reasons the decision can end in are each pinned by at least one case.
    const decisionFiles = ["grid-agent", "grid-memory-agent", "grid-project", "grid-system", "grid-user", "scopes-system", "scopes-object", "break-glass", "odd-authorize"];
    const outcomes = decisionFiles.flatMap(lines).map((l) => l.split("\t")[2]!);
    const reasons = new Set(outcomes.map((o) => o.split("/")[1]).filter(Boolean));
    for (const r of ["unauthenticated", "invalid-principal", "unknown-action", "resource-mismatch", "token-scope", "role-denied", "not-owner", "object-right-required", "break-glass-required", "agent-principal", "role", "own", "object-right", "break-glass"])
      assert.ok(reasons.has(r), r);
    assert.ok(!reasons.has("audit-failed"), "audit-failed is the guard's reason, not authorize's (break-glass audit is T6)");
    assert.ok(outcomes.filter((o) => o.startsWith("throws/")).length >= 50);
    const total = Object.values(built.index.files as Record<string, number>).reduce((n, c) => n + c, 0) - built.index.files.policy;
    assert.equal(total, built.index.totalDecisionAndSurfaceCases);
    const bytes = Object.keys(built).reduce((n, name) => n + readFileSync(fixturePath("rbac", name), "utf8").length, 0);
    assert.ok(bytes <= 4_000_000, `fixtures/parity/rbac/ stays within 4 MB, now ${bytes}`);
    assert.ok(built.index.totalDecisionAndSurfaceCases >= 20000);
  });
});

describe("js semantics vectors (P4-12 task 2, R5)", () => {
  it("the committed fixtures are exactly what the exporter records, within 2 MB with the exposure vectors", async () => {
    const built = await buildJsVectors();
    assert.deepEqual(Object.keys(built).sort(), ["array-index", "classes", "digests", "sort", "strings"]);
    for (const [name, data] of Object.entries(built)) {
      assert.equal(readFileSync(fixturePath("js", name), "utf8"), fixtureText(data), `fixtures/parity/js/${name}.json is stale: run scripts/parity/export-js.ts`);
    }
    assert.ok((built as any).classes.space.length === 25 && (built as any).classes.probes["k"].length === 2, "Kelvin does not fold to k");
  });
});

describe("exposure vectors (P4-12 task 2)", () => {
  it("the committed fixtures are exactly what the exporter records, and exposure plus js stay within 2 MB", async () => {
    const built = await buildExposureVectors() as any;
    assert.deepEqual(Object.keys(built).sort(), ["doctor-check", "doctor-findings", "hash", "index", "keywords", "local-only", "resolve-overrides", "resolve-principals", "resolve-switches", "scanner", "sensitivity-filter", "sensitivity-refusal", "switches"]);
    let bytes = 0;
    for (const [name, data] of Object.entries(built)) {
      const text = readFileSync(fixturePath("exposure", name), "utf8");
      assert.equal(text, fixtureText(data), `fixtures/parity/exposure/${name}.json is stale: run scripts/parity/export-exposure.ts`);
      bytes += text.length;
    }
    for (const name of ["array-index", "classes", "digests", "sort", "strings"]) bytes += readFileSync(fixturePath("js", name), "utf8").length;
    assert.ok(bytes <= 2_000_000, `fixtures/parity/{exposure,js}/ stay within 2 MB, now ${bytes}`);
    // The grids: counts pinned, so a shrinking grid is a visible change.
    assert.deepEqual(built.index.counts["resolve-principals"], 5 * 3 * 3 * 11 * 6 + 1);
    assert.equal(built.index.counts["resolve-switches"], 81 * 24 + 2 * 81 * 4);
    assert.equal(built.index.counts["resolve-overrides"], 3 * 5 * 3 * 27 + 2 * 3 * 5 * 3);
    assert.equal(built.index.counts.switches, 3 * 4 * 81 + 2);
    assert.ok(built.index.counts.scanner >= 2500);
    // Each of the five categories has positive lines, and every subset of categories occurs.
    const outcomes = built.scanner.cases.map((l: string) => l.split("\t")[2]!.split("/")[0]!);
    for (const c of ["health", "financial", "credential", "identity", "personal"]) assert.ok(outcomes.some((o: string) => o.split(",").includes(c)), c);
    assert.equal(new Set(outcomes.filter((o: string) => o !== "-")).size >= 31, true);
  });
});

describe("identity vectors (P4-12 task 3)", () => {
  it("the committed fixtures are exactly what the exporter records, within 1 MB", async () => {
    const built = await buildIdentityVectors() as any;
    assert.deepEqual(Object.keys(built).sort(), ["authorization", "channel-names", "code-equal", "code-hash", "code-normalize", "code-normalize-sweep", "code-random", "constants", "identity-validation", "index", "invite-origin", "invite-token", "limiter", "principal-derive", "principal-shape", "principal-v1", "recall"]);
    let bytes = 0;
    for (const [name, data] of Object.entries(built)) {
      const text = readFileSync(fixturePath("identity", name), "utf8");
      assert.equal(text, fixtureText(data), `fixtures/parity/identity/${name}.json is stale: run scripts/parity/export-identity.ts`);
      bytes += Buffer.byteLength(text);
    }
    assert.ok(bytes <= 1_000_000, `fixtures/parity/identity/ stays within 1 MB, now ${bytes}`);
    // The grids: counts pinned, so a shrinking grid is a visible change.
    assert.equal(built.index.counts.authorization, 6 * 6 * 3 * 2 * 10 + 6 * 2 * 6 + 6 * 3 * 3 * 3 * 2);
    assert.ok(built.index.counts["invite-origin"] >= 3000 && built.index.counts.limiter >= 1000 && built.index.counts["code-normalize"] >= 800);
    assert.equal(built["code-normalize-sweep"].scalars, 0x110000 - 0x800);
    // Every limiter sequence ends in a state the table dump shows, and the lock thresholds are exercised in both directions.
    const lines: string[] = built.limiter.sequences.flatMap((q: any) => q.steps);
    assert.ok(lines.some((l) => l.startsWith("locked\t") && !l.split("\t")[4]!.startsWith("0")) && lines.some((l) => l.startsWith("release\t")) && lines.some((l) => l.startsWith("prune\t")));
    // Randomness is scripted, never recorded: the exporter run twice gives the same bytes (the --check above) and the draws cover every symbol.
    assert.equal(new Set(built["code-random"].generate.cases.flatMap((c: string) => JSON.parse(c)[1].split(""))).size, 32);
  });
});

describe("identity store, admin store and guard sequences (P4-12 tasks 4 to 6, R9)", () => {
  const stale = (area: string, built: Record<string, unknown>, exporter: string): number => {
    let bytes = 0;
    for (const [name, data] of Object.entries(built)) {
      const text = readFileSync(fixturePath(area, name), "utf8");
      assert.equal(text, fixtureText(data), `fixtures/parity/${area}/${name}.json is stale: run scripts/parity/${exporter}`);
      bytes += Buffer.byteLength(text);
    }
    return bytes;
  };
  const ops = (scenarios: any[]): Set<string> => new Set(scenarios.flatMap((s) => s.steps.map((line: string) => JSON.parse(line).op)));

  it("identity store: the committed sequences are what the exporter records, cover every method and stay within 1 MB", () => {
    const built = buildIdentityStoreVectors() as any;
    assert.deepEqual(Object.keys(built).sort(), ["scenarios", "schema"]);
    assert.ok(stale("identity-store", built, "export-identity-store.ts") <= 1_000_000);
    const scenarios = built.scenarios.scenarios;
    assert.ok(scenarios.length >= 14 && scenarios.reduce((n: number, s: any) => n + s.steps.length, 0) >= 600);
    for (const op of ["open", "close", "createHuman", "link", "revokePairing", "startPairing", "claim", "confirm", "unlink", "list", "resolve", "linkedV1Principals", "jobLink", "resolvePrincipals", "getLink", "backfillRecord", "reserveBackfill", "finishBackfill", "authorizeAction", "emit"])
      assert.ok(ops(scenarios).has(op), `no step calls ${op}`);
    // Every refusal of the service's vocabulary is recorded at least once, and the scripted random source restored node:crypto.
    const codes = new Set(scenarios.flatMap((s: any) => s.steps.map((line: string) => JSON.parse(line).out.err?.code)));
    for (const code of ["invalid-params", "not-found", "invalid-code", "expired", "rate-limited", "conflict", "limit", "storage", "denied"]) assert.ok(codes.has(code), `no step is refused as ${code}`);
    assert.notEqual(randomBytes(16).toString("hex"), randomBytes(16).toString("hex"));
  });

  it("admin store and desktop attach: the committed sequences are what the exporter records and cover every method", () => {
    const built = buildIdentityAdminVectors() as any;
    assert.deepEqual(Object.keys(built).sort(), ["admin", "attach", "schema"]);
    assert.ok(stale("identity-admin", built, "export-identity-admin.ts") <= 400_000);
    for (const op of ["open", "role", "users", "person", "resolvePerson", "setDisabled", "validateInvite", "setRole", "rights", "setRight", "resolve", "invite", "notice", "notices", "allNotices", "invites", "revoke", "redeem"])
      assert.ok(ops(built.admin.scenarios).has(op), `no admin step calls ${op}`);
    for (const op of ["open", "issue", "redeem", "authenticate", "resolve"]) assert.ok(ops(built.attach.scenarios).has(op), `no attach step calls ${op}`);
    // "Audit before effect": a failing hook and a failing sink are part of the script.
    const errs = (scenarios: any[]) => scenarios.flatMap((s) => s.steps.map((line: string) => JSON.parse(line).out.err)).filter(Boolean);
    assert.ok(errs(built.admin.scenarios).some((e) => e.hook) && errs(built.attach.scenarios).some((e) => e.audit));
  });

  it("guard, break-glass and audit lines: the committed vectors are what the exporter records, and every rule is in them", async () => {
    const built = await buildRbacGuardVectors() as any;
    assert.deepEqual(Object.keys(built).sort(), ["audit", "break-glass", "guard", "rules"]);
    assert.ok(stale("rbac-guard", built, "export-rbac-guard.ts") <= 1_000_000);
    const methods: string[] = built.rules.methods.map((m: any) => m.method);
    assert.ok(methods.length >= 290);
    // Every method that is not API-service-only is run in layer `method`, every API-service-only one in layer `service`.
    const ran = (layer: string) => new Set(built.guard.layers[layer].map((line: string) => built.guard.tables.method[Number(line.split(".")[0])]));
    for (const m of built.rules.methods) assert.ok(ran(m.apiServiceOnly ? "service" : "method").has(m.method), `${m.method} is in no case`);
    assert.ok(built.guard.index.total >= 15_000 && built["break-glass"].scenarios.length >= 6 && built.audit.rbac.length >= 6);
  });
});

describe("card sensitivity store and service sequences (P4-12 task 7, R9)", () => {
  it("the committed sequences are what the exporter records, cover every method, stay within 300 KB, and leave Date.now alone", async () => {
    const realNow = Date.now;
    const built = await buildSensitivityVectors() as any;
    assert.equal(Date.now, realNow, "the scripted clock was restored");
    assert.deepEqual(Object.keys(built).sort(), ["scenarios", "schema"]);
    let bytes = 0;
    for (const [name, data] of Object.entries(built)) {
      const text = readFileSync(fixturePath("sensitivity", name), "utf8");
      assert.equal(text, fixtureText(data), `fixtures/parity/sensitivity/${name}.json is stale: run scripts/parity/export-sensitivity.ts`);
      bytes += Buffer.byteLength(text);
    }
    assert.ok(bytes <= 300_000);
    const scenarios: any[] = built.scenarios.scenarios;
    assert.ok(scenarios.length >= 12 && scenarios.reduce((n, s) => n + s.steps.length, 0) >= 200);
    const ops = new Set(scenarios.flatMap((s) => s.steps.map((line: string) => JSON.parse(line).op)));
    for (const op of ["open", "close", "store.get", "store.getByHash", "store.set", "store.clear", "store.hasManualCategories", "assessCard", "assessAggregate", "setSensitivity", "clearSensitivity", "hasManualCategories", "getSensitivity"])
      assert.ok(ops.has(op), `no step calls ${op}`);
    // The scanner's five categories each come out of the service at least once.
    const seen = new Set(scenarios.flatMap((s) => s.steps.flatMap((line: string) => { const o = JSON.parse(line); return o.op === "assessCard" && Array.isArray(o.out.ok) ? o.out.ok : []; })));
    for (const c of ["health", "financial", "credential", "identity", "personal"]) assert.ok(seen.has(c), `no assessCard result has ${c}`);
    assert.deepEqual(built.schema.pragmas, { busy_timeout: 5000, foreign_keys: 1, journal_mode: "wal", synchronous: 2, user_version: 0 });
  });
});
