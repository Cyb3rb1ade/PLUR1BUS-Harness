// The curated model metadata table shipped in packages/core/catalog (docs/superpowers/specs/2026-10-03-model-discovery-design.md §2.5):
// every shipped file is read and validated by the real loader, nothing is skipped, and invalid tables written to a temp
// directory are rejected with a message that names the offending rule. Expectations come from the design document's
// field vocabulary and from the loader's own header comment, not from the loader's constants.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBundledMetadataTable, loadMetadataTable, lookup } from "../../src/discovery/metadata.ts";
import { loadReasoningTable } from "../../src/discovery/reasoning.ts";
import { duplicateKeys, useTempDirs } from "./helpers.ts";

const CATALOG_DIR = fileURLToPath(new URL("../../catalog/", import.meta.url));
const FIXTURES = fileURLToPath(new URL("../fixtures/model-ids/", import.meta.url));
// The vocabularies, copied from the design document (§2.5 "Fields"), not imported.
const DOC_KINDS = ["chat", "embedding", "tts", "asr", "image", "moderation", "rerank", "realtime", "unknown"];
const DOC_CAPABILITIES = ["tools", "vision", "reasoning", "audio_in", "audio_out", "structured_output", "prompt_caching"];
const KNOWN_SCHEMAS: Record<string, (raw: unknown) => unknown> = { "plur1bus.model-metadata/1": (raw) => loadMetadataTable(raw),
  "plur1bus.reasoning-metadata/1": (raw) => loadReasoningTable(raw),
};

interface Rule { pattern: string; kind: string; contextWindow?: number; capabilities: string[]; aliases?: string[] }
const files = readdirSync(CATALOG_DIR).sort();
const read = (f: string) => readFileSync(path.join(CATALOG_DIR, f), "utf8");
const table = (f: string) => JSON.parse(read(f)) as { schema: string; revision: string; vendors: Record<string, Rule[]> };

describe("shipped catalog files", () => {
  it("the catalog directory holds only regular .json files (a stray file is a failure, not something skipped)", () => {
    assert.ok(files.length >= 1, "at least the model metadata table is shipped");
    for (const f of files) { assert.ok(statSync(path.join(CATALOG_DIR, f)).isFile(), `${f} is a file`); assert.match(f, /\.json$/, f); }
  });

  for (const f of files) {
    describe(f, () => {
      it("is UTF-8 JSON without a byte order mark, and no object has the same key twice (JSON.parse would keep the last silently)", () => {
        const text = read(f);
        assert.notEqual(text.charCodeAt(0), 0xfeff, "no BOM");
        assert.doesNotThrow(() => JSON.parse(text));
        assert.deepEqual(duplicateKeys(text), []);
      });

      it("names a schema this test knows, so a new kind of file cannot be added without being validated", () => {
        const raw = table(f);
        assert.equal(typeof raw.schema, "string");
        assert.ok(Object.hasOwn(KNOWN_SCHEMAS, raw.schema), `${f}: schema ${JSON.stringify(raw.schema)} has no validator in this test; add one`);
      });

      it("is accepted by the real loader", () => {
        const raw = table(f);
        const compiled = KNOWN_SCHEMAS[raw.schema]!(raw) as { revision: string; sections: Map<string, unknown[]> };
        assert.equal(compiled.revision, raw.revision);
        assert.equal(compiled.sections.size, Object.keys(raw.vendors).length);
        for (const [name, rules] of Object.entries(raw.vendors)) assert.equal(compiled.sections.get(name)!.length, rules.length, name);
      });
    });
  }
});

describe("the model metadata table", () => {
  const f = "model-metadata.json";
  const t = table(f);
  const rules = Object.entries(t.vendors).flatMap(([vendor, rs]) => rs.map((rule, i) => ({ vendor, i, rule, where: `${vendor}[${i}]` })));

  it("ships a revision and a 'generic' section (it is tried after every vendor section)", () => {
    assert.equal(typeof t.revision, "string"); assert.notEqual(t.revision, "");
    assert.ok(Array.isArray(t.vendors.generic));
  });

  it("every rule uses only kinds and capabilities from the documented vocabulary, and a positive integer context window when it has one", () => {
    for (const { rule, where } of rules) {
      assert.ok(DOC_KINDS.includes(rule.kind), `${where}: kind ${rule.kind}`);
      for (const c of rule.capabilities) assert.ok(DOC_CAPABILITIES.includes(c), `${where}: capability ${c}`);
      assert.equal(new Set(rule.capabilities).size, rule.capabilities.length, `${where}: capabilities repeat`);
      if (rule.contextWindow !== undefined) assert.ok(Number.isSafeInteger(rule.contextWindow) && rule.contextWindow > 0, `${where}: contextWindow`);
    }
  });

  it("patterns are anchored, at most 200 characters, and contain no backreference or lookaround (the documented subset)", () => {
    for (const { rule, where } of rules) {
      assert.ok(rule.pattern.startsWith("^") && rule.pattern.endsWith("$"), `${where}: anchored`);
      assert.ok(rule.pattern.length <= 200, `${where}: length`);
      assert.equal(/\\[1-9]|\\k<|\(\?<?[=!]/.test(rule.pattern), false, `${where}: outside the subset`);
      assert.doesNotThrow(() => new RegExp(rule.pattern), where);
    }
  });

  it("no pattern and no alias appears twice anywhere in the table", () => {
    const patterns = rules.map((r) => r.rule.pattern);
    assert.equal(new Set(patterns).size, patterns.length);
    const aliases = rules.flatMap((r) => r.rule.aliases ?? []);
    assert.equal(new Set(aliases).size, aliases.length);
    for (const a of aliases) { assert.equal(typeof a, "string"); assert.notEqual(a, "", "an empty alias names nothing"); }
  });

  it("an alias is a short name for one model: it does not itself look like another rule's model id (derived from 'not colliding with another id')", () => {
    for (const { rule, where } of rules) for (const alias of rule.aliases ?? []) {
      for (const other of rules) if (other.rule !== rule) assert.equal(new RegExp(other.rule.pattern).test(alias), false, `${where}: alias ${alias} matches ${other.where}`);
    }
  });

  it("no rule is dead: for each rule some known id (fixtures) reaches it before any earlier rule of its section does ('first match wins')", () => {
    const compiled = loadMetadataTable(t);
    for (const [vendor, rs] of Object.entries(t.vendors)) {
      const ids = (() => { try { return JSON.parse(readFileSync(path.join(FIXTURES, `${vendor}.json`), "utf8")) as string[]; } catch { return null; } })();
      assert.ok(ids, `fixture ids for section ${vendor} exist`);
      const winners = new Set(ids!.map((id) => lookup(compiled, vendor, id)).filter((r) => r !== null).map((r) => r!.pattern));
      for (const r of rs) assert.ok(winners.has(r.pattern), `${vendor}: ${r.pattern} is never the first match for any fixture id`);
    }
  });

  it("an id nothing matches is not found, in a vendor section and in generic alike; unknown vendors fall back to generic only", () => {
    const compiled = loadMetadataTable(t);
    assert.equal(lookup(compiled, "example-vendor", "no-such-model"), null);
    assert.equal(lookup(compiled, "no-such-vendor", "example-chat-large"), null);
    assert.ok(lookup(compiled, "no-such-vendor", "example-embed-1"));
    for (const v of ["__proto__", "constructor", "toString", "hasOwnProperty"]) assert.doesNotThrow(() => lookup(compiled, v, "example-embed-1"), v);
  });
});

describe("invalid tables are rejected loudly", () => {
  const temp = useTempDirs();
  const valid = () => ({ schema: "plur1bus.model-metadata/1", revision: "r1", vendors: { generic: [{ pattern: "^m-.+$", kind: "chat", capabilities: [] as string[] }] } });
  /** Writes the document to a temp file and loads it back the way a data file would be read. */
  function load(doc: unknown): unknown {
    const file = path.join(temp(), "table.json");
    writeFileSync(file, typeof doc === "string" ? doc : JSON.stringify(doc));
    return loadMetadataTable(JSON.parse(readFileSync(file, "utf8")));
  }
  const rejects = (doc: unknown, ...fragments: string[]) => assert.throws(() => load(doc), (e: unknown) => {
    assert.ok(e instanceof Error && e.message.startsWith("invalid model metadata table:") || (e instanceof Error && e.message === "metadata table must be an object"), String(e));
    for (const fr of fragments) assert.ok((e as Error).message.includes(fr), `message lacks ${JSON.stringify(fr)}: ${(e as Error).message}`);
    return true;
  });
  const withRule = (rule: unknown, vendors?: Record<string, unknown>) => ({ ...valid(), vendors: vendors ?? { generic: [rule] } });

  it("the valid baseline loads", () => assert.doesNotThrow(() => load(valid())));

  it("a wrong or missing schema, a missing or empty revision, and a malformed vendors block are each named", () => {
    rejects({ ...valid(), schema: "plur1bus.model-metadata/2" }, "schema must be plur1bus.model-metadata/1");
    rejects({ revision: "r", vendors: {} }, "schema");
    rejects({ ...valid(), revision: "" }, "revision must be a non-empty string");
    rejects({ ...valid(), revision: 3 }, "revision");
    rejects({ ...valid(), vendors: [] }, "vendors must be an object");
    rejects({ ...valid(), vendors: null }, "vendors must be an object");
    rejects({ ...valid(), vendors: "x" }, "vendors must be an object");
  });

  it("a table that is not an object is rejected (null, a string, an array has no schema)", () => {
    assert.throws(() => loadMetadataTable(null), /metadata table must be an object/);
    assert.throws(() => loadMetadataTable("text"), /metadata table must be an object/);
    rejects([], "schema must be");
  });

  it("a section that is not a list, and a rule that is not an object or has no pattern string, name their position", () => {
    rejects(withRule(null, { generic: "oops" }), "generic: must be an array of rules");
    rejects(withRule(null, { generic: [null] }), "generic[0]: pattern must be a string");
    rejects(withRule(null, { generic: [5] }), "generic[0]: pattern must be a string");
    rejects(withRule({ kind: "chat", capabilities: [] }), "generic[0]: pattern must be a string");
    rejects(withRule({ pattern: 5, kind: "chat", capabilities: [] }), "pattern must be a string");
  });

  it("an unanchored, over-long, back-referencing or look-around pattern is rejected with the rule's position", () => {
    rejects(withRule({ pattern: "m-.+", kind: "chat", capabilities: [] }), "generic[0]: pattern must be anchored with ^ and $");
    rejects(withRule({ pattern: "^m-.+", kind: "chat", capabilities: [] }), "anchored");
    rejects(withRule({ pattern: "m-.+$", kind: "chat", capabilities: [] }), "anchored");
    rejects(withRule({ pattern: `^${"a".repeat(199)}$`, kind: "chat", capabilities: [] }), "longer than 200");
    rejects(withRule({ pattern: "^(a)\\1$", kind: "chat", capabilities: [] }), "RE2-safe subset");
    rejects(withRule({ pattern: "^(?<n>a)\\k<n>$", kind: "chat", capabilities: [] }), "RE2-safe subset");
    for (const p of ["^(?=a)a$", "^(?!a)b$", "^(?<=a)b$", "^(?<!a)b$"]) rejects(withRule({ pattern: p, kind: "chat", capabilities: [] }), "RE2-safe subset");
  });

  it("a pattern that does not compile is named", () => {
    rejects(withRule({ pattern: "^(a$", kind: "chat", capabilities: [] }), "generic[0]: pattern does not compile");
    rejects(withRule({ pattern: "^[a$", kind: "chat", capabilities: [] }), "does not compile");
  });

  it("a kind or capability outside the vocabulary is named; so is a bad context window", () => {
    rejects(withRule({ pattern: "^a$", kind: "llm", capabilities: [] }), "generic[0]: kind is not in the vocabulary");
    rejects(withRule({ pattern: "^a$", capabilities: [] }), "kind is not in the vocabulary");
    rejects(withRule({ pattern: "^a$", kind: "chat", capabilities: ["telepathy"] }), "generic[0]: capabilities not in the vocabulary");
    rejects(withRule({ pattern: "^a$", kind: "chat" }), "capabilities not in the vocabulary");
    for (const cw of [0, -1, 1.5, "128000", null, Number.NaN]) rejects(withRule({ pattern: "^a$", kind: "chat", capabilities: [], contextWindow: cw }), "contextWindow must be a positive integer");
  });

  it("duplicate patterns and duplicate aliases are rejected, within a section and across sections, naming both places", () => {
    const rule = (p: string, aliases?: string[]) => ({ pattern: p, kind: "chat", capabilities: [], ...(aliases ? { aliases } : {}) });
    rejects(withRule(null, { generic: [rule("^a$"), rule("^a$")] }), "generic[1]: duplicate pattern (also generic[0])");
    rejects(withRule(null, { generic: [rule("^a$")], v: [rule("^a$")] }), "v[0]: duplicate pattern (also generic[0])");
    rejects(withRule(null, { generic: [rule("^a$", ["x"]), rule("^b$", ["x"])] }), "generic[1]: duplicate alias (also generic[0])");
    rejects(withRule(null, { a: [rule("^a$", ["x"])], b: [rule("^b$", ["x"])] }), "b[0]: duplicate alias (also a[0])");
    rejects(withRule(null, { generic: [rule("^a$", ["x", "x"])] }), "duplicate alias");
    rejects(withRule({ pattern: "^a$", kind: "chat", capabilities: [], aliases: [1] }), "aliases must be strings");
    rejects(withRule({ pattern: "^a$", kind: "chat", capabilities: [], aliases: "x" }), "aliases must be strings");
  });

  it("all violations are reported together, not just the first", () => {
    const doc = { schema: "nope", revision: "", vendors: { generic: [{ pattern: "a", kind: "x", capabilities: ["y"] }, { pattern: "^(a$", kind: "chat", capabilities: [] }] } };
    assert.throws(() => load(doc), (e: unknown) => {
      const m = (e as Error).message; for (const part of ["schema must be", "revision must be", "generic[0]: pattern must be anchored", "generic[0]: kind", "generic[0]: capabilities"]) assert.ok(m.includes(part), part);
      return true;
    });
  });

  it("a rejected table loads nothing: there is no partial result", () => {
    const doc = { ...valid(), vendors: { generic: [{ pattern: "^ok$", kind: "chat", capabilities: [] }, { pattern: "bad", kind: "chat", capabilities: [] }] } };
    assert.throws(() => load(doc));
  });

  it("an undefined table throws (a failed read passed through as undefined must not look like success); the bundled table has to be asked for explicitly", () => {
    assert.throws(() => loadMetadataTable(undefined), /metadata table must be an object/);
    const explicit = loadBundledMetadataTable();
    assert.equal(explicit.revision, loadMetadataTable().revision); // calling with no argument at all is the explicit request
    assert.ok(explicit.sections.size > 0);
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert: unknown extra fields on the table or on a rule are ignored without a message", () => {
    assert.doesNotThrow(() => load({ ...valid(), note: "x", vendors: { generic: [{ pattern: "^a$", kind: "chat", capabilities: [], licence: "research-only", preselected: true }] } }));
  });

  it("nested quantifiers (catastrophic in a backtracking engine) are outside the RE2-safe subset; bounded and single-level repetition stays allowed", () => {
    for (const p of ["^(a+)+$", "^(a*)*$", "^(a+)*$", "^(a|b+)+$", "^(?:a+)+$", "^(?<n>a+)+$", "^((a+)b)+$", "^(a{2,})+$", "^(a+){2,}$", "^(a+){1,3}$", "^(a{1,3}){2,5}$", "^([a-z]+\\d?)+$", "^(\\w+\\.)*$", "^(.*a){3,}$", "^(a+)+b$"])
      rejects(withRule({ pattern: p, kind: "chat", capabilities: [] }), "RE2-safe subset");
    for (const p of ["^gpt-4(?:\\.\\d+)?(?:-mini)?$", "^claude-[a-z]+-\\d+(?:-\\d+)?$", "^(a|b)+$", "^(ab)+$", "^[a+]+$", "^\\(a+\\)+$", "^a+b*c{2,4}$", "^(a){2}$", "^(a+)?$", "^(?:a+)?b$"])
      assert.doesNotThrow(() => load(withRule({ pattern: p, kind: "chat", capabilities: [] })), p);
  });
});

describe("the duplicate-key scanner these catalog tests rely on", () => {
  it("finds a key repeated in the same object, at any depth, including inside arrays, and respects escapes", () => {
    assert.deepEqual(duplicateKeys('{"a":1,"a":2}'), ["a"]);
    assert.deepEqual(duplicateKeys('{"o":{"x":1,"y":{"k":1,"k":2}},"p":[{"z":1,"z":1}]}'), ["o.y.k", "p[0].z"]);
    assert.deepEqual(duplicateKeys('{"a\\"b":1,"a\\"b":2}'), ['a"b']);
    assert.deepEqual(duplicateKeys('{"\\u0061":1,"a":2}'), ["a"], "an escaped spelling is the same key");
  });

  it("does not flag the same key in different objects, empty containers, or scalars", () => {
    assert.deepEqual(duplicateKeys('{"a":{"a":1},"b":{"a":2}}'), []);
    assert.deepEqual(duplicateKeys('{"a":[],"b":{},"c":[{"a":1},{"a":2}]}'), []);
    assert.deepEqual(duplicateKeys("5"), []); assert.deepEqual(duplicateKeys('"x"'), []); assert.deepEqual(duplicateKeys(" [ ] "), []);
    assert.deepEqual(duplicateKeys('{"a":-1.5e3,"b":true,"c":null,"d":false}'), []);
  });

  it("refuses text that is not JSON instead of guessing", () => {
    for (const bad of ["", "{", '{"a"}', '{"a":1,}', '{"a":1 "b":2}', "[1,]", "{} x", '{"a":tru}', '"open']) assert.throws(() => duplicateKeys(bad), Error, JSON.stringify(bad));
  });
});
