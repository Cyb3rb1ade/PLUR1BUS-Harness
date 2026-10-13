// core/import json5.ts: table of valid constructs with fixed expected values (JSON5 spec, https://spec.json5.org),
// error table, spec deviations, prototype pollution, bounds. Expectations come from the JSON5 grammar, not from running the parser.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseJson5 } from "../../src/import/json5.ts";
import { gap, prototypeFingerprint } from "./helpers.ts";

const NL = "\n";

describe("parseJson5: valid constructs", () => {
  const table: [string, string, unknown][] = [
    ["empty object", "{}", {}], ["empty array", "[]", []], ["whitespace around", " \t\r\n {} \n", {}],
    ["line comment before", "// top\n{a:1}", { a: 1 }], ["line comment after", "{a:1} // end", { a: 1 }], ["block comment before", "/* x */ {a:1}", { a: 1 }],
    ["block comment spanning lines", "/* a\n b\n */ [1]", [1]], ["comments between every token", "{ /*1*/ a /*2*/ : /*3*/ 1 /*4*/ , /*5*/ b : 2 /*6*/ }", { a: 1, b: 2 }],
    ["comment markers inside strings", "{ a: '// not a comment', b: \"/* nor this */\" }", { a: "// not a comment", b: "/* nor this */" }],
    ["comment at end without newline", "[1] //", [1]], ["adjacent comments", "//a\n//b\n/*c*//*d*/ 7", 7],
    ["trailing comma in object", "{a:1,}", { a: 1 }], ["trailing comma in array", "[1,2,]", [1, 2]], ["trailing commas nested", "{a:[1,{b:2,},],}", { a: [1, { b: 2 }] }],
    ["unquoted keys", "{a:1,_b:2,$c:3,d4:4}", { a: 1, _b: 2, $c: 3, d4: 4 }], ["reserved words as keys", "{if:1,class:2,null:3,true:4,NaN:5,Infinity:6}", { if: 1, class: 2, null: 3, true: 4, NaN: 5, Infinity: 6 }],
    ["unicode letters in unquoted keys", "{über:1,日本:2}", { "über": 1, "日本": 2 }], ["escaped unquoted key", "{\\u0061b:1}", { ab: 1 }],
    ["mixed key styles", "{a:1,'b':2,\"c\":3}", { a: 1, b: 2, c: 3 }],
    ["single quoted string", "'abc'", "abc"], ["double quote inside single quotes", "'He said \"hi\"'", "He said \"hi\""], ["single quote inside double quotes", "\"it's\"", "it's"],
    ["escaped quotes", "'it\\'s' ", "it's"],
    ["hex integer", "0x1F", 31], ["negative hex", "-0xff", -255], ["signed hex", "+0X10", 16], ["large hex", "0xdeadbeef", 3735928559], ["hex zero", "0x0", 0],
    ["leading decimal point", ".5", 0.5], ["trailing decimal point", "5.", 5], ["explicit plus", "+1", 1], ["negative", "-12", -12], ["exponent", "1e3", 1000], ["negative exponent", "1E-2", 0.01],
    ["positive exponent", "1.5e+2", 150], ["decimal with exponent", "0.5e-2", 0.005], ["trailing point with exponent", "1.e2", 100], ["zero", "0", 0], ["decimal zero", "0.0", 0],
    ["Infinity", "Infinity", Infinity], ["negative Infinity", "-Infinity", -Infinity], ["plus Infinity", "+Infinity", Infinity], ["NaN", "NaN", NaN],
    ["negative zero", "-0", -0], ["true", "true", true], ["false", "false", false], ["null", "null", null],
    ["line continuation (LF)", "\"a\\" + NL + "b\"", "ab"], ["line continuation (CRLF)", "\"a\\\r\nb\"", "ab"], ["line continuation (CR)", "\"a\\\rb\"", "ab"], ["line continuation (U+2028)", "\"a\\ b\"", "ab"],
    ["multi-line string with continuations", "'line one \\" + NL + "line two \\" + NL + "line three'", "line one line two line three"],
    ["simple escapes", "'\\b\\f\\n\\r\\t\\v\\0'", "\b\f\n\r\t\v\0"], ["hex escape", "'\\x41\\x7a'", "Az"], ["unicode escape", "'\\u0041\\u00e9'", "Aé"], ["surrogate pair escape", "'\\ud83d\\ude00'", "😀"],
    ["escaped backslash and quotes", "'\\\\ \\' \\\"'", "\\ ' \""], ["identity escapes", "'\\a\\/\\q'", "a/q"],
    ["raw U+2028 in string", "'a b'", "a b"], ["raw emoji and CJK", "'😀日本'", "😀日本"], ["raw tab in string", "'a\tb'", "a\tb"],
    ["nested arrays", "[[[]],[1,[2]]]", [[[]], [1, [2]]]], ["nested objects", "{a:{b:{c:[1,{d:2}]}}}", { a: { b: { c: [1, { d: 2 }] } } }],
    ["duplicate keys: last wins", "{a:1,a:2}", { a: 2 }], ["leading BOM", "﻿{a:1}", { a: 1 }], ["exotic whitespace", "[ 1,\u000b2,\u000c3﻿]", [1, 2, 3]],
    ["top-level string", "\"x\"", "x"], ["empty string", "''", ""], ["array of every literal", "[null,true,false,0,-1,.5,'s',[],{}]", [null, true, false, 0, -1, 0.5, "s", [], {}]],
    ["number then comma then comment", "[1, // one\n 2 /* two */]", [1, 2]],
  ];
  for (const [label, text, expected] of table) it(label, () => { assert.deepStrictEqual(parseJson5(text), expected); });

  it("an OpenClaw-style configuration file (comments, unquoted keys, trailing commas, hex, single quotes)", () => {
    const text = `// ~/.openclaw/openclaw.json
{
  meta: { lastTouchedVersion: '2026.1.5', },
  agents: {
    defaults: { workspace: "~/.openclaw/workspace", /* default workspace */ },
    list: [ { id: 'main', default: true, }, { id: 'ops', model: 'provider/model-a', }, ],
  },
  channels: { telegram: { enabled: true, allowFrom: [ 0x10, '@someone', ], }, },
  limits: { maxBytes: 1e6, ratio: .25, },
}
`;
    assert.deepStrictEqual(parseJson5(text), {
      meta: { lastTouchedVersion: "2026.1.5" },
      agents: { defaults: { workspace: "~/.openclaw/workspace" }, list: [{ id: "main", default: true }, { id: "ops", model: "provider/model-a" }] },
      channels: { telegram: { enabled: true, allowFrom: [16, "@someone"] } },
      limits: { maxBytes: 1000000, ratio: 0.25 },
    });
  });

  it("every JSON document is a JSON5 document with the same value", () => {
    for (const text of ["{\"a\":[1,2.5,-3e2,true,null,\"x\\n\\u00e9\"],\"b\":{}}", "[]", "\"s\"", "123", "-0.5", "{\"nested\":{\"deeper\":[[],[[]]]}}"]) assert.deepStrictEqual(parseJson5(text), JSON.parse(text), text);
  });

  it("objects are plain objects with Object.prototype and own, enumerable, writable, configurable data properties", () => {
    const v = parseJson5("{a:1}") as Record<string, unknown>;
    assert.equal(Object.getPrototypeOf(v), Object.prototype);
    assert.deepEqual(Object.getOwnPropertyDescriptor(v, "a"), { value: 1, writable: true, enumerable: true, configurable: true });
  });

  it("each call returns fresh objects (no shared state between parses)", () => {
    const a = parseJson5("{x:[1]}") as { x: number[] }; a.x.push(2);
    assert.deepStrictEqual(parseJson5("{x:[1]}"), { x: [1] });
  });

  it("large documents: a 5 MB string, 300 000 array elements", () => {
    assert.equal((parseJson5(`"${"a".repeat(5_000_000)}"`) as string).length, 5_000_000);
    assert.equal((parseJson5(`[${"1,".repeat(300_000)}]`) as unknown[]).length, 300_000);
  });
});

describe("parseJson5: errors are SyntaxErrors that name the problem", () => {
  const bad: [string, string, RegExp][] = [
    ["empty input", "", /unexpected end/], ["whitespace only", "  \n ", /unexpected end/], ["only a comment", "// nothing", /unexpected end/],
    ["unterminated block comment", "/* never closed", /unterminated comment/], ["lone slash", "/", /unexpected token/], ["unterminated string", "'abc", /unterminated string/],
    ["newline in string", "'a\nb'", /newline in string/], ["CR in string", "'a\rb'", /newline in string/], ["backslash at end", "'abc\\", /unterminated string/],
    ["bad hex escape", "'\\x1'", /bad hex escape/], ["bad unicode escape", "'\\u12G4'", /bad hex escape/], ["short unicode escape", "'\\u12'", /bad hex escape/],
    ["octal escape", "'\\01'", /octal escape/], ["digit escape", "'\\1'", /bad escape/], ["escape 9", "'\\9'", /bad escape/],
    ["missing value", "{ a: }", /unexpected token/], ["missing colon", "{ a 1 }", /expected ':'/], ["missing comma in object", "{a:1 b:2}", /expected ',' or '}'/], ["missing comma in array", "[1 2]", /expected ',' or '\]'/],
    ["double comma in object", "{a:1,,}", /expected a key/], ["leading comma in object", "{,}", /expected a key/], ["leading comma in array", "[,]", /unexpected token/], ["double comma in array", "[1,,2]", /unexpected token/],
    ["unclosed object", "{a:1", /expected ',' or '}'/], ["unclosed array", "[1", /expected ',' or '\]'/], ["numeric key", "{1:2}", /expected a key/], ["key without name", "{:1}", /expected a key/],
    ["trailing content", "{} x", /trailing content/], ["two values", "1 2", /trailing content/], ["extra closing brace", "{}}", /trailing content/],
    ["undefined", "undefined", /unexpected token/], ["misspelled literal", "tru", /unexpected token/], ["literal with suffix", "true1", /unexpected token/], ["nulll", "nulll", /unexpected token/],
    ["sign only", "-", /bad number/], ["double sign", "--1", /bad number/], ["plus minus", "+-1", /bad number/], ["lone dot", ".", /bad number/], ["Inf prefix", "Inf", /bad number/],
    ["hex without digits", "0x", /trailing content/], ["hex with non-hex", "0xg", /trailing content/], ["two decimal points", "1.2.3", /trailing content/], ["number with letter suffix", "1abc", /trailing content/], ["Infinity with suffix", "Infinityx", /trailing content/],
    ["backtick string", "`a`", /unexpected token/], ["unquoted value", "{a: b}", /unexpected token/], ["NUL after document", "{a:1}\u0000", /trailing content/],
  ];
  for (const [label, text, pattern] of bad) it(label, () => {
    assert.throws(() => parseJson5(text), (e: unknown) => e instanceof SyntaxError && /^JSON5: /.test(e.message) && pattern.test(e.message) && / at offset \d+$/.test(e.message), JSON.stringify(text));
  });

  it("the error message never contains the input text (it may hold secrets)", () => {
    for (const text of ["{ token: redact-probe-alpha }", "{ \"k\": 'redact-probe-beta", "[redact-probe-alpha, 1"]) assert.throws(() => parseJson5(text), (e: Error) => !e.message.includes("redact-probe"), text);
  });

  it("the reported offset points at the failure", () => {
    assert.throws(() => parseJson5("{a:1,,}"), /offset 5$/);
    assert.throws(() => parseJson5("[1, 2 3]"), /offset 6$/);
  });
});

describe("parseJson5: nesting bound", () => {
  it("deeply nested brackets up to depth 10 000 end in a SyntaxError, never a stack overflow or a hang", () => {
    for (const depth of [1000, 10_000, 100_000]) {
      for (const [open, close] of [["[", "]"], ["{\"a\":", "}"], ["[{\"a\":", "}]"]] as const) {
        const text = open.repeat(depth) + "1" + close.repeat(depth);
        assert.throws(() => parseJson5(text), (e: unknown) => e instanceof SyntaxError && /nesting too deep/.test(e.message), `${open} depth ${depth}`);
      }
    }
  });

  it("unterminated deep nesting fails the same way (the depth check comes before the missing closers)", () => {
    assert.throws(() => parseJson5("[".repeat(100_000)), /nesting too deep/);
    assert.throws(() => parseJson5("{a:".repeat(50_000)), /nesting too deep/);
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - 201 nested empty arrays parse, 202 are refused; objects that end in a scalar leaf allow 200 levels (the leaf counts as one)", () => {
    const nest = (n: number) => "[".repeat(n) + "]".repeat(n);
    assert.doesNotThrow(() => parseJson5(nest(201)));
    assert.throws(() => parseJson5(nest(202)), /nesting too deep/);
    const o = (n: number) => "{a:".repeat(n) + "1" + "}".repeat(n);
    assert.doesNotThrow(() => parseJson5(o(200))); assert.throws(() => parseJson5(o(201)), /nesting too deep/);
  });
});

describe("parseJson5: prototype pollution", () => {
  const hostile = [
    "{\"__proto__\":{\"polluted\":1}}", "{__proto__:{polluted:1}}", "{'__proto__':{polluted:1}}", "{\\u005f_proto__:{polluted:1}}", "{\"\\u005f\\u005fproto__\":{polluted:1}}",
    "{constructor:{prototype:{polluted:1}}}", "{\"constructor\":{\"prototype\":{\"polluted\":1}}}", "{prototype:{polluted:1}}", "{a:{__proto__:{polluted:1}}}", "[{__proto__:{polluted:1}}]",
    "{__proto__:[1,2,3]}", "{__proto__:null}", "{__proto__:'x'}", "{__proto__:1,__proto__:2}", "{a:1,__proto__:{b:2},c:3}",
    "{__proto__:{toString:1,valueOf:2,hasOwnProperty:3,constructor:4,polluted:5}}", "{toString:1,valueOf:2,hasOwnProperty:3,isPrototypeOf:4}",
  ];
  for (const text of hostile) it(`does not touch any shared prototype: ${text}`, () => {
    const before = prototypeFingerprint();
    const v = parseJson5(text);
    assert.equal(prototypeFingerprint(), before);
    assert.equal(({} as Record<string, unknown>)["polluted"], undefined); assert.equal((Object.prototype as unknown as Record<string, unknown>)["polluted"], undefined);
    assert.equal(([] as unknown as Record<string, unknown>)["polluted"], undefined);
    if (v && typeof v === "object" && !Array.isArray(v)) assert.equal(Object.getPrototypeOf(v), Object.prototype, "the parsed object keeps the normal prototype");
    if (Array.isArray(v)) assert.equal(Object.getPrototypeOf(v), Array.prototype);
  });

  it("a __proto__ key is an ordinary own data property, other keys of the same object are unaffected", () => {
    const v = parseJson5("{a:1,__proto__:{b:2},c:3}") as Record<string, unknown>;
    assert.deepEqual(Object.keys(v), ["a", "__proto__", "c"]);
    assert.deepEqual(Object.getOwnPropertyDescriptor(v, "__proto__")?.value, { b: 2 });
    assert.equal(v["b" as never], undefined, "the nested object is not inherited");
    assert.equal(v["a"], 1); assert.equal(v["c"], 3);
  });

  it("a later duplicate __proto__ replaces the earlier one without error", () => {
    assert.deepEqual(Object.getOwnPropertyDescriptor(parseJson5("{__proto__:1,__proto__:2}"), "__proto__")?.value, 2);
  });

  it("copying with spread or JSON keeps the key as data and still pollutes nothing", () => {
    const v = parseJson5("{__proto__:{polluted:1}}") as Record<string, unknown>;
    const copy = { ...v }; const viaJson = JSON.parse(JSON.stringify(v)) as Record<string, unknown>;
    assert.equal(Object.getPrototypeOf(copy), Object.prototype); assert.equal((copy as Record<string, unknown>)["polluted"], undefined);
    assert.equal(Object.getPrototypeOf(viaJson), Object.prototype);
    assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
  });
});

describe("parseJson5: deviations from the JSON5 specification it cites", () => {
  it(gap("parseJson5 (whitespace)", "any Unicode Space_Separator (U+1680, U+2000-U+200A, U+202F, U+205F, U+3000) is whitespace (JSON5 spec 5.1)", "SyntaxError: unexpected token"), { todo: gap("parseJson5 (whitespace)", "any Unicode Space_Separator (U+1680, U+2000-U+200A, U+202F, U+205F, U+3000) is whitespace (JSON5 spec 5.1)", "SyntaxError: unexpected token") }, () => {
    for (const ws of [" ", " ", " ", " ", " ", " ", "　"]) assert.deepStrictEqual(parseJson5(`[${ws}1${ws}]`), [1], `U+${ws.charCodeAt(0).toString(16)}`);
  });

  it(gap("parseJson5 (line comments)", "a // comment ends at U+2028 and U+2029 as well (they are LineTerminators in JSON5)", "the comment continues to the next LF or CR, swallowing the value on the following 'line'"), { todo: gap("parseJson5 (line comments)", "a // comment ends at U+2028 and U+2029 as well (they are LineTerminators in JSON5)", "the comment continues to the next LF or CR, swallowing the value on the following 'line'") }, () => {
    assert.deepStrictEqual(parseJson5("// c  1"), 1);
    assert.deepStrictEqual(parseJson5("[// c  1]"), [1]);
  });

  it(gap("parseJson5 (identifiers)", "U+FEFF, U+2028, U+2029 and the other Space_Separator characters above U+00BF end an unquoted key or a literal as whitespace (JSON5 spec 5.1: they are WhiteSpace/LineTerminator, not IdentifierPart)", "they are consumed as identifier characters: '{a<U+FEFF>:1}' yields the key 'a<U+FEFF>', and '[true<U+FEFF>]' is a SyntaxError (unexpected token)"), { todo: gap("parseJson5 (identifiers)", "U+FEFF, U+2028, U+2029 and the other Space_Separator characters above U+00BF end an unquoted key or a literal as whitespace (JSON5 spec 5.1: they are WhiteSpace/LineTerminator, not IdentifierPart)", "they are consumed as identifier characters: '{a<U+FEFF>:1}' yields the key 'a<U+FEFF>', and '[true<U+FEFF>]' is a SyntaxError (unexpected token)") }, () => {
    // ID_START/ID_PART in json5.ts accept the whole range U+00C0-U+FFFF, which contains the whitespace characters WS lists.
    for (const ws of ["\ufeff", "\u2028", "\u2029"].map(e => JSON.parse(`"${e}"`) as string)) {
      assert.deepStrictEqual(parseJson5(`{a${ws}:1}`), { a: 1 }, `key followed by U+${ws.charCodeAt(0).toString(16)}`);
      assert.deepStrictEqual(parseJson5(`[true${ws}]`), [true], `literal followed by U+${ws.charCodeAt(0).toString(16)}`);
    }
  });

  it(gap("parseJson5 (numbers)", "a number with a leading zero ('010', '00') is a SyntaxError (JSON5 grammar: DecimalIntegerLiteral is 0 or starts with 1-9)", "'010' parses as 10 and '00' as 0"), { todo: gap("parseJson5 (numbers)", "a number with a leading zero ('010', '00') is a SyntaxError (JSON5 grammar: DecimalIntegerLiteral is 0 or starts with 1-9)", "'010' parses as 10 and '00' as 0") }, () => {
    assert.throws(() => parseJson5("010"), SyntaxError);
    assert.throws(() => parseJson5("[00]"), SyntaxError);
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - unquoted keys accept every character from U+00C0 up (including U+3000, U+2028, U+00D7), and a key ends only at a character below that range", () => {
    assert.deepStrictEqual(parseJson5("{a　: 1}"), { "a　": 1 });
    assert.deepStrictEqual(parseJson5("{×: 1}"), { "×": 1 });
    assert.deepStrictEqual(parseJson5("{a : 1}"), { "a ": 1 });
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - an escaped identifier is not checked to be an identifier character ('\\u0020' yields a key with a space)", () => {
    assert.deepStrictEqual(parseJson5("{a\\u0020b: 1}"), { "a b": 1 });
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - '\\u{...}' code point escapes (not JSON5) are refused", () => {
    assert.throws(() => parseJson5("'\\u{1F600}'"), /bad hex escape/);
  });
});
