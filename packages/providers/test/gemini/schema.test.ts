import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderError } from "../../src/index.ts";
import type { JsonObject } from "../../src/index.ts";
import { MAX_SCHEMA_DEPTH, MAX_SCHEMA_NODES, convertToolSchema } from "../../src/gemini/schema.ts";

const WHERE = "tools[0] \"search\"";
const conv = (s: JsonObject): JsonObject => convertToolSchema(s, WHERE);
const refuse = (s: JsonObject, msg: string | RegExp): void =>
  assert.throws(() => conv(s), (e: unknown) => {
    if (!(e instanceof ProviderError) || e.kind !== "invalid_request") return false;
    return typeof msg === "string" ? e.message === `${WHERE}: ${msg}` : msg.test(e.message);
  });
const obj = (properties: JsonObject, extra: JsonObject = {}): JsonObject => ({ type: "object", properties, ...extra });
const q = (inner: JsonObject): JsonObject => obj({ q: inner });

test("pass-through keywords are kept unchanged, in the caller's key order", () => {
  const schema: JsonObject = {
    title: "T", description: "D", type: "object",
    properties: {
      s: { type: "string", format: "date-time", pattern: "^a", minLength: 1, maxLength: 9, description: "x", title: "y" },
      n: { type: "number", minimum: -1.5, maximum: 10 },
      i: { type: "integer", enum: [1, 2, 3] },
      a: { type: "array", items: { type: "string" }, minItems: 0, maxItems: 4 },
      u: { anyOf: [{ type: "string" }, { type: "integer" }] },
      m: { type: "object", additionalProperties: { type: "string" } },
      z: { type: "object", properties: {}, additionalProperties: false },
      o: { type: "object", additionalProperties: true },
      e: { enum: ["a", 1, null, true, { k: [1] }] },
    },
    required: ["s", "n"],
    additionalProperties: false,
  };
  const out = conv(schema);
  assert.deepEqual(out, schema);
  assert.equal(JSON.stringify(out), JSON.stringify(schema));
  assert.notEqual(out, schema);
  assert.notEqual(out["properties"], schema["properties"]);
});

test("RULING type arrays: only [T, \"null\"] pairs are kept as arrays (not rewritten to nullable)", () => {
  assert.deepEqual(conv(q({ type: ["string", "null"] })), q({ type: ["string", "null"] }));
  assert.deepEqual(conv(q({ type: ["null", "integer"] })), q({ type: ["null", "integer"] }));
  const bad = "parameters.properties.q.type must be a type name or a [type, \"null\"] pair; use anyOf for other unions";
  for (const t of [["string", "integer"], ["string"], ["null"], ["string", "string"], ["null", "null"], ["string", "integer", "null"], []]) refuse(q({ type: t }), bad);
  refuse(q({ type: "date" }), "parameters.properties.q.type has unknown type \"date\"");
  refuse(q({ type: 3 }), bad);
  refuse(q({ nullable: true }), /parameters\.properties\.q\.nullable is not a keyword this adapter knows/);
});

test("annotations are dropped silently, at every level", () => {
  const drop = { $schema: "https://json-schema.org/draft/2020-12/schema", $id: "urn:x", $comment: "c", examples: ["a"], default: "a", deprecated: true, readOnly: true, writeOnly: false, contentMediaType: "text/plain", contentEncoding: "base64" };
  assert.deepEqual(conv({ ...drop, type: "object", properties: { q: { ...drop, type: "string" } } }), q({ type: "string" }));
  // dropped, not validated: an annotation may hold anything
  assert.deepEqual(conv({ type: "string", default: { patternProperties: 1 }, examples: [{ not: 1 }] }), { type: "string" });
});

test("const becomes enum [v] at the same position; const next to enum is refused", () => {
  assert.equal(JSON.stringify(conv(q({ type: "string", const: "x", description: "d" }))), JSON.stringify(q({ type: "string", enum: ["x"], description: "d" })));
  assert.deepEqual(conv(q({ const: null })), q({ enum: [null] }));
  assert.deepEqual(conv(q({ const: { a: [1, "b"] } })), q({ enum: [{ a: [1, "b"] }] }));
  refuse(q({ const: 1, enum: [1, 2] }), "parameters.properties.q has both const and enum, which is not supported by Gemini");
});

test("RULING oneOf becomes anyOf (approximation), in place", () => {
  assert.equal(
    JSON.stringify(conv(q({ description: "d", oneOf: [{ type: "string" }, { type: "integer" }], title: "t" }))),
    JSON.stringify(q({ description: "d", anyOf: [{ type: "string" }, { type: "integer" }], title: "t" })));
  // branches are converted too
  assert.deepEqual(conv(q({ oneOf: [{ const: 1 }, { oneOf: [{ type: "null" }] }] })), q({ anyOf: [{ enum: [1] }, { anyOf: [{ type: "null" }] }] }));
  refuse(q({ anyOf: [{ type: "string" }], oneOf: [{ type: "null" }] }), "parameters.properties.q has both anyOf and oneOf, which cannot be reduced to one anyOf");
  refuse(q({ oneOf: [] }), "parameters.properties.q.oneOf must be a non-empty array of schemas");
  refuse(q({ anyOf: [{ type: "string" }, { patternProperties: {} }] }), "parameters.properties.q.anyOf[1].patternProperties is not supported by Gemini");
});

test("local $ref is inlined ($defs and definitions) and the definition tables are dropped", () => {
  const defs = { addr: { type: "object", properties: { zip: { type: "string" } }, required: ["zip"] }, id: { type: "integer", minimum: 1 } };
  const want = obj({ home: defs.addr, work: defs.addr, id: defs.id });
  assert.deepEqual(conv({ $defs: defs, ...obj({ home: { $ref: "#/$defs/addr" }, work: { $ref: "#/$defs/addr" }, id: { $ref: "#/$defs/id" } }) }), want);
  assert.deepEqual(conv({ definitions: defs, ...obj({ home: { $ref: "#/definitions/addr" }, work: { $ref: "#/definitions/addr" }, id: { $ref: "#/definitions/id" } }) }), want);
  // a ref chain, a root-level ref, and a ref inside items / anyOf
  assert.deepEqual(conv({ $defs: { a: { $ref: "#/$defs/b" }, b: { type: "string" } }, type: "array", items: { $ref: "#/$defs/a" } }), { type: "array", items: { type: "string" } });
  assert.deepEqual(conv({ $defs: { b: { type: "string" } }, $ref: "#/$defs/b" }), { type: "string" });
  assert.deepEqual(conv({ $defs: { b: { type: "string" } }, anyOf: [{ $ref: "#/$defs/b" }, { type: "null" }] }), { anyOf: [{ type: "string" }, { type: "null" }] });
  // description / title next to $ref describe the use site and win
  assert.deepEqual(conv({ $defs: { b: { type: "string", description: "def" } }, ...q({ $ref: "#/$defs/b", description: "use", title: "T", $comment: "c" }) }), q({ type: "string", description: "use", title: "T" }));
  // JSON-pointer escapes in the name
  assert.deepEqual(conv({ $defs: { "a/b~c": { type: "string" } }, ...q({ $ref: "#/$defs/a~1b~0c" }) }), q({ type: "string" }));
  // an unreferenced definition is never sent, so it is not validated
  assert.deepEqual(conv({ $defs: { unused: { not: {} } }, type: "string" }), { type: "string" });
});

test("$ref refusals: remote, other local pointers, unresolved, siblings, non-string", () => {
  const hint = "is not supported by Gemini (only #/$defs/<name> and #/definitions/<name> are inlined)";
  refuse(q({ $ref: "https://example.invalid/s.json" }), `parameters.properties.q.$ref "https://example.invalid/s.json" ${hint}`);
  refuse(q({ $ref: "other.json#/$defs/a" }), `parameters.properties.q.$ref "other.json#/$defs/a" ${hint}`);
  refuse(q({ $ref: "#" }), `parameters.properties.q.$ref "#" ${hint}`);
  refuse(q({ $ref: "#/properties/x" }), `parameters.properties.q.$ref "#/properties/x" ${hint}`);
  refuse(q({ $ref: "#/$defs/a/properties/b" }), `parameters.properties.q.$ref "#/$defs/a/properties/b" ${hint}`);
  refuse(q({ $ref: "#/$defs/missing" }), "parameters.properties.q.$ref \"#/$defs/missing\" does not resolve");
  refuse({ $defs: {}, ...q({ $ref: "#/$defs/toString" }) }, "parameters.properties.q.$ref \"#/$defs/toString\" does not resolve");
  refuse({ definitions: { a: { type: "string" } }, ...q({ $ref: "#/$defs/a" }) }, "parameters.properties.q.$ref \"#/$defs/a\" does not resolve");
  refuse(q({ $ref: 3 }), "parameters.properties.q.$ref must be a string");
  refuse({ $defs: { a: { type: "string" } }, ...q({ $ref: "#/$defs/a", type: "string" }) }, "parameters.properties.q has type next to $ref, which is not supported by Gemini");
  refuse({ $defs: { a: { type: "string" } }, ...q({ $ref: "#/$defs/a", enum: ["x"] }) }, "parameters.properties.q has enum next to $ref, which is not supported by Gemini");
});

test("recursive references are refused (self, mutual), not unrolled", () => {
  const node = { type: "object", properties: { next: { $ref: "#/$defs/node" } } };
  refuse({ $defs: { node }, ...obj({ root: { $ref: "#/$defs/node" } }) },
    "parameters.properties.root.properties.next.$ref \"#/$defs/node\" is recursive, which Gemini cannot express");
  refuse({ $defs: { a: { type: "array", items: { $ref: "#/$defs/b" } }, b: { type: "array", items: { $ref: "#/$defs/a" } } }, $ref: "#/$defs/a" },
    "parameters.items.items.$ref \"#/$defs/a\" is recursive, which Gemini cannot express");
  // the same definition used twice side by side is NOT a cycle
  assert.doesNotThrow(() => conv({ $defs: { s: { type: "string" } }, ...obj({ a: { $ref: "#/$defs/s" }, b: { $ref: "#/$defs/s" } }) }));
});

test("allOf of plain object branches is merged; the merge is deterministic", () => {
  const out = conv({ description: "d", allOf: [
    { type: "object", properties: { a: { type: "string" } }, required: ["a"], description: "ignored: parent has one" },
    { properties: { b: { type: "integer" }, a: { type: "string" } }, required: ["b", "a"], title: "from branch" },
  ] });
  assert.equal(JSON.stringify(out), JSON.stringify({ description: "d", title: "from branch", type: "object", properties: { a: { type: "string" }, b: { type: "integer" } }, required: ["a", "b"] }));
  // the parent's own properties / required take part; refs inside branches are inlined
  assert.deepEqual(conv({ $defs: { base: { properties: { id: { type: "integer" } }, required: ["id"] } }, type: "object", properties: { n: { type: "string" } }, required: ["n"], allOf: [{ $ref: "#/$defs/base" }] }),
    { type: "object", properties: { n: { type: "string" }, id: { type: "integer" } }, required: ["n", "id"] });
  // nested allOf, and a branch without properties
  assert.deepEqual(conv(q({ allOf: [{ allOf: [{ properties: { x: { type: "string" } } }] }, { type: "object" }] })), q({ type: "object", properties: { x: { type: "string" } } }));
});

test("allOf refusals: conflicting properties, non-mergeable branches, non-object parent", () => {
  refuse({ allOf: [{ properties: { a: { type: "string" } } }, { properties: { a: { type: "integer" } } }] },
    "parameters.allOf[1].properties.a conflicts with another definition of \"a\" in the same allOf");
  refuse({ properties: { a: { type: "string" } }, allOf: [{ properties: { a: { type: "integer" } } }] },
    "parameters.allOf[0].properties.a conflicts with another definition of \"a\" in the same allOf");
  refuse({ allOf: [{ type: "string" }] }, "parameters.allOf[0] is not an object schema; allOf is not supported by Gemini unless every branch is");
  for (const k of ["enum", "anyOf", "additionalProperties", "minItems", "items"]) {
    const v = k === "enum" ? [1] : k === "anyOf" ? [{ type: "string" }] : k === "additionalProperties" ? false : k === "items" ? { type: "string" } : 1;
    refuse({ allOf: [{ type: "object", [k]: v }] }, `parameters.allOf[0] is not a plain object schema (has ${k}); allOf is not supported by Gemini unless every branch is`);
  }
  refuse({ allOf: [] }, "parameters.allOf must be a non-empty array of schemas");
  refuse({ allOf: "x" }, "parameters.allOf must be a non-empty array of schemas");
  refuse({ type: "string", allOf: [{ properties: {} }] }, "parameters.allOf can only be merged into an object schema");
  refuse({ allOf: [{ not: {} }] }, "parameters.allOf[0].not is not supported by Gemini");
});

test("unsupported keywords are refused with the tool, the path and the keyword", () => {
  const cases: [string, JsonObject][] = [
    ["patternProperties", { type: "object", patternProperties: { "^x": { type: "string" } } }],
    ["if", { if: { type: "string" } }],
    ["then", { then: { type: "string" } }],
    ["else", { else: { type: "string" } }],
    ["not", { not: { type: "string" } }],
    ["dependentSchemas", { dependentSchemas: {} }],
    ["dependentRequired", { dependentRequired: {} }],
    ["dependencies", { dependencies: {} }],
    ["unevaluatedProperties", { unevaluatedProperties: false }],
    ["unevaluatedItems", { unevaluatedItems: false }],
    ["$dynamicRef", { $dynamicRef: "#x" }],
    ["propertyNames", { propertyNames: { pattern: "^a" } }],
    ["contains", { contains: { type: "string" } }],
  ];
  for (const [k, schema] of cases) {
    refuse(q(schema), `parameters.properties.q.${k} is not supported by Gemini`);
    refuse(schema, `parameters.${k} is not supported by Gemini`);
    refuse({ type: "array", items: schema }, `parameters.items.${k} is not supported by Gemini`);
  }
  // the documented message shape
  assert.throws(() => convertToolSchema(q({ patternProperties: {} }), "tools[0] \"search\""),
    { message: "tools[0] \"search\": parameters.properties.q.patternProperties is not supported by Gemini" });
});

test("unknown keywords fail closed, including ones Gemini might know", () => {
  for (const k of ["exclusiveMinimum", "multipleOf", "uniqueItems", "prefixItems", "minProperties", "nullable", "propertyOrdering", "x-vendor", "$anchor", "$vocabulary"]) {
    refuse(q({ type: "string", [k]: 1 }), `parameters.properties.q${k === "x-vendor" ? "[\"x-vendor\"]" : `.${k}`} is not a keyword this adapter knows; it is refused instead of being forwarded to Gemini`);
  }
  refuse({ type: "object", properties: { "odd name": { foo: 1 } } }, "parameters.properties[\"odd name\"].foo is not a keyword this adapter knows; it is refused instead of being forwarded to Gemini");
});

test("property names are data, never keywords; own __proto__ keys survive", () => {
  const props = { patternProperties: { type: "string" }, $ref: { type: "string" }, enum: { type: "integer" }, not: { type: "string" } };
  assert.deepEqual(conv(obj(props)), obj(props));
  const parsed = JSON.parse("{\"type\":\"object\",\"properties\":{\"__proto__\":{\"type\":\"string\"}},\"required\":[\"__proto__\"]}") as JsonObject;
  const out = conv(parsed);
  assert.equal(JSON.stringify(out), JSON.stringify(parsed));
  assert.equal(Object.getPrototypeOf(out["properties"]), Object.prototype);
  assert.deepEqual(Object.keys(out["properties"] as JsonObject), ["__proto__"]);
});

test("malformed keyword values are refused with the path", () => {
  refuse(q({ description: 1 }), "parameters.properties.q.description must be a string");
  refuse(q({ pattern: /x/ as never }), "parameters.properties.q.pattern must be a string");
  refuse(q({ minimum: "1" }), "parameters.properties.q.minimum must be a finite number");
  refuse(q({ maximum: Infinity }), "parameters.properties.q.maximum must be a finite number");
  refuse(q({ minLength: -1 }), "parameters.properties.q.minLength must be a non-negative integer");
  refuse(q({ maxItems: 1.5 }), "parameters.properties.q.maxItems must be a non-negative integer");
  refuse(q({ enum: [] }), "parameters.properties.q.enum must be a non-empty array");
  refuse(q({ enum: [NaN] }), "parameters.properties.q.enum[0] must be a finite number");
  refuse(q({ enum: [{ a: undefined as never }] }), "parameters.properties.q.enum[0].a is not a JSON value");
  refuse({ type: "object", required: ["a", 1 as never] }, "parameters.required must be an array of strings");
  refuse({ type: "object", properties: [] as never }, "parameters.properties must be an object of schemas");
  refuse(q({ items: true as never }), "parameters.properties.q.items must be a JSON Schema object");
  refuse({ type: "array", items: [{ type: "string" }] as never }, "parameters.items must be a JSON Schema object");
  refuse(q({ additionalProperties: "no" as never }), "parameters.properties.q.additionalProperties must be a JSON Schema object");
  refuse(obj({ q: null as never }), "parameters.properties.q must be a JSON Schema object");
  assert.throws(() => convertToolSchema([] as never, WHERE), { message: `${WHERE}: parameters must be a JSON Schema object` });
});

test("limits: depth <= 32 and total nodes <= 5000 (after inlining)", () => {
  assert.equal(MAX_SCHEMA_DEPTH, 32);
  assert.equal(MAX_SCHEMA_NODES, 5000);
  const chain = (n: number): JsonObject => { let s: JsonObject = { type: "string" }; for (let i = 0; i < n; i++) s = { type: "array", items: s }; return s; };
  assert.doesNotThrow(() => conv(chain(31))); // root + 31 = depth 32
  refuse(chain(32), /^tools\[0\] "search": parameters(\.items)+ exceeds the maximum schema depth of 32$/);

  const flat = (n: number): JsonObject => obj(Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}`, { type: "string" }])));
  assert.doesNotThrow(() => conv(flat(4999))); // root + 4999 = 5000
  refuse(flat(5000), /^tools\[0\] "search": parameters\.properties\.p4999 exceeds the maximum of 5000 schema nodes \(after inlining references\)$/);

  // a reference "bomb": 2^20 expansions from 21 small definitions
  const defs: JsonObject = { d0: { type: "string" } };
  for (let i = 1; i <= 20; i++) defs[`d${i}`] = obj({ a: { $ref: `#/$defs/d${i - 1}` }, b: { $ref: `#/$defs/d${i - 1}` } });
  refuse({ $defs: defs, $ref: "#/$defs/d20" }, /exceeds the maximum of 5000 schema nodes/);
});

test("the caller's schema is never mutated, and the result shares nothing with it", () => {
  const schema: JsonObject = {
    $schema: "x", $defs: { a: { type: "object", properties: { z: { const: 1 } }, required: ["z"] } },
    type: "object",
    properties: { p: { $ref: "#/$defs/a", description: "d" }, e: { enum: ["a", { k: [1] }] }, t: { type: ["string", "null"] }, o: { oneOf: [{ type: "string" }] } },
    required: ["p"],
    allOf: [{ properties: { extra: { type: "string" } }, required: ["extra"] }],
  };
  const before = structuredClone(schema);
  const out = conv(schema);
  assert.deepEqual(schema, before);
  assert.equal(JSON.stringify(schema), JSON.stringify(before));
  // mutate every container of the result: the input must not notice
  const props = out["properties"] as Record<string, JsonObject>;
  (props["e"]!["enum"] as unknown[]).push("x");
  ((props["e"]!["enum"] as JsonObject[])[1]!["k"] as unknown[]).push(2);
  (props["t"]!["type"] as unknown[]).push("x");
  (out["required"] as string[]).push("x");
  props["p"]!["description"] = "changed";
  assert.deepEqual(schema, before);
  // and converting twice gives the same bytes
  assert.equal(JSON.stringify(conv(schema)), JSON.stringify(conv(structuredClone(before))));
});
