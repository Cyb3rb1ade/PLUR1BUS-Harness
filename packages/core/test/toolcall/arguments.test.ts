// core/toolcall arguments: assertSchema vocabulary, JSON decoding and the three documented repairs, size/depth/node bounds,
// Unicode, missing/extra arguments, non-string inputs. Expectations follow the comments in src/toolcall/validation.ts
// ("unknown constraints must never silently pass", "one model repair round", 256 KiB bound, bounded finite acyclic JSON).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertSchema, validateArguments, prepareCall, pointer, type Schema, type ValidationIssue } from "../../src/toolcall/validation.ts";
import { QUIRKS } from "../../src/toolcall/quirks.ts";

const FILE_SCHEMA: Schema = {
  type: "object", additionalProperties: false, required: ["path"],
  properties: {
    path: { type: "string", minLength: 1, maxLength: 50 },
    mode: { enum: ["r", "w"] },
    count: { type: "integer", minimum: 0, maximum: 10 },
    tags: { type: "array", maxItems: 3, items: { type: "string" } },
  },
};
const ok = (r: Awaited<ReturnType<typeof prepareCall>>) => { assert.ok(r.ok, JSON.stringify(r)); return r.arguments; };
const bad = (r: Awaited<ReturnType<typeof prepareCall>>): ValidationIssue[] => { assert.equal(r.ok, false, JSON.stringify(r)); return r.ok ? [] : r.error.issues ?? []; };

describe("assertSchema: vocabulary is closed", () => {
  const unsupported = ["$ref", "$defs", "definitions", "contains", "if", "then", "else", "not", "format", "patternProperties", "propertyNames", "dependencies", "dependentRequired", "dependentSchemas", "prefixItems", "additionalItems", "unevaluatedProperties", "unevaluatedItems", "contentEncoding", "contentMediaType", "nullable", "x-custom", "maxContains", "minContains", "$anchor", "$vocabulary"];
  for (const keyword of unsupported) {
    it(`rejects the unsupported keyword ${keyword} (at the root and nested)`, () => {
      assert.throws(() => assertSchema({ type: "object", [keyword]: {} }), /unsupported schema keyword/);
      assert.throws(() => assertSchema({ type: "object", properties: { a: { type: "string", [keyword]: 1 } } }), /unsupported schema keyword/);
      assert.throws(() => assertSchema({ type: "array", items: { [keyword]: true } }), /unsupported schema keyword/);
      assert.throws(() => assertSchema({ anyOf: [{ type: "string" }, { [keyword]: 1 }] }), /unsupported schema keyword/);
      assert.throws(() => assertSchema({ type: "object", additionalProperties: { [keyword]: 1 } }), /unsupported schema keyword/);
    });
  }

  it("accepts every supported keyword with a valid value", () => {
    assertSchema({
      $schema: "https://json-schema.org/draft/2020-12/schema", $id: "x", $comment: "c", title: "t", description: "d", default: 1, examples: [1], deprecated: false, readOnly: true, writeOnly: false,
      type: ["object", "null"], properties: { a: { type: "string", pattern: "^\\p{L}+$", minLength: 0, maxLength: 3 } }, required: ["a"], additionalProperties: { type: "number" },
      minProperties: 0, maxProperties: 4, enum: [{ a: "x" }], const: null, allOf: [{ type: "object" }], anyOf: [{}], oneOf: [{ type: "object" }],
    });
    assertSchema({ type: "array", items: { type: "integer", minimum: -1, maximum: 1, exclusiveMinimum: -2, exclusiveMaximum: 2, multipleOf: 1 }, minItems: 0, maxItems: 2, uniqueItems: true });
  });

  const invalidValues: [string, Schema][] = [
    ["properties: array", { properties: [] }], ["properties: null", { properties: null }], ["properties: string", { properties: "x" }], ["properties: member not a schema", { properties: { a: 5 } }],
    ["items: array (tuple form)", { items: [{ type: "string" }] }], ["items: number", { items: 5 }], ["items: null", { items: null }], ["items: boolean", { items: true }],
    ["additionalProperties: string", { additionalProperties: "no" }], ["additionalProperties: number", { additionalProperties: 0 }], ["additionalProperties: null", { additionalProperties: null }],
    ["anyOf: empty", { anyOf: [] }], ["oneOf: object", { oneOf: {} }], ["allOf: string", { allOf: "x" }], ["anyOf: non-schema member", { anyOf: [3] }],
    ["pattern: number", { pattern: 5 }], ["pattern: unbalanced", { pattern: "(" }], ["pattern: bad escape under u flag", { pattern: "\\d{2,1}" }], ["pattern: lone bracket", { pattern: "[" }],
    ["type: unknown name", { type: "str" }], ["type: empty list", { type: [] }], ["type: list with unknown", { type: ["string", "date"] }], ["type: number", { type: 5 }], ["type: null value", { type: null }],
    ["required: string", { required: "a" }], ["required: number member", { required: [1] }], ["required: null", { required: null }],
    ["enum: empty", { enum: [] }], ["enum: string", { enum: "a" }],
    ["minimum: string", { minimum: "1" }], ["maximum: NaN", { maximum: Number.NaN }], ["exclusiveMinimum: Infinity", { exclusiveMinimum: Number.POSITIVE_INFINITY }], ["multipleOf: null", { multipleOf: null }],
    ["minLength: string", { minLength: "1" }], ["maxLength: undefined", { maxLength: undefined }], ["minItems: object", { minItems: {} }], ["maxProperties: -Infinity", { maxProperties: Number.NEGATIVE_INFINITY }],
    ["uniqueItems: string", { uniqueItems: "true" }], ["uniqueItems: 1", { uniqueItems: 1 }], ["deprecated: 1", { deprecated: 1 }], ["readOnly: null", { readOnly: null }], ["writeOnly: 'no'", { writeOnly: "no" }],
  ];
  for (const [label, schema] of invalidValues) it(`rejects an invalid value: ${label}`, () => { assert.throws(() => assertSchema(schema)); });

  it("rejects non-object schemas", () => {
    for (const s of [null, undefined, [], "string", 5, true, () => 1]) assert.throws(() => assertSchema(s), /invalid or overly deep tool schema/);
  });

  it("depth limit: 32 nested levels pass, 33 fail (the schema is checked iteratively through properties, items, anyOf and additionalProperties)", () => {
    const chain = (n: number, wrap: (inner: Schema) => Schema): Schema => { let s: Schema = { type: "string" }; for (let i = 0; i < n; i++) s = wrap(s); return s; };
    const wraps: [string, (s: Schema) => Schema][] = [
      ["properties", s => ({ type: "object", properties: { a: s } })], ["items", s => ({ type: "array", items: s })],
      ["anyOf", s => ({ anyOf: [s] })], ["additionalProperties", s => ({ type: "object", additionalProperties: s })],
    ];
    for (const [label, wrap] of wraps) {
      assert.doesNotThrow(() => assertSchema(chain(32, wrap)), `${label} depth 32`);
      assert.throws(() => assertSchema(chain(33, wrap)), /overly deep/, `${label} depth 33`);
    }
  });

  it("values of enum/const/default/examples are not interpreted as schemas", () => {
    assertSchema({ enum: [{ $ref: "x", format: "y" }], const: { not: 1 }, default: { if: 1 }, examples: [{ then: 1 }] });
  });

  it("validateArguments and prepareCall refuse an unsupported schema instead of silently passing the arguments", async () => {
    assert.throws(() => validateArguments({ type: "object", format: "email" }, {}), /unsupported schema keyword/);
    await assert.rejects(prepareCall("t", { type: "object", properties: { a: { $ref: "#/x" } } }, "{}"), /unsupported schema keyword/);
    await assert.rejects(prepareCall("t", { type: "object", pattern: "(" }, "{}"), SyntaxError);
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - patterns are not screened for catastrophic backtracking at registration time", () => {
    assert.doesNotThrow(() => assertSchema({ type: "string", pattern: "^(a+)+$" }));
    // Short inputs only: this pins acceptance, it never runs the pattern on an attack string.
    assert.equal(validateArguments({ type: "string", pattern: "^(a+)+$" }, "aaa").length, 0);
    assert.equal(validateArguments({ type: "string", pattern: "^(a+)+$" }, "aab").length, 1);
  });
});

describe("prepareCall: broken JSON", () => {
  const broken: [string, string][] = [
    ["empty string", ""], ["whitespace", "   "], ["open brace", "{"], ["open key", "{\"path\":"], ["unclosed object", "{\"path\":\"a\""], ["single quotes", "{'path':'a'}"],
    ["unquoted key", "{path:\"a\"}"], ["literal undefined", "undefined"], ["NaN", "NaN"], ["Infinity", "{\"count\":Infinity}"], ["extra closing brace", "{\"path\":\"a\"}}"],
    ["trailing text", "{\"path\":\"a\"} and then some"], ["markdown fence", "```json\n{\"path\":\"a\"}\n```"], ["double comma", "{\"path\":\"a\",,}"], ["NUL byte", "\u0000"],
    ["comment", "{\"path\":\"a\"/* c */}"], ["hex number", "{\"count\":0x1}"], ["leading plus", "{\"count\":+1}"], ["leading zero", "{\"count\":01}"], ["raw newline in string", "{\"path\":\"a\nb\"}"],
    ["BOM prefix", "\uFEFF{\"path\":\"a\"}"], ["unterminated string", "{\"path\":\"a"], ["bad escape", "{\"path\":\"\\q\"}"], ["short unicode escape", "{\"path\":\"\\u12\"}"],
    ["two documents", "{\"path\":\"a\"}{\"path\":\"b\"}"], ["key without value", "{\"path\"}"], ["semicolon", "{\"path\":\"a\";}"],
  ];
  for (const [label, raw] of broken) {
    it(`${label}: structured error, no exception, no repair attempted without a repair port`, async () => {
      const r = await prepareCall("file.read", FILE_SCHEMA, raw);
      assert.equal(r.ok, false); assert.equal(r.repairRounds, 0);
      if (!r.ok) {
        assert.equal(r.error.code, "tool-call-invalid"); assert.equal(r.error.message, "Invalid arguments for file.read");
        assert.ok(r.error.hint && r.error.hint.length > 0);
        assert.equal(r.error.issues?.[0]?.message, "JSON parse failed"); assert.equal(r.error.issues?.[0]?.path, "");
      }
    });
  }

  it("parse errors never echo the offending text into the issue (it is attacker/model controlled)", async () => {
    const r = await prepareCall("t", FILE_SCHEMA, "{\"path\": redact-probe-alpha}");
    assert.ok(!JSON.stringify(r).includes("redact-probe-alpha"));
  });

  it("valid JSON of the wrong top-level type is a schema issue, not a parse issue", async () => {
    for (const [raw, got] of [["null", "null"], ["true", "true"], ["[]", "[]"], ["5", "5"], ["\"{}\"", "{}"]] as const) {
      const issues = bad(await prepareCall("t", { ...FILE_SCHEMA, required: [] }, raw, undefined, "anthropic"));
      assert.equal(issues[0]!.path, ""); assert.equal(issues[0]!.expected, "object"); assert.equal(issues[0]!.got, got === "{}" ? "\"{}\"" : got);
    }
  });

  it("a JSON string whose content is not JSON: a family with the unwrap repair reports a parse failure, one without it a type error", async () => {
    assert.equal(bad(await prepareCall("t", FILE_SCHEMA, "\"plain text\"", undefined, "openai-chat"))[0]!.message, "JSON parse failed");
    const issues = bad(await prepareCall("t", FILE_SCHEMA, "\"plain text\"", undefined, "anthropic"));
    assert.equal(issues[0]!.expected, "object"); assert.equal(issues[0]!.got, "\"plain text\"");
  });

  it("whitespace and key order do not matter for a valid document", async () => {
    const a = ok(await prepareCall("t", FILE_SCHEMA, "{\"path\":\"a\",\"count\":2}"));
    const b = ok(await prepareCall("t", FILE_SCHEMA, "\n\t {\n \"count\" : 2 ,\r\n \"path\" : \"a\" } \n"));
    assert.deepEqual(a, b);
  });
});

describe("prepareCall: documented repairs (unwrap-json-string, trailing-comma, numeric-string)", () => {
  it("trailing commas before } and ] are removed and logged", async () => {
    const r = await prepareCall("t", FILE_SCHEMA, "{\"path\":\"a\",\"tags\":[\"x\",\"y\",],}");
    assert.deepEqual(ok(r), { path: "a", tags: ["x", "y"] });
    assert.deepEqual(r.repairs, [{ kind: "trailing-comma", path: "" }]); assert.equal(r.repairRounds, 0);
  });

  it("whitespace between the comma and the closing bracket is tolerated", async () => {
    assert.deepEqual(ok(await prepareCall("t", FILE_SCHEMA, "{\"path\":\"a\" ,\n\t }")), { path: "a" });
  });

  it("commas inside strings are never touched, including escaped quotes before them", async () => {
    for (const raw of ["{\"path\":\"a,}\"}", "{\"path\":\"a,]\"}", "{\"path\":\"q\\\",}\"}", "{\"path\":\"x\\\\\",\"tags\":[\"a,]\"]}"]) {
      const r = await prepareCall("t", FILE_SCHEMA, raw);
      assert.equal(r.ok, true, raw); assert.deepEqual(r.repairs, [], raw);
      assert.deepEqual(ok(r), JSON.parse(raw));
    }
  });

  it("a trailing comma after a comma-containing string is repaired without damaging the string", async () => {
    assert.deepEqual(ok(await prepareCall("t", FILE_SCHEMA, "{\"path\":\"a,}\",}")), { path: "a,}" });
  });

  it("a JSON-encoded JSON document (one level of string wrapping) is unwrapped and logged", async () => {
    const wrapped = JSON.stringify(JSON.stringify({ path: "a", count: 3 }));
    const r = await prepareCall("t", FILE_SCHEMA, wrapped);
    assert.deepEqual(ok(r), { path: "a", count: 3 }); assert.deepEqual(r.repairs, [{ kind: "unwrap-json-string", path: "" }]);
  });

  it("wrapping twice is beyond the repair repertoire: it stays invalid and reports the type error", async () => {
    const twice = JSON.stringify(JSON.stringify(JSON.stringify({ path: "a" })));
    const issues = bad(await prepareCall("t", FILE_SCHEMA, twice));
    assert.equal(issues[0]!.expected, "object");
  });

  it("a root string schema is not unwrapped (the string IS the argument)", async () => {
    const schema: Schema = { type: "string" };
    assert.equal(ok(await prepareCall("t", schema, JSON.stringify("{\"a\":1}"))), "{\"a\":1}");
  });

  it("numeric strings become numbers where the schema says integer/number, with the pointer of the fixed field", async () => {
    const r = await prepareCall("t", { type: "object", properties: { n: { type: "number" }, i: { type: "integer" }, list: { type: "array", items: { type: "integer" } } } }, "{\"n\":\"2.5\",\"i\":\"-7\",\"list\":[\"1\",2,\"3e2\"]}");
    assert.deepEqual(ok(r), { n: 2.5, i: -7, list: [1, 2, 300] });
    assert.deepEqual(r.repairs.map(x => x.path).sort(), ["/i", "/list/0", "/list/2", "/n"]);
    assert.ok(r.repairs.every(x => x.kind === "numeric-string"));
  });

  const notNumeric = ["", " 3", "3 ", "0x10", "007", "1_000", "٣", "３", "+3", ".5", "5.", "NaN", "Infinity", "1e", "--1", "3,5", "1e999"];
  for (const text of notNumeric) {
    it(`the string ${JSON.stringify(text)} is not coerced to a number`, async () => {
      const issues = bad(await prepareCall("t", { type: "object", properties: { n: { type: "number" } } }, JSON.stringify({ n: text })));
      assert.equal(issues[0]!.path, "/n"); assert.equal(issues[0]!.expected, "number");
    });
  }

  it("a numeric string that is not an integer stays a string for an integer schema", async () => {
    const issues = bad(await prepareCall("t", { type: "object", properties: { i: { type: "integer" } } }, "{\"i\":\"3.5\"}"));
    assert.equal(issues[0]!.path, "/i");
  });

  it("an unsafe integer string (2^53) is not coerced for an integer schema", async () => {
    bad(await prepareCall("t", { type: "object", properties: { i: { type: "integer" } } }, "{\"i\":\"9007199254740993\"}"));
  });

  it("numeric strings are not coerced where the schema wants a string, or where no schema describes the property", async () => {
    const r = await prepareCall("t", { type: "object", properties: { s: { type: "string" } } }, "{\"s\":\"12\",\"other\":\"34\"}");
    assert.deepEqual(ok(r), { s: "12", other: "34" }); assert.deepEqual(r.repairs, []);
  });

  const families: [string, string[]][] = [
    ["openai-chat", ["unwrap-json-string", "trailing-comma", "numeric-string"]], ["local-small", ["unwrap-json-string", "trailing-comma", "numeric-string"]], ["unknown", ["unwrap-json-string", "trailing-comma", "numeric-string"]],
    ["openai-responses", ["numeric-string"]], ["anthropic", ["numeric-string"]], ["gemini", ["numeric-string"]],
  ];
  for (const [family, allowed] of families) {
    it(`model family ${family}: only ${allowed.join("/")} are repaired`, async () => {
      const cases: [string, string, string][] = [
        ["trailing-comma", "{\"path\":\"a\",}", ""], ["unwrap-json-string", JSON.stringify(JSON.stringify({ path: "a" })), ""], ["numeric-string", "{\"path\":\"a\",\"count\":\"4\"}", ""],
      ];
      for (const [kind, raw] of cases) {
        const r = await prepareCall("t", FILE_SCHEMA, raw, undefined, family);
        assert.equal(r.ok, allowed.includes(kind), `${family} ${kind}`);
        if (r.ok) assert.ok(r.repairs.some(x => x.kind === kind));
        for (const rep of r.repairs) assert.ok(allowed.includes(rep.kind), `${family} logged ${rep.kind}`);
      }
    });
  }

  it("the repairs a family may apply are exactly its quirks.malformedArguments (no drift between table and behaviour)", () => {
    assert.deepEqual([...QUIRKS["openai-chat"]!.malformedArguments].sort(), ["numeric-string", "trailing-comma", "unwrap-json-string"]);
    assert.deepEqual([...QUIRKS["anthropic"]!.malformedArguments], ["numeric-string"]);
  });
});

describe("prepareCall: the single model repair round", () => {
  const request = (): { calls: { tool: string; args: unknown; issues: ValidationIssue[]; message: string }[] } => ({ calls: [] });

  it("is not called when the first attempt is valid, and the result says repairRounds 0", async () => {
    const seen = request();
    const r = await prepareCall("t", FILE_SCHEMA, "{\"path\":\"a\"}", async (req) => { seen.calls.push(req); return {}; });
    assert.equal(r.ok, true); assert.equal(r.repairRounds, 0); assert.equal(seen.calls.length, 0);
  });

  it("is called once with tool, current value, issues and a message naming the tool and family; a good answer is accepted", async () => {
    const seen = request();
    const r = await prepareCall("file.read", FILE_SCHEMA, "{\"count\":99}", async (req) => { seen.calls.push(req); return { path: "fixed", count: 2 }; }, "anthropic");
    assert.deepEqual(ok(r), { path: "fixed", count: 2 }); assert.equal(r.repairRounds, 1);
    assert.equal(seen.calls.length, 1);
    const req = seen.calls[0]!;
    assert.equal(req.tool, "file.read"); assert.deepEqual(req.args, { count: 99 });
    assert.deepEqual(req.issues.map(i => i.path).sort(), ["/count", "/path"]);
    assert.match(req.message, /^Correct arguments for file\.read\. Return JSON only\./);
    assert.match(req.message, /anthropic/); assert.match(req.message, /\/count: expected <= 10; got 99/); assert.match(req.message, /\/path: expected required value; got missing/);
  });

  it("a second failure is final: the issues come from the repaired attempt, the port is not asked again", async () => {
    let n = 0;
    const r = await prepareCall("t", FILE_SCHEMA, "{}", async () => { n++; return { path: "" }; });
    assert.equal(n, 1); assert.equal(r.repairRounds, 1);
    const issues = bad(r);
    assert.equal(issues[0]!.path, "/path"); assert.match(issues[0]!.expected, /at least 1 characters/);
  });

  it("a repair port that throws or rejects leaves the original issues and still counts as a round", async () => {
    for (const fail of [() => { throw new Error("redact-probe-alpha"); }, async () => { throw new Error("redact-probe-alpha"); }, () => Promise.reject("x")]) {
      const r = await prepareCall("t", FILE_SCHEMA, "{}", fail as never);
      assert.equal(r.repairRounds, 1);
      const issues = bad(r);
      assert.equal(issues[0]!.path, "/path");
      assert.ok(!JSON.stringify(r).includes("redact-probe-alpha"));
    }
  });

  it("the repair answer goes through the same decoder: a JSON string answer is parsed, an oversize or malformed answer is refused", async () => {
    assert.deepEqual(ok(await prepareCall("t", FILE_SCHEMA, "{}", async () => "{\"path\":\"from-text\"}")), { path: "from-text" });
    const malformed = await prepareCall("t", FILE_SCHEMA, "{}", async () => "{nope");
    assert.equal(bad(malformed)[0]!.message, "JSON parse failed");
    const oversize = await prepareCall("t", FILE_SCHEMA, "{}", async () => `{"path":"${"a".repeat(256 * 1024)}"}`);
    assert.equal(bad(oversize)[0]!.message, "arguments too large");
  });

  it("a repair answer that is not JSON-safe (cyclic, class instance, undefined) cannot smuggle values past validation", async () => {
    const cyc: Record<string, unknown> = { path: "a" }; cyc["self"] = cyc;
    for (const answer of [cyc, new Date(0), undefined, { path: "a", n: 1n }, new Map()]) {
      const r = await prepareCall("t", FILE_SCHEMA, "{}", async () => answer);
      assert.equal(bad(r)[0]!.message, "invalid JSON arguments");
    }
  });

  it("repairs already applied (e.g. trailing comma) are reported together with the model round", async () => {
    const r = await prepareCall("t", FILE_SCHEMA, "{\"count\":1,}", async () => "{\"path\":\"p\",}");
    assert.deepEqual(ok(r), { path: "p" }); assert.equal(r.repairRounds, 1);
    assert.deepEqual(r.repairs.map(x => x.kind), ["trailing-comma", "trailing-comma"]);
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - an oversize raw string still triggers the model repair round, which receives args=undefined", async () => {
    const seen = request();
    const r = await prepareCall("t", FILE_SCHEMA, "x".repeat(256 * 1024 + 1), async (req) => { seen.calls.push(req); return { path: "ok" }; });
    assert.equal(seen.calls.length, 1); assert.equal(seen.calls[0]!.args, undefined);
    assert.deepEqual(ok(r), { path: "ok" });
  });
});

describe("prepareCall: size, depth and node bounds", () => {
  const docWithBytes = (bytes: number): string => { const head = "{\"path\":\""; const tail = "\"}"; return head + "a".repeat(bytes - head.length - tail.length) + tail; };
  const loose: Schema = { type: "object", properties: { path: { type: "string" } } };

  it("exactly 256 KiB of arguments is accepted; one byte more is 'arguments too large'", async () => {
    const limit = 256 * 1024;
    const at = await prepareCall("t", loose, docWithBytes(limit));
    assert.equal(at.ok, true);
    const over = bad(await prepareCall("t", loose, docWithBytes(limit + 1)));
    assert.deepEqual(over[0], { path: "", expected: "arguments <= 256 KiB", got: "oversized", message: "arguments too large" });
  });

  it("the limit is measured in bytes: 2-byte characters hit it with half the characters", async () => {
    const chars = 128 * 1024; // 131072 two-byte chars = 262144 bytes, plus quoting -> over
    const raw = JSON.stringify({ path: "é".repeat(chars) });
    assert.ok(raw.length < 256 * 1024 && Buffer.byteLength(raw) > 256 * 1024);
    assert.equal(bad(await prepareCall("t", loose, raw))[0]!.message, "arguments too large");
    const justUnder = JSON.stringify({ path: "é".repeat(chars - 20) });
    assert.equal((await prepareCall("t", loose, justUnder)).ok, true);
  });

  it("an object (not a string) is not subject to the byte limit, only to the node bound", async () => {
    const r = await prepareCall("t", loose, { path: "a".repeat(400_000) });
    assert.equal(r.ok, true);
  });

  it("a very long but allowed string that violates maxLength reports a clipped value, never the whole string", async () => {
    const raw = JSON.stringify({ path: "z".repeat(200_000) });
    const issues = bad(await prepareCall("t", FILE_SCHEMA, raw));
    assert.equal(issues.length, 1); assert.equal(issues[0]!.path, "/path");
    assert.ok(issues[0]!.got.length <= 80); assert.match(issues[0]!.expected, /at most 50 characters/);
    assert.ok(JSON.stringify(issues).length < 500);
  });

  it("nesting: 65 levels are accepted, 66 are 'invalid JSON arguments' (depth bound 64), also for 10 000 and 100 000 levels", async () => {
    const nest = (n: number) => "[".repeat(n) + "]".repeat(n);
    assert.equal((await prepareCall("t", {}, nest(65))).ok, true);
    for (const n of [66, 1000, 10_000, 100_000]) {
      const issues = bad(await prepareCall("t", {}, nest(n)));
      assert.equal(issues[0]!.message, "invalid JSON arguments", `depth ${n}`);
    }
    const objNest = (n: number) => "{\"a\":".repeat(n) + "1" + "}".repeat(n);
    assert.equal((await prepareCall("t", {}, objNest(64))).ok, true);
    assert.equal(bad(await prepareCall("t", {}, objNest(65)))[0]!.message, "invalid JSON arguments");
  });

  it("node bound: 20 000 nodes (root included) pass, 20 001 are refused", async () => {
    const arr = (n: number) => `[${Array.from({ length: n - 1 }, () => "0").join(",")}]`;
    assert.equal((await prepareCall("t", {}, arr(20_000))).ok, true);
    assert.equal(bad(await prepareCall("t", {}, arr(20_001)))[0]!.message, "invalid JSON arguments");
  });

  it("the node bound also applies to already-parsed objects", async () => {
    assert.equal(bad(await prepareCall("t", {}, Array.from({ length: 20_001 }, () => 0)))[0]!.message, "invalid JSON arguments");
  });

  it("deep validation depth is bounded as well when the schema recurses (no stack overflow)", () => {
    let schema: Schema = { type: "string" }; for (let i = 0; i < 30; i++) schema = { type: "array", items: schema };
    let value: unknown = "x"; for (let i = 0; i < 30; i++) value = [value];
    assert.deepEqual(validateArguments(schema, value), []);
    assert.equal(validateArguments(schema, [[1]]).length, 1);
  });
});

describe("prepareCall: Unicode and encoding", () => {
  const strSchema: Schema = { type: "object", properties: { s: { type: "string", minLength: 1, maxLength: 3 } }, additionalProperties: false };

  it("string length counts code points, not UTF-16 units: three emoji pass maxLength 3, four fail", async () => {
    assert.equal((await prepareCall("t", strSchema, JSON.stringify({ s: "😀😀😀" }))).ok, true);
    assert.equal((await prepareCall("t", strSchema, JSON.stringify({ s: "😀😀😀😀" }))).ok, false);
  });

  it("combining marks count as separate characters (no normalisation or grapheme counting)", async () => {
    assert.equal((await prepareCall("t", strSchema, JSON.stringify({ s: "e\u0301e\u0301" }))).ok, false, "4 code points");
    assert.equal((await prepareCall("t", strSchema, JSON.stringify({ s: "e\u0301" }))).ok, true);
    // ZWJ family emoji: 7 code points
    assert.equal((await prepareCall("t", strSchema, JSON.stringify({ s: "👨‍👩‍👧" }))).ok, false);
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - lone surrogates written as JSON escapes are accepted and count as one character each", async () => {
    const r = await prepareCall("t", strSchema, "{\"s\":\"\\ud800\\udc00\\ud800\"}");
    assert.equal(r.ok, true);
    assert.equal((r.ok ? (r.arguments as { s: string }).s : "").length, 3);
  });

  it("escaped and literal Unicode spellings of the same text are the same value", async () => {
    const a = ok(await prepareCall("t", strSchema, "{\"s\":\"é€\"}"));
    const b = ok(await prepareCall("t", strSchema, "{\"s\":\"\\u00e9\\u20ac\"}"));
    assert.deepEqual(a, b);
  });

  it("an escaped NUL and bidi controls are plain characters to the validator", async () => {
    assert.equal((await prepareCall("t", { type: "object", properties: { s: { type: "string" } } }, "{\"s\":\"a\\u0000b\\u202eevil\"}")).ok, true);
  });

  it("look-alike property names (Cyrillic 'а') are different properties: unknown property plus the missing real one", async () => {
    const issues = bad(await prepareCall("t", FILE_SCHEMA, JSON.stringify({ "p\u0430th": "x" })));
    assert.deepEqual(issues.map(i => [i.path, i.message]), [["/path", "required property missing"], ["/p\u0430th", "unknown property"]]);
  });

  it("pointers escape '~' and '/' in property names (RFC 6901) so the path stays unambiguous", async () => {
    assert.equal(pointer("", "a/b"), "/a~1b"); assert.equal(pointer("/x", "~"), "/x/~0"); assert.equal(pointer("", "~1"), "/~01");
    const issues = bad(await prepareCall("t", { type: "object", additionalProperties: false, properties: {} }, JSON.stringify({ "a/b~c": 1 })));
    assert.equal(issues[0]!.path, "/a~1b~0c");
  });

  it("pattern matching uses the unicode flag: \\p{L} matches astral letters, '.' matches one astral code point", async () => {
    const s: Schema = { type: "object", properties: { s: { type: "string", pattern: "^\\p{L}+$" }, d: { type: "string", pattern: "^.$" } } };
    assert.equal((await prepareCall("t", s, JSON.stringify({ s: "añ𝒜" }))).ok, true);
    assert.equal((await prepareCall("t", s, JSON.stringify({ d: "😀" }))).ok, true);
    assert.equal((await prepareCall("t", s, JSON.stringify({ s: "a1" }))).ok, false);
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - a BOM-prefixed document is rejected as a parse failure rather than skipped", async () => {
    assert.equal(bad(await prepareCall("t", FILE_SCHEMA, "\uFEFF{\"path\":\"a\"}"))[0]!.message, "JSON parse failed");
  });

  it("a duplicate key in the JSON text keeps the last value (JSON.parse semantics)", async () => {
    assert.deepEqual(ok(await prepareCall("t", FILE_SCHEMA, "{\"path\":\"first\",\"path\":\"second\"}")), { path: "second" });
  });
});

describe("prepareCall: missing, extra and wrongly typed arguments", () => {
  it("reports every problem, not just the first, with a pointer, the expectation and a clipped value", async () => {
    const issues = bad(await prepareCall("t", FILE_SCHEMA, JSON.stringify({ mode: "x", count: "many", tags: ["a", 2, "c", "d"], zzz: { deep: 1 } })));
    const byPath = new Map(issues.map(i => [i.path, i]));
    assert.equal(byPath.get("/path")?.message, "required property missing");
    assert.match(byPath.get("/mode")!.expected, /^one of \["r","w"\]$/);
    assert.equal(byPath.get("/count")!.expected, "integer"); assert.equal(byPath.get("/count")!.got, "\"many\"");
    assert.equal(byPath.get("/tags/1")!.expected, "string"); assert.equal(byPath.get("/tags/1")!.got, "2");
    assert.match(byPath.get("/tags")!.expected, /at most 3 items/);
    assert.deepEqual(byPath.get("/zzz"), { path: "/zzz", expected: "no additional property", got: "object", message: "unknown property" });
    for (const i of issues) assert.ok(i.got.length <= 80);
  });

  it("a required property that is present but null is a type problem, not a 'missing' one", async () => {
    const issues = bad(await prepareCall("t", FILE_SCHEMA, "{\"path\":null}"));
    assert.deepEqual(issues.map(i => [i.path, i.expected, i.got]), [["/path", "string", "null"]]);
  });

  it("the empty object against a schema with required fields lists each missing field in schema order", async () => {
    const s: Schema = { type: "object", required: ["b", "a", "c"], properties: { a: { type: "string" }, b: { type: "string" }, c: { type: "string" } } };
    assert.deepEqual(bad(await prepareCall("t", s, "{}")).map(i => i.path), ["/b", "/a", "/c"]);
  });

  it("extra properties are fine when additionalProperties is absent or true, validated when it is a schema, refused when false", () => {
    assert.deepEqual(validateArguments({ type: "object", properties: { a: { type: "string" } } }, { a: "x", extra: [1] }), []);
    assert.deepEqual(validateArguments({ type: "object", additionalProperties: true }, { extra: 1 }), []);
    assert.equal(validateArguments({ type: "object", additionalProperties: { type: "string" } }, { x: "ok", y: 2 }).length, 1);
    assert.equal(validateArguments({ type: "object", additionalProperties: false }, { x: 1 }).length, 1);
  });

  it("a type mismatch stops further checks on that value (no cascade of misleading issues)", () => {
    const issues = validateArguments({ type: "object", required: ["a"], properties: { a: { type: "string" } } }, [1, 2]);
    assert.equal(issues.length, 1); assert.equal(issues[0]!.expected, "object");
  });

  it("integer and number type boundaries", () => {
    const i = (v: unknown) => validateArguments({ type: "integer" }, v).length;
    assert.equal(i(1), 0); assert.equal(i(1.0), 0); assert.equal(i(1.5), 1); assert.equal(i(2 ** 53), 1); assert.equal(i(-(2 ** 53 - 1)), 0); assert.equal(i("1"), 1); assert.equal(i(true), 1);
    assert.equal(validateArguments({ type: "number" }, 1e308).length, 0);
    assert.equal(validateArguments({ type: "number" }, null).length, 1);
  });

  it("numeric constraints: inclusive and exclusive bounds, multipleOf with floating point tolerance", () => {
    const n = (s: Schema, v: number) => validateArguments({ type: "number", ...s }, v).length;
    assert.equal(n({ minimum: 1 }, 1), 0); assert.equal(n({ minimum: 1 }, 0.999), 1);
    assert.equal(n({ maximum: 1 }, 1), 0); assert.equal(n({ maximum: 1 }, 1.001), 1);
    assert.equal(n({ exclusiveMinimum: 1 }, 1), 1); assert.equal(n({ exclusiveMinimum: 1 }, 1.001), 0);
    assert.equal(n({ exclusiveMaximum: 1 }, 1), 1); assert.equal(n({ exclusiveMaximum: 1 }, 0.999), 0);
    assert.equal(n({ multipleOf: 0.1 }, 0.3), 0); assert.equal(n({ multipleOf: 0.1 }, 0.35), 1); assert.equal(n({ multipleOf: 5 }, -15), 0);
  });

  it("enum and const compare deeply and strictly (1 is not '1', key order is irrelevant, -0 is not 0 under strict deep equality)", () => {
    assert.equal(validateArguments({ enum: [1, "a", null, { x: [1, 2] }] }, { x: [1, 2] }).length, 0);
    assert.equal(validateArguments({ enum: [1] }, "1").length, 1);
    assert.equal(validateArguments({ const: { a: 1, b: 2 } }, { b: 2, a: 1 }).length, 0);
    assert.equal(validateArguments({ const: false }, 0).length, 1);
  });

  it("combinators: anyOf needs one match, oneOf exactly one, allOf all", () => {
    const num: Schema = { type: "number" }, int: Schema = { type: "integer" }, str: Schema = { type: "string" };
    assert.equal(validateArguments({ anyOf: [num, str] }, "x").length, 0);
    assert.equal(validateArguments({ anyOf: [num, str] }, null).length, 1);
    assert.equal(validateArguments({ oneOf: [num, int] }, 2).length, 1, "2 matches both");
    assert.equal(validateArguments({ oneOf: [num, int] }, 2.5).length, 0);
    assert.equal(validateArguments({ allOf: [num, { minimum: 3 }] }, 2).length, 1);
    assert.equal(validateArguments({ allOf: [num, { minimum: 3 }] }, 4).length, 0);
  });

  it("array constraints: minItems, maxItems, uniqueItems (deep)", () => {
    const s: Schema = { type: "array", minItems: 1, maxItems: 2, uniqueItems: true };
    assert.equal(validateArguments(s, []).length, 1); assert.equal(validateArguments(s, [1, 2, 3]).length, 1);
    assert.equal(validateArguments(s, [{ a: 1 }, { a: 1 }]).length, 1); assert.equal(validateArguments(s, [[1], [2]]).length, 0);
  });

  it("minProperties/maxProperties", () => {
    const s: Schema = { type: "object", minProperties: 1, maxProperties: 2 };
    assert.equal(validateArguments(s, {}).length, 1); assert.equal(validateArguments(s, { a: 1, b: 2, c: 3 }).length, 1); assert.equal(validateArguments(s, { a: 1 }).length, 0);
  });

  it("the property named __proto__ is data, not a prototype assignment", async () => {
    const s = JSON.parse("{\"type\":\"object\",\"additionalProperties\":false,\"properties\":{\"a\":{\"type\":\"string\"}}}") as Schema;
    const issues = bad(await prepareCall("t", s, "{\"__proto__\":{\"polluted\":true},\"a\":\"x\"}"));
    assert.deepEqual(issues.map(i => [i.path, i.message]), [["/__proto__", "unknown property"]]);
    assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
  });
});

describe("prepareCall: non-string raw input", () => {
  it("an already-parsed object is validated directly and returned (no repair log)", async () => {
    const r = await prepareCall("t", FILE_SCHEMA, { path: "a", count: 2 });
    assert.deepEqual(ok(r), { path: "a", count: 2 }); assert.deepEqual(r.repairs, []);
  });

  it("an object with a null prototype is accepted as plain data", async () => {
    const o = Object.create(null) as Record<string, unknown>; o["path"] = "a";
    assert.equal((await prepareCall("t", FILE_SCHEMA, o)).ok, true);
  });

  it("numeric strings inside an already-parsed object are still coerced (same normaliser)", async () => {
    assert.deepEqual(ok(await prepareCall("t", FILE_SCHEMA, { path: "a", count: "5" })), { path: "a", count: 5 });
  });

  const hostile: [string, () => unknown][] = [
    ["undefined", () => undefined], ["function", () => () => 1], ["symbol", () => Symbol("s")], ["bigint", () => 5n], ["NaN", () => Number.NaN], ["Infinity", () => Number.POSITIVE_INFINITY],
    ["Date", () => new Date(0)], ["Map", () => new Map()], ["Set", () => new Set()], ["RegExp", () => /x/], ["Error", () => new Error("redact-probe-alpha")], ["Uint8Array", () => new Uint8Array(2)],
    ["class instance", () => new (class Evil { path = "a"; })()], ["cyclic object", () => { const o: Record<string, unknown> = { path: "a" }; o["me"] = o; return o; }],
    ["cyclic array", () => { const a: unknown[] = []; a.push(a); return a; }], ["nested bigint", () => ({ path: "a", n: 1n })], ["nested undefined", () => ({ path: "a", n: undefined })],
    ["nested Date", () => ({ path: "a", when: new Date(0) })], ["Promise", () => Promise.resolve(1)],
  ];
  for (const [label, make] of hostile) {
    it(`${label} gives a structured 'invalid JSON arguments' issue and never throws`, async () => {
      const r = await prepareCall("t", { type: "object" }, make());
      const issues = bad(r);
      assert.equal(issues[0]!.message, "invalid JSON arguments"); assert.equal(issues[0]!.path, "");
      assert.ok(!JSON.stringify(r).includes("redact-probe-alpha"));
    });
  }

  it("null, numbers, booleans and arrays are valid JSON values and fail on type, not on safety", async () => {
    for (const v of [null, 5, true, [1]]) assert.equal(bad(await prepareCall("t", FILE_SCHEMA, v))[0]!.expected, "object");
  });

  it("an invalid schema is a programmer error and throws even before the arguments are looked at", async () => {
    await assert.rejects(prepareCall("t", { type: "nonsense" }, "garbage"), /invalid type/);
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - an object whose property getter throws propagates that exception (not a structured issue); real tool-call arguments are parsed JSON and cannot carry getters", async () => {
    const o = { path: "a" }; Object.defineProperty(o, "boom", { enumerable: true, get() { throw new Error("getter boom"); } });
    await assert.rejects(prepareCall("t", { type: "object" }, o), /getter boom/);
  });
});
