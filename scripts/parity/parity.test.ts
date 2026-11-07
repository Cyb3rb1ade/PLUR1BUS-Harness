import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURE_ROOT, exporterMain, fixtureText, fixturePath, writeFixture } from "./lib.mjs";
import { buildDispatcherVectors } from "./export-dispatcher.ts";
import { buildWireFixtures } from "./export-wire.ts";
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
