import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseJson5 } from "../../src/import/json5.ts";
import { frontmatter, readYaml } from "../../src/import/yaml-lite.ts";

describe("parseJson5", () => {
  it("reads comments, trailing commas, unquoted keys, single quotes, hex and Infinity", () => {
    const v = parseJson5(`// top
    { a: 1, 'b': 'x\\'y', "c": [1, 2,], /* block */ d: { e: 0x1F, f: +Infinity, g: -.5, h: 5. }, i: null, j: true, }`);
    assert.deepEqual(v, { a: 1, b: "x'y", c: [1, 2], d: { e: 31, f: Infinity, g: -0.5, h: 5 }, i: null, j: true });
  });
  it("handles escapes and line continuations", () => {
    assert.deepEqual(parseJson5(`{ s: "a\\nb\\u0041\\
c" }`), { s: "a\nbAc" });
  });
  it("throws a SyntaxError on garbage and on trailing content", () => {
    assert.throws(() => parseJson5("{ a: }"), SyntaxError);
    assert.throws(() => parseJson5("{} x"), SyntaxError);
    assert.throws(() => parseJson5(""), SyntaxError);
  });
  it("does not let __proto__ keys pollute prototypes", () => {
    const v = parseJson5(`{ "__proto__": { polluted: 1 } }`) as Record<string, unknown>;
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.deepEqual(Object.keys(v), ["__proto__"]);
  });
});

describe("readYaml", () => {
  it("reads nested maps, block and flow lists, quoted scalars, numbers and booleans", () => {
    const { value, unsupported } = readYaml(`# comment
_config_version: 45
memory:
  memory_enabled: true
  provider: ""
skills:
  external_dirs:
    - ~/shared-skills
    - "/opt/skills"   # trailing comment
  disabled: [a, 'b c']
name: plain value with: colon
`);
    assert.deepEqual(unsupported, []);
    assert.deepEqual(value, {
      _config_version: 45,
      memory: { memory_enabled: true, provider: "" },
      skills: { external_dirs: ["~/shared-skills", "/opt/skills"], disabled: ["a", "b c"] },
      name: "plain value with: colon",
    });
  });
  it("reads | and > block scalars", () => {
    const { value } = readYaml("a: |\n  line one\n  line two\nb: >\n  folded\n  text\nc: 1\n");
    assert.deepEqual(value, { a: "line one\nline two\n", b: "folded text\n", c: 1 });
  });
  it("reports anchors and flow maps as unsupported instead of guessing", () => {
    const { value, unsupported } = readYaml("a: &x 1\nb: {c: 2}\nd: 3\n");
    assert.equal((value as Record<string, unknown>).d, 3);
    assert.ok(unsupported.length >= 2);
    assert.equal((value as Record<string, unknown>).a, undefined);
    assert.equal((value as Record<string, unknown>).b, undefined);
  });
  it("reads lists of maps", () => {
    const { value } = readYaml("jobs:\n  - id: one\n    every: 5m\n  - id: two\n");
    assert.deepEqual(value, { jobs: [{ id: "one", every: "5m" }, { id: "two" }] });
  });
});

describe("frontmatter", () => {
  it("reads the YAML block between --- lines", () => {
    const fm = frontmatter("---\nname: meeting-notes\ndescription: >\n  Turn notes\n  into items\nversion: 1.0.0\n---\n# Body\n");
    assert.deepEqual(fm, { name: "meeting-notes", description: "Turn notes into items\n", version: "1.0.0" });
  });
  it("returns null without frontmatter", () => {
    assert.equal(frontmatter("# just a body\n"), null);
    assert.equal(frontmatter("---\nname: x\n"), null);
  });
  it("accepts CRLF line endings", () => {
    assert.deepEqual(frontmatter("---\r\nname: x\r\n---\r\nbody"), { name: "x" });
  });
});
