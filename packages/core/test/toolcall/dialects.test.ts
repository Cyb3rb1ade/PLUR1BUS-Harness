// core/toolcall dialects and quirks: name/description/tool-count limits per model family, strict-mode conversion,
// Gemini keyword reductions, wire shapes, restoreStrictArguments (including a seeded round trip).
// Limits come from the QUIRKS table's documented per-family values (OpenAI/Anthropic/Gemini public function-name rules).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compileDialect, compileCatalogue, fromRegisteredTool, restoreStrictArguments } from "../../src/toolcall/dialects.ts";
import { lookupQuirks, QUIRKS, type ProviderFamily } from "../../src/toolcall/quirks.ts";
import { validateArguments, prepareCall, type Schema } from "../../src/toolcall/validation.ts";
import type { ToolDefinition } from "../../../providers/src/types.ts";
import { mulberry32, gap } from "./helpers.ts";

const closed = (properties: Record<string, unknown> = {}, required: string[] = []): Schema => ({ type: "object", additionalProperties: false, properties, ...(required.length ? { required } : {}) });
const tool = (over: Partial<ToolDefinition> = {}): ToolDefinition => ({ name: "lookup", description: "Look something up", parameters: closed({ q: { type: "string" } }, ["q"]) as never, ...over });
const FAMILIES: ProviderFamily[] = ["openai-chat", "openai-responses", "anthropic", "gemini"];

describe("quirks table", () => {
  it("documents the expected per-family limits", () => {
    const expected: Record<string, [number, number, number, boolean, boolean]> = {
      "openai-chat": [128, 64, 1024, true, true], "openai-responses": [128, 64, 1024, true, true], anthropic: [64, 64, 4096, false, true], gemini: [64, 64, 1024, false, true], "local-small": [8, 64, 1024, false, false],
    };
    for (const [name, [maxTools, maxName, maxDesc, strict, parallel]] of Object.entries(expected)) {
      const q = lookupQuirks(name);
      assert.deepEqual([q.maxTools, q.maxNameLength, q.maxDescriptionLength, q.strict, q.parallel], [maxTools, maxName, maxDesc, strict, parallel], name);
    }
  });

  it("unknown model families fall back to the conservative local-small profile with at most 4 tools", () => {
    for (const name of ["", "gpt-9000", "ANTHROPIC", "openai-chat ", "unknown", "α"]) {
      const q = lookupQuirks(name);
      assert.equal(q.maxTools, 4, name); assert.equal(q.parallel, false, name); assert.equal(q.strict, false, name); assert.equal(q.family, "openai-chat", name);
    }
  });

  it("the table and its entries are frozen: a caller cannot loosen a limit at runtime", () => {
    assert.ok(Object.isFrozen(QUIRKS)); for (const q of Object.values(QUIRKS)) { assert.ok(Object.isFrozen(q)); assert.ok(Object.isFrozen(q.malformedArguments)); }
    assert.throws(() => { (QUIRKS["anthropic"] as { maxTools: number }).maxTools = 9999; }, TypeError);
  });

  it(gap("lookupQuirks", "any name that is not a table key (including 'constructor', '__proto__', 'toString') gets the conservative fallback", "inherited Object.prototype members are returned as the quirks object, so name, description and tool-count limits are not enforced and prepareCall throws a TypeError"), { todo: gap("lookupQuirks", "any name that is not a table key (including 'constructor', '__proto__', 'toString') gets the conservative fallback", "inherited Object.prototype members are returned as the quirks object, so name, description and tool-count limits are not enforced and prepareCall throws a TypeError") }, async () => {
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      const q = lookupQuirks(name);
      assert.equal(q.maxTools, 4, `${name}: maxTools`);
      assert.throws(() => compileDialect(tool({ name: "bad name with spaces" }), "openai-chat", { modelFamily: name }), /invalid tool name/, `${name}: name limits`);
      assert.throws(() => compileCatalogue(Array.from({ length: 5 }, (_, i) => tool({ name: `t${i}` })), "openai-chat", name), /too many tools/, `${name}: tool count`);
      assert.equal((await prepareCall("t", { type: "object" }, "{}", undefined, name)).ok, true, `${name}: prepareCall`);
    }
  });
});

describe("compileDialect: names", () => {
  const boundary = (n: number, c = "a") => c.repeat(n);
  for (const family of FAMILIES) {
    it(`${family}: 64 characters are accepted, 65 are refused`, () => {
      assert.doesNotThrow(() => compileDialect(tool({ name: boundary(64) }), family));
      assert.throws(() => compileDialect(tool({ name: boundary(65) }), family), /invalid tool name/);
    });
  }

  const bad = ["", " ", "a b", "a.b", "a/b", "a:b", "a@b", "ä", "名前", "😀", "a\n", "a-\u0000", "<script>", "a;b", "a,b", "a'b", "a\"b"];
  for (const name of bad) {
    it(`refuses the name ${JSON.stringify(name)} for every family`, () => {
      for (const family of FAMILIES) assert.throws(() => compileDialect(tool({ name }), family), /invalid tool name/, family);
    });
  }

  it("accepts letters, digits, underscore and hyphen", () => {
    for (const family of FAMILIES) for (const name of ["a", "A", "tool_1", "tool-1", "_x"]) assert.doesNotThrow(() => compileDialect(tool({ name }), family), `${family} ${name}`);
  });

  it("a name that starts with a digit or hyphen is fine for OpenAI/Anthropic and refused for Gemini (must start with a letter or underscore)", () => {
    for (const name of ["1tool", "-tool"]) {
      for (const family of ["openai-chat", "openai-responses", "anthropic"] as const) assert.doesNotThrow(() => compileDialect(tool({ name }), family), `${family} ${name}`);
      assert.throws(() => compileDialect(tool({ name }), "gemini"), /invalid tool name/);
    }
  });

  it("the error names the family and the tool", () => {
    assert.throws(() => compileDialect(tool({ name: "no good" }), "gemini"), /invalid tool name for gemini: no good/);
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - registry names with a dot ('web.fetch') cannot be compiled for any family, there is no name mapping", () => {
    for (const family of FAMILIES) assert.throws(() => compileDialect(fromRegisteredTool({ name: "web.fetch", description: "d", inputSchema: closed(), capability: "net.read", effect: "external", risk: "medium", trust: "first-party" } as never), family), /invalid tool name/);
  });

  it("anchoring: a name with a newline or trailing junk cannot sneak past the pattern", () => {
    for (const name of ["ok\nbad", "ok\n", "\nok"]) assert.throws(() => compileDialect(tool({ name }), "openai-chat"), /invalid tool name/, JSON.stringify(name));
  });
});

describe("compileDialect: descriptions", () => {
  it("1024 characters pass and 1025 fail for OpenAI and Gemini; Anthropic allows 4096 and refuses 4097", () => {
    for (const family of ["openai-chat", "openai-responses", "gemini"] as const) {
      assert.doesNotThrow(() => compileDialect(tool({ description: "d".repeat(1024) }), family));
      assert.throws(() => compileDialect(tool({ description: "d".repeat(1025) }), family), /description exceeds 1024/);
    }
    assert.doesNotThrow(() => compileDialect(tool({ description: "d".repeat(4096) }), "anthropic"));
    assert.throws(() => compileDialect(tool({ description: "d".repeat(4097) }), "anthropic"), /description exceeds 4096/);
  });

  it("a missing description compiles to an empty string", () => {
    const { description: _drop, ...noDescription } = tool();
    for (const family of FAMILIES) {
      const wire = compileDialect(noDescription as ToolDefinition, family).wire as Record<string, any>;
      assert.equal((wire["function"] ?? wire)["description"], "");
    }
  });

  it("the limit is on the UTF-16 length of the string (an astral character counts as two)", () => {
    assert.doesNotThrow(() => compileDialect(tool({ description: "😀".repeat(512) }), "openai-chat"));
    assert.throws(() => compileDialect(tool({ description: "😀".repeat(513) }), "openai-chat"), /description exceeds/);
  });

  it("the model family, not the wire family, selects the limit", () => {
    assert.doesNotThrow(() => compileDialect(tool({ description: "d".repeat(2000) }), "anthropic", { modelFamily: "anthropic" }));
    assert.throws(() => compileDialect(tool({ description: "d".repeat(2000) }), "anthropic", { modelFamily: "local-small" }), /description exceeds 1024/);
  });
});

describe("compileDialect: wire shapes", () => {
  const p = closed({ q: { type: "string" } }, ["q"]);
  it("openai-chat: function envelope with strict flag", () => {
    assert.deepEqual(compileDialect(tool({ parameters: p as never }), "openai-chat", { strict: false }).wire, { type: "function", function: { name: "lookup", description: "Look something up", parameters: p, strict: false } });
  });
  it("openai-responses: flat function with strict flag", () => {
    assert.deepEqual(compileDialect(tool({ parameters: p as never }), "openai-responses", { strict: false }).wire, { type: "function", name: "lookup", description: "Look something up", parameters: p, strict: false });
  });
  it("anthropic: input_schema, no strict flag", () => {
    assert.deepEqual(compileDialect(tool({ parameters: p as never }), "anthropic").wire, { name: "lookup", description: "Look something up", input_schema: p });
  });
  it("gemini: parametersJsonSchema, no strict flag", () => {
    assert.deepEqual(compileDialect(tool({ parameters: p as never }), "gemini").wire, { name: "lookup", description: "Look something up", parametersJsonSchema: p });
  });
  it("a tool without parameters gets an empty closed object schema", () => {
    const { parameters: _p, ...bare } = tool();
    for (const family of FAMILIES) {
      const wire = compileDialect(bare as ToolDefinition, family, { strict: false }).wire as Record<string, any>;
      const schema = wire["function"]?.["parameters"] ?? wire["parameters"] ?? wire["input_schema"] ?? wire["parametersJsonSchema"];
      assert.deepEqual(schema, { type: "object", additionalProperties: false, properties: {} }, family);
    }
  });
  it("parameters must be an object schema: arrays, strings and schemas without type are refused", () => {
    for (const parameters of [{ type: "array" }, { type: "string" }, {}, { anyOf: [{ type: "object" }] }]) assert.throws(() => compileDialect(tool({ parameters: parameters as never }), "anthropic"), /must be an object schema/, JSON.stringify(parameters));
  });
  it("an unsupported keyword in the tool schema stops the compilation (no silent drop)", () => {
    assert.throws(() => compileDialect(tool({ parameters: { type: "object", properties: { a: { $ref: "#/x" } } } as never }), "anthropic"), /unsupported schema keyword/);
  });
  it("characterization: Ist-Verhalten, nicht spezifiziert - a family value outside the four known ones is emitted in the Gemini wire shape", () => {
    const wire = compileDialect(tool(), "cohere" as ProviderFamily).wire;
    assert.ok("parametersJsonSchema" in wire);
  });
  it("the compiled schema is a deep copy: mutating the wire never changes the tool's own schema", () => {
    const params = closed({ list: { type: "array", items: { type: "string" } } });
    const before = structuredClone(params);
    for (const family of FAMILIES) {
      const wire = compileDialect(tool({ parameters: params as never }), family, { strict: false }).wire as Record<string, any>;
      const schema = wire["function"]?.["parameters"] ?? wire["parameters"] ?? wire["input_schema"] ?? wire["parametersJsonSchema"];
      schema.properties.list.items.type = "number"; schema.extra = 1;
      assert.deepEqual(params, before, family);
    }
  });
});

describe("compileDialect: annotations and Gemini reductions", () => {
  const annotated = { type: "object", additionalProperties: false, $schema: "x", $id: "y", $comment: "c", title: "T", description: "D",
    properties: { n: { type: "number", default: 1, examples: [1], deprecated: true, readOnly: true, writeOnly: false, description: "num" } } } as const;

  it("annotations never reach the wire, are listed as reductions with a path, and descriptive keywords stay", () => {
    for (const family of FAMILIES) {
      const out = compileDialect(tool({ parameters: annotated as never }), family, { strict: false });
      const text = JSON.stringify(out.wire);
      for (const k of ["$schema", "$id", "$comment", "default", "examples", "deprecated", "readOnly", "writeOnly"]) assert.ok(!text.includes(`"${k}"`), `${family} ${k}`);
      assert.ok(text.includes("\"title\":\"T\"") && text.includes("\"description\":\"D\"") && text.includes("\"description\":\"num\""), family);
      const nested = out.reductions.filter(r => r.path === "/properties/n").map(r => r.keyword).sort();
      assert.deepEqual(nested, ["default", "deprecated", "examples", "readOnly", "writeOnly"], family);
      assert.deepEqual(out.reductions.filter(r => r.path === "").map(r => r.keyword).sort(), ["$comment", "$id", "$schema"], family);
    }
  });

  const geminiOnly: Schema = { type: "object", additionalProperties: false, minProperties: 1, maxProperties: 3,
    properties: { n: { type: "integer", exclusiveMinimum: 0, exclusiveMaximum: 10, multipleOf: 2 }, l: { type: "array", uniqueItems: true, items: { type: "string" } },
      u: { oneOf: [{ type: "string" }, { type: "number" }] }, a: { allOf: [{ type: "string" }, { minLength: 1 }] }, c: { const: "fixed" } } };

  it("Gemini: keywords it cannot express are removed, recorded, and restated in the property description", () => {
    const out = compileDialect(tool({ parameters: geminiOnly as never }), "gemini");
    const schema = (out.wire as { parametersJsonSchema: Record<string, any> }).parametersJsonSchema;
    assert.deepEqual(out.reductions.map(r => `${r.path}:${r.keyword}`).sort(), ["/properties/a:allOf", "/properties/l:uniqueItems", "/properties/n:exclusiveMaximum", "/properties/n:exclusiveMinimum", "/properties/n:multipleOf", "/properties/u:oneOf", ":maxProperties", ":minProperties"].sort());
    assert.equal(schema["minProperties"], undefined); assert.equal(schema["maxProperties"], undefined);
    assert.equal(schema["properties"]["n"]["multipleOf"], undefined);
    assert.match(schema["properties"]["n"]["description"], /^Internal validation constraints: exclusiveMinimum=0; exclusiveMaximum=10; multipleOf=2$/);
    assert.match(schema["properties"]["l"]["description"], /uniqueItems=true/);
    assert.match(schema["description"], /minProperties=1; maxProperties=3/);
    assert.deepEqual(schema["properties"]["c"], { enum: ["fixed"] }, "const becomes a one-element enum");
  });

  it("other families keep those keywords and do not rewrite const", () => {
    for (const family of ["openai-chat", "openai-responses", "anthropic"] as const) {
      const out = compileDialect(tool({ parameters: geminiOnly as never }), family, { strict: false });
      const text = JSON.stringify(out.wire);
      for (const k of ["minProperties", "uniqueItems", "multipleOf", "exclusiveMinimum", "oneOf", "allOf", "\"const\""]) assert.ok(text.includes(k), `${family} ${k}`);
      assert.deepEqual(out.reductions, [], family);
    }
  });

  it("an existing description is kept and the note is appended on a new line", () => {
    const out = compileDialect(tool({ parameters: closed({ n: { type: "number", multipleOf: 3, description: "Count" } }) as never }), "gemini");
    const d = (out.wire as any).parametersJsonSchema.properties.n.description as string;
    assert.equal(d, "Count\nInternal validation constraints: multipleOf=3");
  });

  it("the original keywords still validate arguments locally even where the wire dropped them", () => {
    assert.ok(validateArguments(geminiOnly, { n: 3 }).length > 0, "multipleOf 2 is enforced locally");
    assert.ok(validateArguments(geminiOnly, { l: ["a", "a"] }).some(i => i.expected === "unique items"));
  });
});

describe("compileDialect: strict mode", () => {
  it("is on by default for OpenAI families and off for the others", () => {
    const p = closed({ a: { type: "string" } }, ["a"]);
    assert.equal(((compileDialect(tool({ parameters: p as never }), "openai-chat").wire as any).function.strict), true);
    assert.equal(((compileDialect(tool({ parameters: p as never }), "openai-responses").wire as any).strict), true);
    assert.ok(!("strict" in compileDialect(tool({ parameters: p as never }), "anthropic").wire));
  });

  it("strict mode is refused for Gemini and Anthropic and for model families without strict support", () => {
    assert.throws(() => compileDialect(tool(), "gemini", { strict: true }), /strict mode unsupported by gemini/);
    assert.throws(() => compileDialect(tool(), "anthropic", { strict: true }), /strict mode unsupported by anthropic/);
    assert.throws(() => compileDialect(tool(), "openai-chat", { strict: true, modelFamily: "local-small" }), /strict mode unsupported/);
    assert.doesNotThrow(() => compileDialect(tool(), "openai-chat", { strict: false, modelFamily: "local-small" }));
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - an unknown modelFamily on an OpenAI wire silently turns strict OFF by default", () => {
    const wire = compileDialect(tool(), "openai-chat", { modelFamily: "some-new-model" }).wire as any;
    assert.equal(wire.function.strict, false);
  });

  it("objects must be closed, at any depth; the error names the location", () => {
    assert.throws(() => compileDialect(tool({ parameters: { type: "object", properties: {} } as never }), "openai-chat"), /strict objects must be closed at $/);
    assert.throws(() => compileDialect(tool({ parameters: { type: "object", additionalProperties: true, properties: {} } as never }), "openai-chat"), /closed/);
    assert.throws(() => compileDialect(tool({ parameters: closed({ inner: { type: "object", properties: {} } }) as never }), "openai-chat"), /closed at \/properties\/inner/);
    assert.throws(() => compileDialect(tool({ parameters: closed({ list: { type: "array", items: { type: "object", additionalProperties: { type: "string" } } } }) as never }), "openai-chat"), /closed at \/properties\/list\/items/);
  });

  it("every property becomes required; optional ones become nullable in the way their shape allows", () => {
    const p = closed({
      req: { type: "string" }, plain: { type: "integer" }, choice: { enum: ["a", "b"] }, fixed: { const: 1 }, either: { anyOf: [{ type: "string" }, { type: "number" }] },
      multi: { type: ["string", "number"] }, obj: closed({ x: { type: "string" } }), list: { type: "array", items: { type: "string" } },
    }, ["req"]);
    const wire = compileDialect(tool({ parameters: p as never }), "openai-chat").wire as any;
    const s = wire.function.parameters;
    assert.deepEqual(s.required, ["req", "plain", "choice", "fixed", "either", "multi", "obj", "list"]);
    assert.equal(s.additionalProperties, false);
    assert.deepEqual(s.properties.req, { type: "string" });
    assert.deepEqual(s.properties.plain, { type: ["integer", "null"] });
    assert.deepEqual(s.properties.choice, { anyOf: [{ enum: ["a", "b"] }, { type: "null" }] });
    assert.deepEqual(s.properties.fixed, { anyOf: [{ const: 1 }, { type: "null" }] });
    assert.deepEqual(s.properties.either, { anyOf: [{ anyOf: [{ type: "string" }, { type: "number" }] }, { type: "null" }] });
    assert.deepEqual(s.properties.multi, { anyOf: [{ type: ["string", "number"] }, { type: "null" }] });
    assert.deepEqual(s.properties.obj, { type: ["object", "null"], additionalProperties: false, properties: { x: { type: ["string", "null"] } }, required: ["x"] });
    assert.deepEqual(s.properties.list, { type: ["array", "null"], items: { type: "string" } });
  });

  it("nested objects are converted at every level", () => {
    const p = closed({ a: closed({ b: closed({ c: { type: "string" } }) }, ["b"]) }, ["a"]);
    const s = (compileDialect(tool({ parameters: p as never }), "openai-responses").wire as any).parameters;
    assert.deepEqual(s.properties.a.required, ["b"]); assert.deepEqual(s.properties.a.properties.b.required, ["c"]);
    assert.deepEqual(s.properties.a.properties.b.properties.c, { type: ["string", "null"] });
  });

  it("an empty parameter object stays valid in strict mode", () => {
    const s = (compileDialect(tool({ parameters: closed() as never }), "openai-chat").wire as any).function.parameters;
    assert.deepEqual(s, { type: "object", additionalProperties: false, properties: {}, required: [] });
  });

  it("the original schema object is not modified by the strict conversion", () => {
    const p = closed({ a: { type: "string" }, b: { enum: [1] } }, ["a"]);
    const before = structuredClone(p);
    compileDialect(tool({ parameters: p as never }), "openai-chat");
    assert.deepEqual(p, before);
  });
});

describe("compileCatalogue", () => {
  const many = (n: number, prefix = "t") => Array.from({ length: n }, (_, i) => tool({ name: `${prefix}${i}`, parameters: closed() as never }));

  it("the tool-count limit is per model family: exactly the maximum passes, one more fails", () => {
    const limits: [ProviderFamily, string, number][] = [["openai-chat", "openai-chat", 128], ["openai-responses", "openai-responses", 128], ["anthropic", "anthropic", 64], ["gemini", "gemini", 64], ["openai-chat", "local-small", 8], ["openai-chat", "unknown-model", 4]];
    for (const [family, model, max] of limits) {
      assert.equal(compileCatalogue(many(max), family, model).length, max, `${model} at ${max}`);
      assert.throws(() => compileCatalogue(many(max + 1), family, model), /too many tools for model family/, `${model} at ${max + 1}`);
    }
  });

  it("the model family defaults to the wire family", () => {
    assert.equal(compileCatalogue(many(64), "anthropic").length, 64);
    assert.throws(() => compileCatalogue(many(65), "gemini"), /too many tools/);
  });

  it("duplicate tool names are refused; names differing only by case are distinct", () => {
    assert.throws(() => compileCatalogue([tool({ name: "x", parameters: closed() as never }), tool({ name: "x", parameters: closed() as never })], "anthropic"), /duplicate tool names/);
    assert.equal(compileCatalogue([tool({ name: "x", parameters: closed() as never }), tool({ name: "X", parameters: closed() as never })], "anthropic").length, 2);
  });

  it("an empty catalogue compiles to an empty list; order is preserved; one bad tool fails the whole catalogue", () => {
    assert.deepEqual(compileCatalogue([], "gemini"), []);
    const out = compileCatalogue(many(3), "anthropic");
    assert.deepEqual(out.map(o => (o.wire as { name: string }).name), ["t0", "t1", "t2"]);
    assert.throws(() => compileCatalogue([...many(2), tool({ name: "bad name", parameters: closed() as never })], "anthropic"), /invalid tool name/);
  });

  it("fromRegisteredTool maps name, description and inputSchema to a ToolDefinition", () => {
    const def = fromRegisteredTool({ name: "reg_tool", description: "from registry", inputSchema: closed({ a: { type: "string" } }), capability: "sys.read", effect: "read", risk: "low", trust: "first-party" } as never);
    assert.deepEqual(def, { name: "reg_tool", description: "from registry", parameters: closed({ a: { type: "string" } }) });
  });
});

describe("restoreStrictArguments", () => {
  const schema: Schema = closed({
    req: { type: "string" }, opt: { type: "string" }, optNullable: { type: ["string", "null"] }, optAny: { anyOf: [{ type: "string" }, { type: "null" }] },
    optEnum: { enum: ["a", null] }, optConst: { const: null }, nullType: { type: "null" },
    obj: closed({ inner: { type: "integer" }, keep: { type: "null" } }, []), list: { type: "array", items: closed({ x: { type: "string" } }) },
  }, ["req"]);

  it("drops null sentinels of optional, non-nullable properties and keeps everything else", () => {
    assert.deepEqual(restoreStrictArguments(schema, { req: "r", opt: null, optNullable: null, optAny: null, optEnum: null, optConst: null, nullType: null }), { req: "r", optNullable: null, optAny: null, optEnum: null, optConst: null, nullType: null });
  });

  it("a required property that is null is preserved even though its schema is not nullable (validation reports it later)", () => {
    assert.deepEqual(restoreStrictArguments(schema, { req: null }), { req: null });
  });

  it("recurses into objects and arrays of objects", () => {
    assert.deepEqual(restoreStrictArguments(schema, { req: "r", obj: { inner: null, keep: null }, list: [{ x: null }, { x: "s" }] }), { req: "r", obj: { keep: null }, list: [{}, { x: "s" }] });
  });

  it("unknown properties and non-object values pass through untouched", () => {
    assert.deepEqual(restoreStrictArguments(schema, { req: "r", surprise: null }), { req: "r", surprise: null });
    for (const v of [null, 5, "s", true, undefined]) assert.equal(restoreStrictArguments(schema, v), v);
    assert.deepEqual(restoreStrictArguments(schema, [1, null]), [1, null], "arrays against an object schema are not touched");
    assert.deepEqual(restoreStrictArguments({ type: "array", items: closed({ a: { type: "string" } }) }, [{ a: null }, 3]), [{}, 3]);
  });

  it("does not mutate its input", () => {
    const input = { req: "r", opt: null, obj: { inner: null } }; const before = structuredClone(input);
    restoreStrictArguments(schema, input);
    assert.deepEqual(input, before);
  });

  it("a property named __proto__ stays an ordinary own property", () => {
    const value = JSON.parse("{\"req\":\"r\",\"__proto__\":null}");
    const out = restoreStrictArguments(schema, value) as Record<string, unknown>;
    assert.equal(Object.getPrototypeOf(out), Object.prototype);
    assert.equal(Object.hasOwn(out, "__proto__"), true);
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - for a property that is nullable in the original schema, a null sentinel cannot be told from an explicit null and is kept", () => {
    assert.deepEqual(restoreStrictArguments(closed({ h: { anyOf: [{ type: "string" }, { type: "null" }] } }), { h: null }), { h: null });
  });

  it("seeded round trip: strict wire form (nulls for absent optionals) restores to the original arguments and validates", async () => {
    const SEED = 0x57121c;
    const rnd = mulberry32(SEED);
    const original: Schema = closed({
      a: { type: "string" }, b: { type: "integer" }, c: { enum: ["x", "y"] }, d: { type: "array", items: { type: "string" } },
      e: closed({ f: { type: "string" }, g: { type: "boolean" } }, ["f"]), h: { anyOf: [{ type: "string" }, { type: "null" }] },
    }, ["a"]);
    const strictSchema = (compileDialect(tool({ parameters: original as never }), "openai-chat").wire as any).function.parameters as Schema;
    for (let i = 0; i < 400; i++) {
      const args: Record<string, unknown> = { a: `a${i}` };
      if (rnd() < .5) args["b"] = Math.floor(rnd() * 50);
      if (rnd() < .5) args["c"] = rnd() < .5 ? "x" : "y";
      if (rnd() < .5) args["d"] = rnd() < .5 ? [] : ["s"];
      if (rnd() < .5) { const e: Record<string, unknown> = { f: "f" }; if (rnd() < .5) e["g"] = rnd() < .5; args["e"] = e; }
      if (rnd() < .5) args["h"] = rnd() < .5 ? "text" : null;
      // what a strict-mode model sends: every property present, absent optionals as null
      const wire = (s: Schema, v: Record<string, unknown>): Record<string, unknown> => {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(s["properties"] as object)) {
          const sub = (s["properties"] as Record<string, Schema>)[key]!;
          out[key] = key in v ? v[key] : null;
          if (key === "e" && v["e"]) out[key] = wire(((s["properties"] as any)[key].anyOf?.[0] ?? sub) as Schema, v["e"] as Record<string, unknown>);
        }
        return out;
      };
      const sent = wire(strictSchema, args);
      assert.deepEqual(validateArguments(strictSchema, sent), [], `seed=0x${SEED.toString(16)} case=${i}: the strict wire arguments must satisfy the strict schema`);
      const restored = restoreStrictArguments(original, sent);
      // `h` is nullable in the original, so an absent `h` and an explicit null are indistinguishable once the model has sent null.
      assert.deepEqual(restored, "h" in args ? args : { ...args, h: null }, `seed=0x${SEED.toString(16)} case=${i}`);
      assert.deepEqual(validateArguments(original, restored), [], `seed=0x${SEED.toString(16)} case=${i}`);
    }
  });
});
