// core/import yaml-lite.ts: table of supported constructs with fixed expected values (YAML 1.2 semantics for the subset the file
// header documents: block mappings and sequences, plain/quoted scalars, flow lists of scalars, | and > block scalars), the
// "unsupported" contract (anchors, aliases, tags, flow mappings, nested flow collections are named, never guessed), alias
// explosion, prototype pollution, frontmatter, scalar().
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readYaml, frontmatter, scalar } from "../../src/import/yaml-lite.ts";
import { prototypeFingerprint } from "./helpers.ts";

const ok = (text: string): unknown => { const r = readYaml(text); assert.deepStrictEqual(r.unsupported, [], `unsupported for ${JSON.stringify(text)}`); return r.value; };

describe("readYaml: supported constructs", () => {
  const table: [string, string, unknown][] = [
    ["empty document", "", null], ["only comments and blanks", "# a\n\n   # b\n", null], ["document markers only", "---\n...\n", null], ["whitespace only", " \n\t\n", null],
    ["plain scalars of every kind", "a: 1\nb: two\nc: true\nd: ~\ne:\nf: 1.5\ng: -3\nh: null\ni: False", { a: 1, b: "two", c: true, d: null, e: null, f: 1.5, g: -3, h: null, i: false }],
    ["null and boolean spellings", "a: Null\nb: NULL\nc: True\nd: TRUE\ne: false\nf: FALSE", { a: null, b: null, c: true, d: true, e: false, f: false }],
    ["signs and decimals", "a: +5\nb: -0.5\nc: .5\nd: 5.\ne: 1.5e3\nf: -2.5E-2", { a: 5, b: -0.5, c: 0.5, d: 5, e: 1500, f: -0.025 }],
    ["strings that only look special", "a: yes\nb: no\nc: on\nd: off\ne: nope\nf: truth\ng: nullable\nh: 1.2.3\ni: 12abc\nj: -", { a: "yes", b: "no", c: "on", d: "off", e: "nope", f: "truth", g: "nullable", h: "1.2.3", i: "12abc", j: "-" }],
    ["single quoted: '' is a quote, backslash is literal", "a: 'it''s'\nb: 'C:\\x\\y'\nc: ''\nd: '  padded  '", { a: "it's", b: "C:\\x\\y", c: "", d: "  padded  " }],
    ["double quoted escapes", "a: \"tab\\there\"\nb: \"nl\\nx\"\nc: \"\\u00e9\\x41\"\nd: \"q\\\"uote\"\ne: \"\"\nf: \"back\\\\slash\"", { a: "tab\there", b: "nl\nx", c: "éA", d: "q\"uote", e: "", f: "back\\slash" }],
    ["quoted values keep type-looking text as strings", "a: \"123\"\nb: 'true'\nc: \"null\"\nd: '~'", { a: "123", b: "true", c: "null", d: "~" }],
    ["plain value containing a colon and a hash", "name: plain value with: colon\nurl: http://example.com/a#frag\nx: a#b", { name: "plain value with: colon", url: "http://example.com/a#frag", x: "a#b" }],
    ["comments: trailing, in quotes, after quotes", "a: b # c\nc: 'x # kept'\nd: \"y # kept\" # gone\ne: 1 #2", { a: "b", c: "x # kept", d: "y # kept", e: 1 }],
    ["quoted keys", "'quoted key': 1\n\"dq key\": 2\n'it''s': 3", { "quoted key": 1, "dq key": 2, "it's": 3 }],
    ["keys with spaces and colons inside", "my key: 1\na:b: 2\nx.y-z: 3", { "my key": 1, "a:b": 2, "x.y-z": 3 }],
    ["nested mappings", "a:\n  b:\n    c: 1\n  d: 2\ne: 3", { a: { b: { c: 1 }, d: 2 }, e: 3 }],
    ["indent width of 4 and mixed widths", "a:\n    b: 1\n    c:\n          d: 2\ne:\n -  f: 3", { a: { b: 1, c: { d: 2 } }, e: [{ f: 3 }] }],
    ["block sequence", "list:\n  - a\n  - 1\n  - true\n  - ~\n  - 'q'\nafter: x", { list: ["a", 1, true, null, "q"], after: "x" }],
    ["sequence at the same indent as its key", "k:\n- a\n- b\nz: 1", { k: ["a", "b"], z: 1 }],
    ["sequence of mappings", "jobs:\n  - id: one\n    every: 5m\n  - id: two\n    nested:\n      x: 1\n  - id: three", { jobs: [{ id: "one", every: "5m" }, { id: "two", nested: { x: 1 } }, { id: "three" }] }],
    ["sequence of mappings with quoted first key", "- 'a b': 1\n  c: 2\n- \"d\": 3", [{ "a b": 1, c: 2 }, { d: 3 }]],
    ["top-level sequence", "- a\n- b: 1\n  c: 2\n- 3", ["a", { b: 1, c: 2 }, 3]],
    ["sequence item on the next line", "- a\n-\n  b: 1\n-\n  - x\n  - y", ["a", { b: 1 }, ["x", "y"]]],
    ["empty last item", "- a\n- ", ["a", null]], ["empty item before an indented mapping", "- a\n-\n  b: 1\n- c", ["a", { b: 1 }, "c"]],
    ["sequence under a sequence item key", "- k:\n    - 1\n    - 2\n  m: x", [{ k: [1, 2], m: "x" }]],
    ["flow lists of scalars", "a: [1, two, 'three, 3', \"f\"]\nb: []\nc: [ x ]\nd: [a, b,]", { a: [1, "two", "three, 3", "f"], b: [], c: ["x"], d: ["a", "b"] }],
    ["flow list inside a sequence", "- [a, b]\n- []\n- k: [1]", [["a", "b"], [], { k: [1] }]],
    ["literal block scalar keeps line breaks and extra indentation", "a: |\n  x\n   y\n  z\nb: 1", { a: "x\n y\nz\n", b: 1 }],
    ["literal block scalar with strip", "a: |-\n  x\n  y\nb: 1", { a: "x\ny", b: 1 }],
    ["folded block scalar joins lines, blank line is a newline", "a: >\n  one\n  two\n\n  three\nb: 1", { a: "one two\nthree\n", b: 1 }],
    ["folded with strip", "a: >-\n  one\n  two", { a: "one two" }],
    ["block scalar at the end of the file", "a: |\n  last line", { a: "last line\n" }],
    ["block scalar containing key-like and comment-like text", "a: |\n  b: not a key\n  # not a comment\n  - not a list\nc: 2", { a: "b: not a key\n# not a comment\n- not a list\n", c: 2 }],
    ["block scalar inside a sequence item", "- |\n  text\n- x", ["text\n", "x"]],
    ["document markers and comments between entries", "---\na: 1\n# comment\n\nb: 2\n...\n", { a: 1, b: 2 }],
    ["Windows line ends and BOM", "\ufeffa: 1\r\nb:\r\n  - x\r\n  - y\r\n", { a: 1, b: ["x", "y"] }],
    ["old Mac line ends", "a: 1\rb: 2\r", { a: 1, b: 2 }],
    ["unicode keys and values", "über: ß\nemoji: 😀\n日本: 語", { "über": "ß", emoji: "😀", "日本": "語" }],
    ["duplicate keys: the last one wins", "a: 1\na: 2\nb: 0", { a: 2, b: 0 }],
    ["trailing whitespace is ignored", "a: 1   \nb: x  \n   \n", { a: 1, b: "x" }],
  ];
  for (const [label, text, expected] of table) it(label, () => { assert.deepStrictEqual(ok(text), expected); });

  it("a Hermes-style configuration file", () => {
    const text = `# ~/.hermes/config.yaml
_config_version: 45
model:
  provider: "openrouter"   # which backend
  name: 'vendor/model-b'
memory:
  memory_enabled: true
  user_profile_enabled: false
  limits:
    memory_chars: 2200
    ratio: 0.5
skills:
  external_dirs:
    - ~/shared-skills
    - "/opt/skills"
  disabled: [alpha, 'beta gamma']
approvals:
  allow:
    - pattern: "^git (status|log)"
      mode: once
    - pattern: '^ls'
      mode: always
`;
    assert.deepStrictEqual(ok(text), {
      _config_version: 45, model: { provider: "openrouter", name: "vendor/model-b" },
      memory: { memory_enabled: true, user_profile_enabled: false, limits: { memory_chars: 2200, ratio: 0.5 } },
      skills: { external_dirs: ["~/shared-skills", "/opt/skills"], disabled: ["alpha", "beta gamma"] },
      approvals: { allow: [{ pattern: "^git (status|log)", mode: "once" }, { pattern: "^ls", mode: "always" }] },
    });
  });

  it("objects are plain objects with Object.prototype and own, enumerable, writable, configurable data properties", () => {
    const v = ok("a: 1") as Record<string, unknown>;
    assert.equal(Object.getPrototypeOf(v), Object.prototype);
    assert.deepEqual(Object.getOwnPropertyDescriptor(v, "a"), { value: 1, writable: true, enumerable: true, configurable: true });
  });

  it("readYaml does not mutate its input and each call returns fresh objects", () => {
    const text = "a:\n  - 1\n"; const a = ok(text) as { a: number[] }; a.a.push(2);
    assert.deepStrictEqual(ok(text), { a: [1] });
  });
});

describe("readYaml: the unsupported contract (named, never guessed)", () => {
  const table: [string, string, unknown, string[]][] = [
    ["anchor on a scalar", "a: &x 1\nd: 3", { d: 3 }, ["a (line 1): anchor/alias/tag"]],
    ["alias", "a: *x\nd: 3", { d: 3 }, ["a (line 1): anchor/alias/tag"]],
    ["anchor with a block below it", "base: &b\n  k: 1\nother: 2", { other: 2 }, ["base (line 1): anchor/alias/tag"]],
    ["merge key with an alias", "base: &b\n  k: 1\nder:\n  <<: *b\n  own: 1", { der: { own: 1 } }, ["base (line 1): anchor/alias/tag", "<< (line 4): anchor/alias/tag"]],
    ["explicit tag", "a: !!str 1\nb: !custom x\nc: 2", { c: 2 }, ["a (line 1): anchor/alias/tag", "b (line 2): anchor/alias/tag"]],
    ["flow mapping", "a: {b: 1}\nc: 2", { c: 2 }, ["a (line 1): flow mapping"]],
    ["empty flow mapping", "a: {}\nc: 2", { c: 2 }, ["a (line 1): flow mapping"]],
    ["nested flow list", "a: [1, [2]]\nc: 2", { c: 2 }, ["a (line 1): nested or multi-line flow list"]],
    ["flow list with a flow mapping inside", "a: [{x: 1}]\nc: 2", { c: 2 }, ["a (line 1): nested or multi-line flow list"]],
    ["multi-line flow list", "a: [1,\n  2]\nc: 3", { c: 3 }, ["a (line 1): nested or multi-line flow list"]],
    ["anchor in a sequence item", "- &x 1\n- b", ["b"], ["item 0 (line 1): anchor/alias/tag"]],
    ["alias in a sequence item", "- *x\n- b", ["b"], ["item 0 (line 1): anchor/alias/tag"]],
    ["flow mapping in a sequence item", "- {a: 1}\n- b", ["b"], ["item 0 (line 1): flow mapping"]],
    ["line that is not a mapping entry", "just text\na: 1", { a: 1 }, ["line 1: not a mapping entry"]],
    ["explicit key syntax", "? a\n: b", {}, ["line 1: not a mapping entry", "line 2: not a mapping entry"]],
    ["unexpected deeper indentation", "a: 1\n  b: 2\nc: 3", { a: 1, c: 3 }, ["line 2: unexpected indentation"]],
    ["unexpected indentation of one space", "a: 1\n b: 2", { a: 1 }, ["line 2: unexpected indentation"]],
    ["plain multi-line scalar continuation", "a: first\n  second\nb: 1", { a: "first", b: 1 }, ["line 2: unexpected indentation"]],
    ["top-level flow list", "[a, b]", {}, ["line 1: not a mapping entry"]],
    ["top-level flow mapping", "{a: 1}", {}, ["line 1: not a mapping entry"]],
    ["mapping line inside a sequence", "- k: v\n  - x", [{ k: "v" }], ["line 2: not a mapping entry"]],
  ];
  for (const [label, text, value, unsupported] of table) it(label, () => {
    const r = readYaml(text);
    assert.deepStrictEqual(r.value, value); assert.deepStrictEqual(r.unsupported, unsupported);
  });

  it("the entry that follows an unsupported one is still read, with its own children", () => {
    const r = readYaml("a: &x\n  deep:\n    deeper: 1\nb:\n  c: 2\n");
    assert.deepStrictEqual(r.value, { b: { c: 2 } }); assert.equal(r.unsupported.length, 1);
  });

  it("the importer relies on two phrases: 'not a mapping entry' and 'unexpected indentation' (malformed YAML), the others mean 'skip the key'", () => {
    for (const text of ["x", "a: 1\n  b: 2"]) assert.ok(readYaml(text).unsupported.some(u => /not a mapping entry|unexpected indentation/.test(u)), text);
    for (const text of ["a: &x 1", "a: {b: 1}", "a: [[1]]", "a: !t x"]) assert.ok(!readYaml(text).unsupported.some(u => /not a mapping entry|unexpected indentation/.test(u)), text);
  });

  it("the unsupported list names keys and line numbers only, never the value text (values may be secrets)", () => {
    const r = readYaml("api_key: &probe redact-probe-alpha\ntoken: {v: redact-probe-beta}\nx: [redact-probe-alpha, [1]]\nline redact-probe-beta");
    assert.ok(!JSON.stringify(r.unsupported).includes("redact-probe"));
  });
});

describe("readYaml: alias explosion (billion laughs)", () => {
  const laughs = (levels: number, fan: number): string => {
    const lines = ["lol0: &a0 [\"lol\", \"lol\", \"lol\", \"lol\", \"lol\", \"lol\", \"lol\", \"lol\", \"lol\"]"];
    for (let i = 1; i < levels; i++) lines.push(`lol${i}: &a${i} [${Array.from({ length: fan }, () => `*a${i - 1}`).join(", ")}]`);
    lines.push("trailer: ok");
    return lines.join("\n");
  };

  it("aliases are not expanded: the classic nine-level document yields no data, one note per anchor line, and finishes at once", () => {
    const text = laughs(9, 9);
    const r = readYaml(text);
    const value = r.value as Record<string, unknown>;
    assert.deepStrictEqual(Object.keys(value), ["trailer"], "every anchored line is left out");
    assert.equal(r.unsupported.length, 9);
    assert.ok(JSON.stringify(r).length < 2000, "output size is independent of the alias fan-out");
  });

  it("an alias chain of 2 000 levels is 2 000 notes, not 2 000 expansions", () => {
    const text = Array.from({ length: 2000 }, (_, i) => `k${i}: ${i === 0 ? "&a0 x" : `&a${i} *a${i - 1}`}`).join("\n");
    const started = readYaml(text);
    assert.equal(started.unsupported.length, 2000); assert.deepStrictEqual(started.value, {});
  });

  it("aliases to anchors inside sequences and flow lists are refused too", () => {
    const r = readYaml("- &a [1, 2]\n- *a\n- [*a, *a]\nk: v");
    assert.ok(r.unsupported.length >= 2);
    assert.equal(JSON.stringify(r.value).includes("lol"), false);
  });
});

describe("readYaml: prototype pollution", () => {
  const docs = [
    "__proto__:\n  polluted: 1", "constructor:\n  prototype:\n    polluted: 1", "prototype:\n  polluted: 1", "a:\n  __proto__:\n    polluted: 1", "- __proto__:\n    polluted: 1",
    "'__proto__': {polluted: 1}", "\"__proto__\":\n  polluted: 1", "__proto__: [1, 2]", "__proto__: x", "__proto__:\n  - a\n  - b", "__proto__: |\n  text",
    "toString: 1\nvalueOf: 2\nhasOwnProperty: 3\nconstructor: 4\n__defineGetter__: 5",
  ];
  for (const text of docs) it(`does not touch any shared prototype: ${JSON.stringify(text)}`, () => {
    const before = prototypeFingerprint();
    const { value } = readYaml(text);
    assert.equal(prototypeFingerprint(), before);
    assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
    assert.equal((Object.prototype as unknown as Record<string, unknown>)["polluted"], undefined);
    if (value && typeof value === "object" && !Array.isArray(value)) assert.equal(Object.getPrototypeOf(value), Object.prototype);
  });

  it("a __proto__ key is an own data property; the object's prototype is not replaced", () => {
    const { value } = readYaml("a: 1\n__proto__:\n  b: 2\nc: 3");
    const v = value as Record<string, unknown>;
    assert.deepEqual(Object.keys(v), ["a", "__proto__", "c"]);
    assert.deepEqual(Object.getOwnPropertyDescriptor(v, "__proto__")?.value, { b: 2 });
    assert.equal(v["b"], undefined);
  });

  it("frontmatter parsing of hostile keys is just as inert", () => {
    const before = prototypeFingerprint();
    const fm = frontmatter("---\n__proto__:\n  polluted: 1\nconstructor:\n  prototype:\n    polluted: 1\nname: x\n---\nbody") as Record<string, unknown>;
    assert.equal(prototypeFingerprint(), before); assert.equal(fm["name"], "x");
    assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
  });
});

describe("frontmatter", () => {
  it("returns the mapping between the leading --- line and the next --- line", () => {
    assert.deepStrictEqual(frontmatter("---\nname: meeting-notes\nversion: 1.0.0\ntags: [a, b]\n---\n# Body\nname: not this\n"), { name: "meeting-notes", version: "1.0.0", tags: ["a", "b"] });
  });
  it("supports block scalars and nested mappings the way skills use them", () => {
    assert.deepStrictEqual(frontmatter("---\nname: x\ndescription: >\n  Turn notes\n  into items\nmetadata:\n  hermes:\n    tags: [t1, t2]\n    related_skills:\n      - other\n---\n"), { name: "x", description: "Turn notes into items\n", metadata: { hermes: { tags: ["t1", "t2"], related_skills: ["other"] } } });
  });
  it("accepts CRLF, a BOM and an end marker at the very end of the file", () => {
    assert.deepStrictEqual(frontmatter("\ufeff---\r\nname: x\r\n---\r\nbody"), { name: "x" });
    assert.deepStrictEqual(frontmatter("---\nname: x\n---"), { name: "x" });
  });
  it("is null without a leading marker, without a closing marker, or when the closing marker has trailing characters", () => {
    for (const t of ["# just a body\n", "", "name: x\n---\n", "---\nname: x\n", "--- \nname: x\n---\n", "\n---\nname: x\n---\n", "---\nname: x\n---body", "---\nname: x\n----\n", "---\nname: x\n--- \n"]) assert.equal(frontmatter(t), null, JSON.stringify(t));
  });
  it("an empty or non-mapping block gives an empty object, not null", () => {
    for (const t of ["---\n---\nbody", "---\n# only a comment\n---\n", "---\n- a\n- b\n---\n", "---\njust text\n---\n"]) assert.deepStrictEqual(frontmatter(t), {}, JSON.stringify(t));
  });
  it("unsupported entries inside the block are dropped, the rest is kept", () => {
    assert.deepStrictEqual(frontmatter("---\nname: x\nanchored: &a 1\nflow: {k: 1}\nok: yes\n---\n"), { name: "x", ok: "yes" });
  });
  it("the first closing marker wins; later '---' lines belong to the body", () => {
    assert.deepStrictEqual(frontmatter("---\na: 1\n---\nb: 2\n---\nc: 3\n"), { a: 1 });
  });
});

describe("scalar()", () => {
  const table: [string, unknown][] = [
    ["", null], ["~", null], ["null", null], ["Null", null], ["NULL", null], ["  null  ", null], ["true", true], ["True", true], ["TRUE", true], ["false", false], ["False", false], ["FALSE", false],
    ["0", 0], ["-0", -0], ["+7", 7], ["42", 42], ["-42", -42], ["1.5", 1.5], ["-1.5", -1.5], [".5", 0.5], ["5.", 5], ["1.5e3", 1500], ["2.E+2", 200],
    ["'a'", "a"], ["'a''b'", "a'b"], ["\"a\\tb\"", "a\tb"], ["\"\\x41\"", "A"], ["''", ""], ["\"\"", ""], ["'", "'"], ["\"", "\""],
    ["yes", "yes"], ["no", "no"], ["on", "on"], ["nULL", "nULL"], ["tRue", "tRue"], ["1e3", "1e3"], ["0x10", "0x10"], ["0o7", "0o7"], [".inf", ".inf"], [".nan", ".nan"], ["1_000", "1_000"], ["1,5", "1,5"], ["text with spaces", "text with spaces"],
    ["'unterminated", "'unterminated"], ["\"unterminated", "\"unterminated"], ["\"bad \\q escape\"", "bad \\q escape"],
  ];
  for (const [input, expected] of table) it(`${JSON.stringify(input)}`, () => { assert.deepStrictEqual(scalar(input), expected); });
});

describe("readYaml: edge cases and characterizations", () => {
  it("readYaml (block scalar keep): '|+' keeps every trailing blank line (YAML 1.2 block chomping indicator +): 'y\\n\\n'", () => {
    assert.deepStrictEqual(ok("b: |+\n  y\n\nc: 1\n"), { b: "y\n\n", c: 1 });
  });

  it("readYaml (empty sequence item): a bare '-' between items is a null item: ['a', null, 'b']", () => {
    assert.deepStrictEqual(ok("- a\n-\n- b"), ["a", null, "b"]);
  });

  it("readYaml (nested block sequence on one line): '- - x' is a sequence in a sequence ([['x']]) or is reported in `unsupported` (header: 'anything else is not guessed at')", () => {
    const r = readYaml("- a\n- - x\n");
    const guessed = Array.isArray(r.value) && r.value[1] === "- x";
    assert.ok(!guessed || r.unsupported.length > 0, `guessed ${JSON.stringify(r.value)} without a note`);
  });

  it("readYaml (indentation depth): very deep nesting ends in a documented outcome (an `unsupported` note or a typed parse error), as parseJson5 does with its depth limit", () => {
    const text = Array.from({ length: 6000 }, (_, i) => " ".repeat(i) + "k:").join("\n") + " 1";
    assert.doesNotThrow(() => readYaml(text), (e: Error) => e instanceof RangeError);
    assert.ok(readYaml(text).unsupported.some((u) => u.includes("nesting")), "the too-deep part is named in `unsupported`");
  });

  it("readYaml (line scanning): run time linear in the line length (a mapping-entry check on a 30 000-character line takes milliseconds)", () => {
    // Wall-clock on purpose: the property under test is the run time itself; a linear scan needs a few ms, the bound leaves a ~50x margin.
    const text = "a" + " ".repeat(30_000) + "b";
    const started = performance.now();
    readYaml(text);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 250, `readYaml took ${Math.round(elapsed)} ms`);
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - integers beyond 2^53 lose precision silently (an 18-digit id becomes a different number)", () => {
    assert.equal((ok("id: 123456789012345678") as { id: number }).id, 123456789012345680);
    assert.equal((ok("ids: [9007199254740993]") as { ids: number[] }).ids[0], 9007199254740992);
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - YAML 1.2 core numbers other than plain decimals stay strings, and a leading zero is read as a decimal", () => {
    assert.deepStrictEqual(ok("a: 0x10\nb: 0o17\nc: 1e3\nd: .inf\ne: .NaN\nf: 010\ng: 1_000"), { a: "0x10", b: "0o17", c: "1e3", d: ".inf", e: ".NaN", f: 10, g: "1_000" });
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - several documents in one file are merged into one mapping", () => {
    assert.deepStrictEqual(ok("a: 1\n---\nb: 2\n---\na: 3\n"), { a: 3, b: 2 });
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - a tab counts as one column of indentation (YAML forbids tabs for indentation)", () => {
    assert.deepStrictEqual(ok("k:\n\tv: 1"), { k: { v: 1 } });
    assert.deepStrictEqual(ok("\tk: v"), { k: "v" });
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - unterminated or badly escaped quotes are returned as plain text instead of being reported", () => {
    assert.deepStrictEqual(ok("a: 'open\nb: \"open\nc: \"bad \\q\""), { a: "'open", b: "\"open", c: "bad \\q" });
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - a block scalar indentation indicator (|2) is accepted and ignored; the indent is taken from the first line", () => {
    assert.deepStrictEqual(ok("a: |2\n    x\n    y\nb: 1"), { a: "x\ny\n", b: 1 });
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - 'key: a: b' (invalid YAML) reads as the string 'a: b'", () => {
    assert.deepStrictEqual(ok("key: a: b"), { key: "a: b" });
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - a flow list may contain quoted items with commas and brackets; unquoted brackets make it nested (unsupported)", () => {
    assert.deepStrictEqual(ok("a: ['x, y', \"p]q\"]"), { a: ["x, y", "p]q"] });
    assert.equal(readYaml("a: [x[1]]").unsupported.length, 1);
  });
});
