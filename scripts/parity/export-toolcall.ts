// Parity vectors (mode V) for the tool-call runtime (P4-K K9b, plan P4-42): the place where model output becomes a tool
// call. `crates/plur1bus-core/src/toolcall/vectors.rs` replays every case and must give the same answer byte for byte:
// the same parsed value, the same repairs, the same issues with the same texts, the same wire schema, or the same refusal.
// Rust may never accept what TypeScript refuses, so most of the corpus is hostile: a seeded generator (the seed is in the
// file) cuts, wraps, quotes and nests documents the way a model does when it gets a call wrong.
//
// Answers are recorded as text (`JSON.stringify` of what TypeScript returned), so member order and number printing are
// part of the vector; a long answer is `{ h, n }`, the first 16 hex digits of its SHA-256 and its length. A string with a
// lone surrogate is `{ "$u16": [units] }`; a large input is `{ gen: [prefix, fill, count, suffix] }`.
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/parity/export-toolcall.ts [--check]
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { exporterMain } from "./lib.mjs";
import { answer, gen, mulberry32, parts, pick, randomJson, randomString, rawOf, str, thrown, value } from "./toolcall-support.ts";
import { assertSchema, prepareCall, validateArguments } from "../../packages/core/src/toolcall/validation.ts";
import { compileCatalogue, compileDialect, fromRegisteredTool, restoreStrictArguments } from "../../packages/core/src/toolcall/dialects.ts";
import { QUIRKS, lookupQuirks } from "../../packages/core/src/toolcall/quirks.ts";
import { MemoryIdempotency, capResult, executeBatch, idempotencyKey } from "../../packages/core/src/toolcall/results.ts";
import { detectToolNeed, toolChoiceForTurn } from "../../packages/core/src/toolcall/tool-use.ts";
import { CORE_TOOL_NAMES, stableToolOffer } from "../../packages/core/src/toolcall/stable-tools.ts";
import { CATEGORIES, CATEGORY_PREFIX } from "../../packages/core/src/toolcall/categories.ts";
import { firstPartyDiscovery, firstPartyToolNames } from "../../packages/core/src/toolcall/first-party-metadata.ts";
import { SecretFormsCache } from "../../packages/core/src/logs/secret-forms.ts";

const U = "\\" + "u"; // the two characters that start a JSON escape, kept apart so no tool rewrites them
const ch = (code: number) => String.fromCharCode(code);
const text = (v: unknown) => JSON.stringify(v);
const attempt = (fn: () => unknown, full = true): unknown => { try { return answer(text(fn()) ?? "undefined", full); } catch (e) { return thrown(e); } };

// ---- JSON.parse and JSON.stringify ---------------------------------------------------------------------------------

const JSON_TEXTS: string[] = [
  "null", "true", "false", "0", "-0", "-0.0", "-0e0", "0e0", "0E-0", "1e400", "-1e400", "1e309", "-1e309", "1E2", "1e+2", "1e-400", "0.1", "0.1e1", "100e-2",
  "123456789012345680000", "1e21", "1e-7", "0.000001", "1.7976931348623157e308", "5e-324", "2.5e-324", "4.9e-324", "9007199254740993", "0.30000000000000004",
  "1" + "0".repeat(400), "0." + "0".repeat(400) + "1", "-", "01", "1.", "-.5", ".5", "1e", "+1", "0x10", "NaN", "Infinity", "-Infinity", "undefined", "--1", "1e5.5", "1.5e", "1 2",
  '""', '"a"', "'a'", `"${U}0041"`, `"${U}00e9"`, `"${U}00E9"`, `"${U}d83d${U}de00"`, `"${U}d83d"`, `"${U}de00${U}d83d"`, `"${U}D83D"`, `"${U}12"`, `"${U}12g4"`, '"\\x41"', '"\\a"', '"\\/"',
  '"\\b\\f\\n\\r\\t\\"\\\\"', '"\t"', '"\n"', `"${ch(0x7f)}"`, `"${ch(0x2028)}${ch(0x2029)}"`, `"${ch(0)}"`, `"${ch(0x1f)}"`, `"${U}0000"`, `"${U}000a"`, `"${U}DEAD"`, `"${ch(0xd83d)}"`, `"a${ch(0xde00)}b"`,
  `["${U}d800", "${U}dc00"]`, `{"${U}d800":1}`, '"abc', '"abc\\"', '"\\', "\"\\\"\"",
  "[]", "[1,]", "[,1]", "[1 2]", "[1,2]", " [ 1 , 2 ] ", "\t\n\r [1]", `${ch(0xa0)}[1]`, `${ch(0xfeff)}[1]`, `[1]${ch(0xb)}`, "[1]\f", `[1]${ch(0x2028)}`, "[1] x", "[1]//c", "/*c*/[1]", "[1,2", "[true false]", "[[[[[]]]]]", "[[],[[]],{}]",
  "{}", '{"a":1}', '{"a":1,}', "{a:1}", "{'a':1}", '{"a":1,"a":2}', '{"a":1,"b":2,"a":3}', '{"b":1,"a":2,"2":3,"10":4,"1":5,"01":6,"-1":7}', '{"__proto__":1}',
  '{"__proto__":{"x":1},"a":2}', '{"__proto__":null,"__proto__":[]}', '{"constructor":{"prototype":{}}}', '{"4294967294":1,"4294967295":2,"a":3,"0":4}', '{"":1}', '{"a":{"b":{"c":[1,{"d":null}]}}}',
  '{"a" 1}', '{"a":}', '{"a":1 "b":2}', "{1:2}", '{"a":1', '{"a"', '{"a":1,', "{,}", '{"a":1,,"b":2}', "", " ", "nul", "tru", "truee", "nulll", "True", "NULL", "[1]]", "{}}",
  '{"toString":1,"valueOf":2,"hasOwnProperty":3}', '{"1.0":1,"1":2,"1e0":3,"0x1":4,"00":5,"0":6}', '{"b":{"2":1,"a":2,"1":3},"a":[{"z":1,"y":2}]}',
];

function buildJson() {
  const cases = JSON_TEXTS.map(t => ({ text: str(t), out: attempt(() => JSON.parse(t)) }));
  // Depth: V8 parses any depth a string of this size can hold; the replay states what the Rust reader does above 512.
  const deep = [[64, "[", "1", "]"], [65, "[", "", "]"], [66, "[", "", "]"], [512, "[", "", "]"], [513, "[", "0", "]"], [5000, "[", "", "]"], [5000, "[", "", ""], [700, '{"a":', "null", "}"], [700, '{"a":', "nul", "}"]]
    .map(([n, open, inner, close]) => {
      const t = String(open).repeat(Number(n)) + inner + String(close).repeat(Number(n));
      let ok = true; try { JSON.parse(t); } catch { ok = false; }
      return { gen: ["", open, n, inner + String(close).repeat(Number(n))], depth: n, ok };
    });
  const rnd = mulberry32(0x6a50_0001);
  const generated: unknown[] = [];
  for (let i = 0; i < 700; i++) {
    let t = JSON.stringify(randomJson(rnd)) ?? "null";
    if (i % 3 === 1) t = mutate(t, rnd);
    if (i % 3 === 2) t = JSON.stringify(randomJson(rnd), null, pick(rnd, [1, "\t", " "]));
    generated.push([str(t), attempt(() => JSON.parse(t), i % 10 === 0)]);
  }
  return { cases, deep, generated, seed: "0x6a500001" };
}

// ---- the hostile corpus --------------------------------------------------------------------------------------------

type Mutation = (t: string, r: () => number) => string;
const MUTATIONS: Mutation[] = [
  (t, r) => t.slice(0, Math.floor(r() * t.length)),
  (t, r) => { const i = Math.floor(r() * t.length); return t.slice(0, i) + t.slice(i + 1); },
  (t, r) => { const i = Math.floor(r() * t.length); return t.slice(0, i) + randomString(r, 3) + t.slice(i); },
  t => t.replace(/}$/, ",}"),
  t => t.replace(/\]/g, ",]"),
  t => t.replace(/}$/, ", \n}"),
  t => t.replace(/}$/, "," + ch(0xa0) + "}"),
  t => t.replace(/([}\]])/g, ",,$1"),
  t => JSON.stringify(t),
  t => JSON.stringify(JSON.stringify(t)),
  t => JSON.stringify(t.replace(/}$/, ",}")),
  t => t.replace(/"/g, "'"),
  t => t.replace(/"(\w+)":/g, "$1:"),
  t => t.replace(/:(-?\d+(?:\.\d+)?)/g, ":\"$1\""),
  t => t.replace(/:(-?\d+)/g, ":\"$1.0\""),
  t => t.replace(/:(-?\d+)/g, ":\" $1\""),
  t => t.replace(/:(-?\d+)/g, ":\"0$1\""),
  t => t.replace(/:(-?\d+)/g, ":\"$1e0\""),
  t => t.replace(/:(-?\d+)/g, ":\"+$1\""),
  t => t.replace(/:(-?\d+)/g, ":\"0x$1\""),
  t => t.replace(/"path":"[^"]*",?/, ""),
  t => t.replace(/^{/, "{\"zzz\":1,"),
  t => t.replace(/"count":\d+/, "\"count\":1.5"),
  t => t.replace(/"count":\d+/, "\"count\":1e400"),
  t => t.replace(/"count":\d+/, "\"count\":-0"),
  t => t.replace(/"count":\d+/, "\"count\":9007199254740993"),
  t => t.replace(/"count":\d+/, "\"count\":NaN"),
  t => t.replace(/"count":\d+/, "\"count\":Infinity"),
  t => t.replace(/"count":(\d+)/, "\"count\":$1,\"count\":\"x\""),
  t => t.replace(/"count":(\d+)/, "\"count\":\"x\",\"count\":$1"),
  t => "```json\n" + t + "\n```",
  t => "```\n" + t + "\n```",
  t => "Here are the arguments:\n" + t,
  t => "<tool_call>" + t + "</tool_call>",
  t => "<function=tool>" + t + "</function>",
  t => "<arg_key>path</arg_key><arg_value>" + t + "</arg_value>",
  t => "<|python_tag|>" + t,
  t => `{"name":"tool","arguments":${t}}`,
  t => `{"name":"tool","arguments":${JSON.stringify(t)}}`,
  t => ch(0xfeff) + t,
  t => t + " trailing",
  t => t + "\n" + t,
  t => t + "//done",
  t => "/* args */" + t,
  t => t.replace(/"path":"/, "\"path\":\"" + "x".repeat(100)),
  t => t.replace(/^{/, "{\"__proto__\":{\"polluted\":true},"),
  t => t.replace(/^{/, "{\"constructor\":{\"prototype\":{\"polluted\":true}},"),
  t => "[".repeat(200) + t + "]".repeat(200),
  t => t.replace(/^{/, "{" + "\"a\":{".repeat(80)) + "}".repeat(80),
  t => "{\"nested\":".repeat(70) + t + "}".repeat(70),
  t => t.replace(/"/g, "\\\""),
  t => t.replace(/\s*/g, "") + ch(0),
  t => t.replace(/"path":"/, "\"path\":\"" + ch(1)),
  t => t.replace(/"path":"/, "\"path\":\"" + ch(0xd83d)),
  t => t.replace(/"path":"/, "\"path\":\"" + U + "d83d"),
  t => t.replace(/"path":"/, "\"path\":\"" + U + "0000"),
  t => t.replace(/"path":"/, "\"path\":\"\\x41"),
  t => t.toUpperCase(),
  t => t.replace(/true|false/g, m => m[0]!.toUpperCase() + m.slice(1)),
  t => t.replace(/null/g, "None"),
  t => t.replace(/,/g, ", ").replace(/:/g, " : ").replace(/^{/, "{\n\t").replace(/}$/, "\r\n}"),
  t => t.replace(/,/, ch(0x2028) + ","),
  () => "",
  () => "null",
  () => "[]",
  () => "\"\"",
  () => "{}",
];
function mutate(t: string, rnd: () => number): string {
  let out = pick(rnd, MUTATIONS)(t, rnd);
  if (rnd() < 0.25) out = pick(rnd, MUTATIONS)(out, rnd);
  return out;
}

// ---- prepareCall ---------------------------------------------------------------------------------------------------

const FUZZ_SCHEMA = {
  type: "object", additionalProperties: false, required: ["path", "count"],
  properties: {
    path: { type: "string", minLength: 1, maxLength: 40, pattern: "^[^\\0]*$" },
    count: { type: "integer", minimum: 0, maximum: 100 },
    ratio: { type: "number", exclusiveMinimum: 0, maximum: 1 },
    mode: { enum: ["r", "w", "rw"] },
    flag: { type: "boolean" },
    tags: { type: "array", maxItems: 4, uniqueItems: true, items: { type: "string", maxLength: 8 } },
    nested: { type: "object", additionalProperties: false, required: ["k"], properties: { k: { type: "integer" }, v: { anyOf: [{ type: "string" }, { type: "null" }] } } },
  },
};
const SCHEMAS: unknown[] = [
  FUZZ_SCHEMA,
  {},
  { type: "string" },
  { type: "object", properties: { n: { type: "number" }, i: { type: "integer" }, s: { type: "string" }, list: { type: "array", items: { type: "integer" } }, deep: { type: "object", properties: { n: { type: "number" } } } } },
  { type: "array", items: { type: "number" }, minItems: 1 },
  { type: ["object", "null"], properties: { path: { type: ["string", "integer"] }, count: { type: "number", multipleOf: 0.5 } }, additionalProperties: { type: "integer" }, minProperties: 1, maxProperties: 3 },
  { type: "integer" },
];
const FAMILIES = ["openai-chat", "openai-responses", "anthropic", "gemini", "local-small", "unknown", "something-else", "__proto__", "toString"];

function validArgs(rnd: () => number): Record<string, unknown> {
  const a: Record<string, unknown> = { path: "p" + Math.floor(rnd() * 1000), count: Math.floor(rnd() * 101) };
  if (rnd() < .5) a["ratio"] = Math.round((rnd() * 0.99 + 0.01) * 1000) / 1000;
  if (rnd() < .5) a["mode"] = ["r", "w", "rw"][Math.floor(rnd() * 3)];
  if (rnd() < .5) a["flag"] = rnd() < .5;
  if (rnd() < .5) a["tags"] = Array.from({ length: Math.floor(rnd() * 4) }, (_, i) => `t${i}`);
  if (rnd() < .4) a["nested"] = { k: Math.floor(rnd() * 9), ...(rnd() < .5 ? { v: rnd() < .5 ? "s" : null } : {}) };
  if (rnd() < .2) a["path"] = randomString(rnd, 30).replace(/\0/g, "") || "x";
  return a;
}

function depthOf(v: unknown): number {
  let depth = 0;
  for (let level: unknown[] = [v]; level.length; depth++) level = level.flatMap(x => x && typeof x === "object" ? Object.values(x) : []);
  return depth - 1;
}

/** One call with a scripted repair port; records the answer and what the port was asked. */
async function prepared(name: string, schema: unknown, raw: unknown, family: string | undefined, repairs?: unknown[], secrets?: string[], full = true) {
  const asked: unknown[] = [];
  // The Rust reader does not build a document deeper than 512 levels (it still checks its syntax); its repair port is
  // handed the raw text instead. That request is recorded next to the one TypeScript made.
  const askedAbove512: unknown[] = [];
  let n = 0;
  const port = repairs ? async (req: any) => {
    asked.push(str(text({ tool: req.tool, args: req.args, issues: req.issues, message: req.message })));
    if (depthOf(req.args) > 512) askedAbove512.push(str(text({ tool: req.tool, args: raw, issues: req.issues, message: req.message })));
    const next: any = repairs[n++];
    if (next && next.throw) throw new Error("repair failed");
    return rawOf(next);
  } : undefined;
  const cache = new SecretFormsCache();
  const known = secrets ? () => cache.snapshot(secrets) : undefined;
  let out: unknown;
  try { out = answer(text(await prepareCall(name, schema as any, raw, port, family, known)), full); } catch (e) { out = thrown(e); }
  return { out, ...(repairs ? { asked } : {}), ...(askedAbove512.length ? { askedAbove512 } : {}) };
}

async function buildArguments() {
  const named: unknown[] = [];
  const add = async (name: string, c: { schema?: unknown; raw: unknown; family?: string; repairs?: unknown[]; secrets?: string[]; tool?: string; full?: boolean }) => {
    const schema = c.schema ?? FUZZ_SCHEMA;
    named.push({ name, schema: schema === FUZZ_SCHEMA ? 0 : text(schema), raw: c.raw, ...(c.family !== undefined ? { family: c.family } : {}), ...(c.repairs ? { repairs: c.repairs } : {}), ...(c.secrets ? { secrets: c.secrets.map(s => parts(...(s.match(/.{1,4}/g) ?? []))) } : {}), tool: c.tool ?? "file.write",
      ...await prepared(c.tool ?? "file.write", schema, rawOf(c.raw), c.family, c.repairs, c.secrets, c.full ?? true) });
  };
  const good = '{"path":"a.txt","count":3}';
  for (const family of FAMILIES) {
    await add(`valid as written (${family})`, { raw: good, family });
    await add(`trailing commas (${family})`, { raw: '{"path":"a,}",\n"count":3 , "tags":["a","b",],}', family });
    await add(`wrapped once (${family})`, { raw: JSON.stringify(good), family });
    await add(`wrapped twice (${family})`, { raw: JSON.stringify(JSON.stringify(good)), family });
    await add(`numeric strings (${family})`, { raw: '{"path":"a","count":"3","ratio":"0.5","nested":{"k":"7"}}', family });
    await add(`wrapped with trailing comma inside (${family})`, { raw: JSON.stringify('{"path":"a","count":"3",}'), family });
    // A comma at the very end of the text has nothing after it to close, so it stays (and the document fails).
    await add(`a trailing comma after the document (${family})`, { raw: good + ",", family });
    await add(`a trailing comma and white space after the document (${family})`, { raw: good + ",\n ", family });
  }
  await add("no family: the fallback profile", { raw: JSON.stringify('{"path":"a","count":"3",}') });
  await add("a root string schema is not unwrapped", { raw: '"{\\"a\\":1}"', schema: { type: "string" }, family: "openai-chat" });
  await add("a string that is not JSON inside the wrapper", { raw: '"not json"', family: "openai-chat" });
  await add("a string that is not JSON, no unwrap repair", { raw: '"not json"', family: "anthropic" });
  await add("empty text", { raw: "" });
  // The byte bound, exactly at and one past 256 KiB (UTF-8 bytes of the text).
  await add("exactly 256 KiB, any object", { raw: gen('{"path":"', "a", 256 * 1024 - 21, '","count":1}'), schema: { type: "object" }, full: false });
  await add("one byte past 256 KiB", { raw: gen('{"path":"', "a", 256 * 1024 - 20, '","count":1}'), schema: { type: "object" } });
  await add("256 KiB counted in bytes, not units", { raw: gen('{"path":"', "é", (256 * 1024 - 20) / 2, '","count":1}'), schema: { type: "object" } });
  await add("undefined arguments", { raw: { undefined: true } });
  await add("null arguments", { raw: value(null) });
  await add("a parsed object", { raw: value({ path: "a", count: "3", nested: { k: "2" } }), family: "anthropic" });
  await add("a parsed array against the object schema", { raw: value([1, 2]) });
  await add("a parsed number", { raw: value(5), schema: { type: "integer" } });
  await add("duplicate key keeps the last value", { raw: '{"path":"a","count":"x","count":3}' });
  await add("__proto__ is data", { raw: '{"path":"a","count":1,"__proto__":{"polluted":true}}' });
  await add("__proto__ where additional properties are allowed", { raw: '{"__proto__":{"n":"1"},"n":"2","constructor":1}', schema: SCHEMAS[3], family: "openai-chat" });
  await add("BOM before the document", { raw: ch(0xfeff) + good, family: "openai-chat" });
  await add("a comment", { raw: good + " // done", family: "local-small" });
  await add("single quotes", { raw: "{'path':'a','count':3}", family: "local-small" });
  await add("a markdown fence", { raw: "```json\n" + good + "\n```", family: "local-small" });
  await add("an XML-like dialect", { raw: "<tool_call>" + good + "</tool_call>", family: "local-small" });
  await add("text after the document", { raw: good + " and more", family: "local-small" });
  await add("NaN and Infinity spellings", { raw: '{"path":"a","count":NaN}', family: "local-small" });
  await add("1e400 is Infinity to JSON.parse and unsafe to the validator", { raw: '{"path":"a","count":1e400}', family: "local-small" });
  await add("minus zero", { raw: '{"path":"a","count":-0,"ratio":-0}' });
  await add("an unsafe integer", { raw: '{"path":"a","count":9007199254740993}', schema: { type: "object", properties: { count: { type: "integer" } } } });
  // `Number(v)` would read these (sign, white space, hex, a trailing dot, full-width digits); the repair's own pattern
  // must refuse them first, so they stay strings and the validator reports them.
  for (const v of ["+5", " 5", "5 ", "0x10", "5.", ".5", "-0", "00", "1_0", "\uff15", "\ufeff5", "5\u0085", "Infinity", "1e400", "-1e-400", "1E2", "0.50"]) await add(`a numeric string ${JSON.stringify(v)}`, { raw: `{"count":"${v}","n":"${v}"}`, schema: { type: "object", properties: { count: { type: "integer" }, n: { type: "number" } } }, family: "anthropic" });
  await add("an unsafe integer as a numeric string", { raw: '{"count":"9007199254740992","n":"1e400","m":"1e308"}', schema: { type: "object", properties: { count: { type: "integer" }, n: { type: "number" }, m: { type: "number" } } }, family: "anthropic" });
  await add("a lone surrogate escape in a value", { raw: `{"path":"${U}d83d","count":1}` });
  await add("a lone surrogate in the raw text", { raw: str(`{"path":"x${ch(0xde00)}","count":1}`) });
  await add("a lone surrogate in a key", { raw: `{"path":"a","count":1,"${U}d83d/~":2}` });
  await add("an escaped NUL fails the pattern", { raw: `{"path":"a${U}0000","count":1}` });
  await add("a raw control character", { raw: `{"path":"a${ch(1)}","count":1}` });
  await add("code points, not units", { raw: '{"s":"😀😀😀","t":"😀😀😀😀","c":"é"}', schema: { type: "object", properties: { s: { type: "string", maxLength: 3 }, t: { type: "string", maxLength: 3 }, c: { type: "string", minLength: 2 } } } });
  await add("a clipped value in the issue", { raw: `{"path":"${"😀".repeat(60)}","count":1}` });
  await add("the clip does not leave half a pair", { raw: `{"path":"${"x".repeat(78)}😀${"y".repeat(50)}","count":1}` });
  await add("every problem is listed", { raw: '{"path":"","count":101,"ratio":0,"mode":"x","flag":1,"tags":["a","a","toolongtag",1,2],"nested":{"v":3},"zzz":1}' });
  await add("pointer escapes", { raw: '{"a/b":"x","c~d":"y","":{"":1}}', schema: { type: "object", properties: { "a/b": { type: "integer" }, "c~d": { type: "integer" }, "": { type: "object", properties: { "": { type: "string" } } } } } });
  await add("exactly 256 KiB", { raw: gen('{"path":"', "x", 262144 - 22, '","count":1}') });
  await add("one byte over 256 KiB", { raw: gen('{"path":"', "x", 262144 - 21, '","count":1}') });
  await add("the limit counts bytes", { raw: gen('{"path":"', "é", 131072, '","count":1}') });
  await add("65 levels", { raw: gen("", "[", 65, "]".repeat(65)), schema: {} });
  await add("66 levels", { raw: gen("", "[", 66, "]".repeat(66)), schema: {} });
  await add("66 levels of objects", { raw: gen("", '{"a":', 66, "1" + "}".repeat(66)), schema: {} });
  await add("600 levels", { raw: gen("", "[", 600, "]".repeat(600)), schema: {}, repairs: [value([])] });
  await add("600 levels cut off", { raw: gen("", "[", 600, "]".repeat(599)), schema: {} });
  await add("20000 nodes", { raw: gen("[", "0,", 19998, "0]"), schema: {} });
  await add("20001 nodes", { raw: gen("[", "0,", 19999, "0]"), schema: {} });
  await add("repair: not asked when valid", { raw: good, repairs: [good] });
  await add("repair: one good answer", { raw: '{"path":"a"}', repairs: [good], family: "openai-chat" });
  await add("repair: a second failure is final", { raw: '{"path":"a"}', repairs: ['{"count":"x"}', good], family: "anthropic" });
  await add("repair: the port throws", { raw: '{"path":"a",}', repairs: [{ throw: true }], family: "openai-chat" });
  await add("repair: the port gives nothing", { raw: '{"path":"a"}', repairs: [{ undefined: true }] });
  await add("repair: a wrapped answer with a trailing comma", { raw: "nope", repairs: [JSON.stringify('{"path":"a","count":"2",}')], family: "openai-chat" });
  await add("repair: a parsed answer", { raw: "nope", repairs: [value({ path: "a", count: "2" })], family: "gemini" });
  await add("repair: an oversize first attempt", { raw: gen('{"path":"', "x", 262144, '","count":1}'), repairs: [good] });
  await add("repair: an oversize answer", { raw: "nope", repairs: [gen('{"path":"', "x", 262144, '","count":1}')] });
  await add("repair: the message names tool, family and every issue", { raw: '{"count":-1,"zzz":1,"a/b":2}', repairs: ["{}"], family: "local-small", tool: "weird tool\nname" });
  await add("a known secret is masked in the issue", { raw: { parts: ['{"path":"', "hunter", "2-correct-", "horse-battery", '","count":1,"mode":"', "hunter", "2-correct-", "horse-battery", '"}'] }, schema: { ...FUZZ_SCHEMA, properties: { ...FUZZ_SCHEMA.properties, path: { type: "integer" } } }, secrets: ["hunter2-correct-horse-battery"] });
  await add("an invalid schema throws before the arguments are read", { raw: good, schema: { type: "object", format: "x" } });
  await add("an invalid pattern throws", { raw: good, schema: { type: "object", properties: { a: { type: "string", pattern: "(" } } } });

  const rnd = mulberry32(0x70011c);
  const cases: unknown[] = [];
  for (let i = 0; i < 2000; i++) {
    const schemaIndex = rnd() < 0.7 ? 0 : Math.floor(rnd() * SCHEMAS.length);
    const family = Math.floor(rnd() * FAMILIES.length);
    const base = schemaIndex === 0 || rnd() < 0.5 ? validArgs(rnd) : randomJson(rnd);
    let raw = JSON.stringify(base) ?? "null";
    if (i % 5 !== 0) raw = mutate(raw, rnd);
    const parsed = rnd() < 0.05;
    let input: unknown = raw;
    // A parsed input is recorded as JSON text, so only one that survives that trip is used (not `Infinity`, not `-0`).
    if (parsed) { try { input = JSON.parse(raw); if (!isDeepStrictEqual(JSON.parse(JSON.stringify(input)), input)) input = raw; } catch { input = raw; } }
    const { out } = await prepared("t", SCHEMAS[schemaIndex], input, FAMILIES[family], undefined, undefined, i % 12 === 0);
    cases.push([typeof input === "string" ? str(input) : value(input), schemaIndex, family, out]);
  }
  return { schemas: SCHEMAS.map(text), families: FAMILIES, named, fuzz: { seed: "0x70011c", cases } };
}

// ---- assertSchema and validateArguments ----------------------------------------------------------------------------

const PATTERNS = ["^[a-z]+$", "\\p{L}+", "^.{2}$", "^(?:a|b)*c$", "\\d{2,}", "(?<=a)b", "(?<!a)b", "^\\S+$", "\\bz\\b", "^\\w+$", "[\\u{1F600}-\\u{1F64F}]", "^\\s*$", "a.b", "^$", "(a)\\1", "(?<n>a)\\k<n>", "^\\p{Lu}\\p{Ll}*$", "[^\\p{ASCII}]", "\\u{1F600}", "^[\\d\\s]+$", "\\/", "\\cA", "$^", "a|", "(?=a)a", "(?!a).", "[\\b]", "\\0", "x{2}", "x{2,}?", "^.$"];
const BAD_PATTERNS = ["(", ")", "[", "a{2,1}", "\\p{Nope}", "[b-a]", "\\k<x>", "\\u{110000}", "\\-", "(?<n>a)(?<n>b)", "*", "a**", "\\1", "{", "}", "]", "\\c", "\\8", "(?<=a)+", "\\p", "a{1", "(?i:a)", "\\q", "[\\d-a]", "\\_"];

function randomSchema(rnd: () => number, depth = 0): any {
  const leafs = ["string", "integer", "number", "boolean", "null", "enum", "const", "any"];
  const kind = pick(rnd, depth >= 2 ? leafs : [...leafs, "object", "object", "object", "array", "array", "anyOf", "oneOf", "allOf", "multi"]);
  const s: any = {};
  if (rnd() < 0.15) s.description = pick(rnd, ["d", "", 0, 5, null, ["a", null, [1, 2]], { o: 1 }, false, true]);
  switch (kind) {
    case "string": s.type = "string"; if (rnd() < .4) s.minLength = Math.floor(rnd() * 3); if (rnd() < .4) s.maxLength = Math.floor(rnd() * 6); if (rnd() < .4) s.pattern = pick(rnd, PATTERNS); break;
    case "integer": case "number": s.type = kind; if (rnd() < .4) s.minimum = Math.floor(rnd() * 10) - 5; if (rnd() < .4) s.maximum = Math.floor(rnd() * 10); if (rnd() < .2) s.exclusiveMinimum = 0; if (rnd() < .2) s.exclusiveMaximum = 5.5; if (rnd() < .3) s.multipleOf = pick(rnd, [2, 0.1, 0.5, 0, -1, 1e-11, 3]); break;
    case "boolean": case "null": s.type = kind; break;
    case "enum": s.enum = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => randomJson(rnd, 2)); break;
    case "const": s.const = randomJson(rnd, 2); if (rnd() < .3) s.default = 1; break;
    case "object": {
      s.type = "object"; s.properties = {};
      const names = ["a", "b", "c", "a/b", "c~d", "__proto__", "2", "1", ""];
      for (let i = Math.floor(rnd() * 4); i > 0; i--) Object.defineProperty(s.properties, pick(rnd, names), { value: randomSchema(rnd, depth + 1), enumerable: true, writable: true, configurable: true });
      if (rnd() < .5) s.required = Object.keys(s.properties).filter(() => rnd() < .6).concat(rnd() < .2 ? ["zz"] : []);
      if (rnd() < .7) s.additionalProperties = pick(rnd, [false, false, true, randomSchema(rnd, 2)]);
      if (rnd() < .2) s.minProperties = 1; if (rnd() < .2) s.maxProperties = 2;
      break;
    }
    case "array": s.type = "array"; if (rnd() < .8) s.items = randomSchema(rnd, depth + 1); if (rnd() < .3) s.minItems = 1; if (rnd() < .3) s.maxItems = 2; if (rnd() < .3) s.uniqueItems = rnd() < .8; break;
    case "anyOf": case "oneOf": case "allOf": s[kind] = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => randomSchema(rnd, depth + 1)); break;
    case "multi": s.type = pick(rnd, [["string", "null"], ["integer", "string"], ["object", "array"], ["number", "boolean", "null"]]); if (rnd() < .5) s.minLength = 2; if (rnd() < .5) s.minimum = 1; break;
    default: break;
  }
  if (rnd() < 0.1) Object.assign(s, pick(rnd, [{ $comment: "c" }, { examples: [1] }, { deprecated: true }, { readOnly: false }, { title: "t" }, { $schema: "x", $id: "y" }, { writeOnly: true, default: null }]));
  return s;
}
/** A value near the schema: mostly fitting, sometimes not. */
function valueFor(s: any, rnd: () => number, depth = 0): unknown {
  if (rnd() < 0.12 || depth > 4) return randomJson(rnd, 2);
  if (Array.isArray(s.enum)) return rnd() < .8 ? pick(rnd, s.enum) : randomJson(rnd, 2);
  if ("const" in s) return rnd() < .8 ? s.const : randomJson(rnd, 2);
  for (const k of ["anyOf", "oneOf", "allOf"]) if (Array.isArray(s[k])) return valueFor(pick(rnd, s[k]), rnd, depth + 1);
  const type = Array.isArray(s.type) ? pick(rnd, s.type) : s.type;
  switch (type) {
    case "string": return pick(rnd, ["", "a", "ab", "abc", "z", "a b", "😀", "aab", "Ab", "é", "ac", "12", ch(0xd83d), "x".repeat(7)]);
    case "integer": return pick(rnd, [0, 1, 2, 3, -1, 5, 6, 10, 1.5, -0, 9007199254740993, "3"]);
    case "number": return pick(rnd, [0, 0.1, 0.3, 0.5, 1, 2.5, 5.5, -3, 1e21, 0.30000000000000004, "0.5", 1e-11, 4]);
    case "boolean": return rnd() < .5;
    case "null": return null;
    case "array": return Array.from({ length: Math.floor(rnd() * 4) }, (_, i) => i > 0 && rnd() < .3 ? null : valueFor(s.items ?? {}, rnd, depth + 1));
    case "object": {
      const o: Record<string, unknown> = {};
      const put = (k: string, v: unknown) => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
      for (const [k, sub] of Object.entries(s.properties ?? {})) if (rnd() < .75) put(k, valueFor(sub, rnd, depth + 1));
      if (rnd() < .3) put(pick(rnd, ["extra", "__proto__", "zz", "0"]), valueFor(typeof s.additionalProperties === "object" ? s.additionalProperties : {}, rnd, depth + 1));
      return o;
    }
    default: return randomJson(rnd, 2);
  }
}

function buildValidation() {
  const SUPPORTED = ["type", "properties", "required", "additionalProperties", "items", "enum", "const", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "pattern", "minItems", "maxItems", "uniqueItems", "anyOf", "oneOf", "allOf", "minProperties", "maxProperties", "description", "title", "$schema", "$id", "$comment", "default", "examples", "deprecated", "readOnly", "writeOnly"];
  const UNSUPPORTED = ["format", "not", "if", "then", "else", "$ref", "$defs", "definitions", "patternProperties", "propertyNames", "dependencies", "dependentRequired", "contains", "prefixItems", "additionalItems", "nullable", "__proto__", "constructor", "Type", "", "x-custom"];
  const VALUES: unknown[] = [null, true, false, 0, 1, -1, 1.5, "", "a", "object", [], [1], ["string"], ["string", "nope"], ["a", 1], {}, { a: 1 }, { type: "string" }, [{}], [{ type: "x" }], [[]], "(", "\\p{L}", 1e400];
  const schemas: unknown[] = [null, 1, "s", [], true, {}];
  for (const k of SUPPORTED) for (const v of VALUES) schemas.push({ [k]: v });
  for (const k of UNSUPPORTED) { schemas.push(Object.defineProperty({}, k, { value: 1, enumerable: true })); schemas.push({ properties: { a: Object.defineProperty({}, k, { value: {}, enumerable: true }) } }); }
  for (const p of [...PATTERNS, ...BAD_PATTERNS]) schemas.push({ pattern: p });
  const nest = (n: number, leaf: unknown = {}) => { let s: any = leaf; for (let i = 0; i < n; i++) s = [{ properties: { a: s } }, { items: s }, { anyOf: [s] }, { additionalProperties: s }][i % 4]; return s; };
  schemas.push(nest(32), nest(33), nest(32, { format: 1 }), nest(33, { format: 1 }), { enum: [{ format: 1 }], const: { not: {} }, default: { $ref: "x" }, examples: [{ if: 1 }] });
  schemas.push({ format: 1, type: "nope" }, { type: "nope", format: 1 }, { properties: { a: { type: "x" }, b: { nope: 1 } } }, { anyOf: [{}, { oneOf: [] }] }, { required: ["a", 1] }, { items: [{}] }, { additionalProperties: { type: 5 } });
  const assert = schemas.map(s => { const t = text(s); let out: unknown = null; try { assertSchema(JSON.parse(t)); } catch (e) { out = (thrown(e) as any).throws; } return [t, out]; });

  const validate: unknown[] = [];
  const check = (schema: unknown, v: unknown, full = true) => { const st = text(schema), vt = text(v); validate.push([st, vt, attempt(() => validateArguments(JSON.parse(st), JSON.parse(vt)), full)]); };
  const grid: [unknown, unknown[]][] = [
    [{ type: "integer" }, [0, -0, 1.5, 9007199254740991, 9007199254740992, "1", null, true, [], {}]],
    [{ type: "number" }, [0, 1.5, 1e308, "1", null]],
    [{ type: ["integer", "null"] }, [1, null, 1.5, "x"]],
    [{ type: "object" }, [{}, [], null, "x"]], [{ type: "array" }, [{}, [], null]], [{ type: "null" }, [null, 0, false, ""]], [{ type: "boolean" }, [true, 0, "true"]], [{ type: "string" }, ["", 0, null, ["a"]]],
    [{ minimum: 1, maximum: 2 }, [0.999, 1, 2, 2.001, "0"]], [{ exclusiveMinimum: 1, exclusiveMaximum: 2 }, [1, 1.5, 2]],
    [{ multipleOf: 0.1 }, [0.3, 0.30000000000000004, 0.35, 1e21, 1e300, -0.7]], [{ multipleOf: 0 }, [0, 1]], [{ multipleOf: -2 }, [4]], [{ multipleOf: 1e-320 }, [1, 1e300]], [{ multipleOf: 3 }, [9, 10, -9, 4.5, 1.0000000000000002e-10, 2.9999999999]],
    [{ minimum: 1.5, maximum: 1e21, exclusiveMinimum: 1e-7, exclusiveMaximum: 123456789012345680000 }, [0, 1e22]],
    [{ enum: [1, "1", null, [1, { a: [2] }], { a: 1, b: 2 }, -0] }, [1, "1", null, [1, { a: [2] }], { b: 2, a: 1 }, { a: 1 }, 0, -0, true, [1, { a: [2, 3] }], 1.0]],
    [{ const: { a: [1, 2], b: null } }, [{ b: null, a: [1, 2] }, { a: [2, 1], b: null }, { a: [1, 2] }]], [{ const: 0 }, [0, -0, false, null, ""]], [{ const: null }, [null, 0]], [{ const: [] }, [[], {}]], [{ const: {} }, [[], {}]],
    [{ anyOf: [{ type: "string" }, { type: "integer", minimum: 5 }] }, ["a", 5, 4, null]], [{ oneOf: [{ type: "number" }, { type: "integer" }, { const: "x" }] }, [1, 1.5, "x", "y"]], [{ allOf: [{ minimum: 1 }, { maximum: 3 }, { type: "integer" }] }, [2, 0, 4, 2.5]],
    [{ type: "array", minItems: 1, maxItems: 2, uniqueItems: true, items: { type: "integer" } }, [[], [1], [1, 2, 3], [1, 1], ["a"], [1, "a", 1.5]]], [{ uniqueItems: true }, [[{ a: 1, b: [2] }, { b: [2], a: 1 }], [0, -0], [1, "1"], [[1], [1]], [null, null], [{}, []]]], [{ uniqueItems: false }, [[1, 1]]],
    [{ minLength: 2, maxLength: 3 }, ["a", "ab", "abcd", "😀", "😀😀", "e" + ch(0x301), ch(0xd83d) + "a", "😀😀😀😀"]],
    [{ pattern: "^\\p{L}+$" }, ["abc", "a1", "𝒜", "é", ""]], [{ pattern: "^.$" }, ["😀", "ab", "\n", ch(0xd83d)]], [{ pattern: "\\bz\\b" }, ["a z b", "az", "z" + ch(0x17f)]], [{ pattern: "^\\s+$" }, [" \t" + ch(0xa0) + ch(0xfeff) + ch(0x2028), ch(0x85), ch(0x180e)]], [{ pattern: "(?<=a)b|^$" }, ["ab", "cb", ""]], [{ pattern: "^\\w+$" }, ["a_1", "é", ch(0x17f), ch(0x212a)]], [{ pattern: "^\\d+$" }, ["12", "١٢"]], [{ pattern: "^[a-z]+$" }, ["abc", "aBc", ch(0x17f)]], [{ pattern: "^a.c$" }, ["abc", "a\nc", "a" + ch(0x2028) + "c", "a😀c"]],
    [{ type: "object", required: ["a", "b", "a/b", "__proto__", "toString"], properties: { a: { type: "integer" } }, additionalProperties: false }, [{}, { a: 1, b: 2 }, { a: "x", c: null, "a/b": 1, "c~d": [] }, JSON.parse('{"__proto__":1,"toString":2,"a":1,"b":1,"a/b":1}')]],
    [{ type: "object", properties: { a: { type: "string" } }, additionalProperties: { type: "integer", minimum: 0 } }, [{ a: "x", b: 1, c: -1, d: "s" }, { a: 1 }]], [{ additionalProperties: true, properties: {} }, [{ a: 1 }]], [{ properties: { a: { minimum: 1 } } }, [{ a: 0 }, { b: 0 }, [0], "a"]],
    [{ minProperties: 1, maxProperties: 2 }, [{}, { a: 1 }, { a: 1, b: 2, c: 3 }, [], "ab"]], [{ minProperties: 1.5 }, [{ a: 1 }, { a: 1, b: 2 }]], [{ minItems: 0.5, maxItems: 1e21, minLength: -1, maxLength: 1e-7 }, [[], "", "a"]],
    [{ required: ["a"], type: ["object", "array", "string"] }, [{}, [], "a", 1]], [{ items: { type: "object", required: ["id"], properties: { id: { type: "string", minLength: 1 } } } }, [[{ id: "" }, {}, { id: 1 }, 5], { 0: { id: "" } }]],
    [{ type: "object", properties: JSON.parse('{"__proto__":{"type":"integer"},"constructor":{"type":"string"}}') }, [JSON.parse('{"__proto__":"x","constructor":1}'), {}, JSON.parse('{"__proto__":1}')]],
    [{}, [null, 0, "", [], {}, 1e21, 1e-7, -0]],
    [{ type: "string", enum: ["a"], const: "b", minLength: 5, pattern: "^z" }, ["a", "b", 1]],
  ];
  for (const [schema, values] of grid) for (const v of values) check(schema, v);
  // Depth of the value and of the walk.
  const deepValue = (n: number) => { let v: unknown = 1; for (let i = 0; i < n; i++) v = i % 2 ? [v] : { a: v }; return v; };
  for (const n of [63, 64, 65, 66]) check({}, deepValue(n));
  const rec = (n: number) => { let s: any = { type: "integer" }; for (let i = 0; i < n; i++) s = { items: s }; return s; };
  const arr = (n: number) => { let v: unknown = "x"; for (let i = 0; i < n; i++) v = [v]; return v; };
  check(rec(30), arr(30)); check(rec(30), arr(29));
  const rnd = mulberry32(0x5c4e_0a11);
  const generated: unknown[] = [];
  for (let i = 0; i < 1500; i++) {
    const st = text(randomSchema(rnd));
    const vt = text(valueFor(JSON.parse(st), rnd));
    generated.push([st, vt, attempt(() => validateArguments(JSON.parse(st), JSON.parse(vt)), i % 6 === 0)]);
  }
  const patternBounds = [
    { name: "pattern at the bound", pattern: "a".repeat(256), value: "a".repeat(256), rust: "accept" },
    { name: "pattern above the bound", pattern: "a".repeat(257), value: "a".repeat(257), rust: "schema-refusal" },
    { name: "input at the bound", pattern: "^a+$", value: "a".repeat(1024), rust: "accept" },
    { name: "input above the bound", pattern: "^a+$", value: "a".repeat(1025), rust: "value-refusal" },
  ].map(({ name, pattern, value, rust }) => {
    const schema = { pattern };
    assertSchema(schema);
    return { name, schema: text(schema), value: text(value), typescript: validateArguments(schema, value).length,
      rust, ...(rust === "accept" ? {} : { divergence: "K9b-D2" }) };
  });
  return { assert, validate, generated, seed: "0x5c4e0a11", patternBounds };
}

// ---- dialects ------------------------------------------------------------------------------------------------------

function buildDialects() {
  const WIRE = ["openai-chat", "openai-responses", "anthropic", "gemini", "other"];
  const compile: unknown[] = [];
  const one = (name: string, tool: any, family: string, options?: any, full = true) => {
    const t = { name: tool.name, ...(tool.description !== undefined ? { description: tool.description } : {}), ...(tool.parameters !== undefined ? { parameters: text(tool.parameters) } : {}) };
    compile.push({ name, tool: t, family, ...(options ? { options } : {}), out: attempt(() => compileDialect({ ...tool, ...(tool.parameters !== undefined ? { parameters: JSON.parse(text(tool.parameters)) } : {}) }, family as any, options), full) });
  };
  const params = { type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: "string", description: "where", minLength: 1, default: "x", examples: ["a"] }, mode: { enum: ["r", "w"], $comment: "c" }, count: { type: "integer", exclusiveMinimum: 0, multipleOf: 2, const: 4 }, opts: { type: "object", additionalProperties: false, properties: { deep: { type: "array", uniqueItems: true, items: { oneOf: [{ type: "string" }, { type: "null" }] } }, any: { anyOf: [{ type: "string" }] }, c: { const: null }, n: { type: ["string", "null"] }, e: { type: "string", enum: ["a"] } }, minProperties: 1 } } };
  for (const family of WIRE) {
    one(`golden envelope (${family})`, { name: "file_write", description: "Write a file.", parameters: params }, family);
    one(`no parameters, no description (${family})`, { name: "ping" }, family);
    for (const strict of [true, false]) one(`strict ${strict} (${family})`, { name: "file_write", description: "d", parameters: params }, family, { strict });
    for (const modelFamily of ["local-small", "anthropic", "openai-chat", "gemini", "nope"]) one(`model family ${modelFamily} on ${family}`, { name: "1-tool", description: "x".repeat(1025), parameters: { type: "object", properties: {}, additionalProperties: false } }, family, { modelFamily });
    for (const name of ["a".repeat(64), "a".repeat(65), "", "a b", "a.b", "tool\n", "9lives", "-dash", "_ok", "ü", "a$", "A-Z_09", "file_write\nx"]) one(`name ${JSON.stringify(name)} (${family})`, { name }, family);
    for (const n of [1024, 1025, 4096, 4097]) one(`description of ${n} (${family})`, { name: "t", description: "d".repeat(n) }, family);
    one(`description counts units (${family})`, { name: "t", description: "😀".repeat(513) }, family);
    for (const parameters of [{ type: "array" }, { type: "string" }, {}, { type: ["object"] }, { type: "object", format: "x" }, { type: "object", properties: { a: { type: "object" } } }, { type: "object", additionalProperties: false, properties: { a: { type: "object", additionalProperties: true } } }, { type: "object", additionalProperties: false, properties: { a: { type: "array", items: { type: "object", properties: {} } } } }])
      one(`parameters ${text(parameters)} (${family})`, { name: "t", parameters }, family);
    one(`description on a reduced node (${family})`, { name: "t", parameters: { type: "object", additionalProperties: false, properties: { a: { type: "integer", description: "first", multipleOf: 2, uniqueItems: true, minProperties: 1, maxProperties: 2, exclusiveMaximum: 9, allOf: [{ minimum: 1 }], oneOf: [{ const: 2, deprecated: true }] }, b: { description: 0, multipleOf: 1 }, c: { description: ["x", null, [1]], multipleOf: 1 }, d: { description: { o: 1 }, multipleOf: 1 }, e: { const: 1, enum: [2, 3] } } } }, family);
    one(`strict shapes (${family})`, { name: "t", parameters: { type: "object", additionalProperties: false, required: ["r", "gone"], properties: { r: { type: "string" }, s: { type: "string" }, u: { type: ["string", "integer"] }, a: { anyOf: [{ type: "string" }], type: "string" }, e: { type: "string", enum: ["x"] }, c: { type: "string", const: "x" }, n: {}, o: { type: "object", additionalProperties: false, properties: { x: { type: "integer" } }, required: [] }, z: { type: "object", additionalProperties: false } } } }, family, family.startsWith("openai") ? { strict: true } : undefined);
    one(`property names (${family})`, { name: "t", parameters: JSON.parse('{"type":"object","additionalProperties":false,"properties":{"b":{"type":"string"},"2":{"type":"string"},"__proto__":{"type":"string","default":1},"1":{"type":"integer"},"a/b":{"default":0}}}') }, family);
  }
  const rnd = mulberry32(0xd1a1_ec75);
  const generated: unknown[] = [];
  for (let i = 0; i < 500; i++) {
    const parameters = rnd() < 0.85 ? { ...randomSchema(rnd, 0), type: "object", ...(rnd() < 0.6 ? { additionalProperties: false } : {}) } : randomSchema(rnd, 1);
    const pt = text(parameters);
    const family = pick(rnd, WIRE);
    const options = rnd() < 0.5 ? { ...(rnd() < 0.7 ? { strict: rnd() < 0.7 } : {}), ...(rnd() < 0.3 ? { modelFamily: pick(rnd, ["local-small", "openai-responses", "gemini", "anthropic"]) } : {}) } : undefined;
    generated.push([pt, family, options ?? null, attempt(() => compileDialect({ name: "t", description: "d", parameters: JSON.parse(pt) }, family as any, options), i % 5 === 0)]);
  }
  const tool = (name: string) => ({ name, description: "d", parameters: { type: "object", properties: {}, additionalProperties: false } });
  const catalogue = [
    { name: "empty", names: [], family: "openai-chat" }, { name: "order is kept", names: ["b", "a", "c"], family: "anthropic" }, { name: "duplicates", names: ["a", "b", "a"], family: "gemini" }, { name: "case differs", names: ["a", "A"], family: "gemini" },
    { name: "one bad name", names: ["a", "b c"], family: "openai-chat" }, { name: "128 for openai", count: 128, family: "openai-chat" }, { name: "129 for openai", count: 129, family: "openai-chat" }, { name: "64 for anthropic", count: 64, family: "anthropic" }, { name: "65 for anthropic", count: 65, family: "anthropic" },
    { name: "16 for the local profile", count: 16, family: "openai-chat", modelFamily: "local-small" }, { name: "17 for the local profile", count: 17, family: "openai-chat", modelFamily: "local-small" }, { name: "17 for an unknown family", count: 17, family: "openai-chat", modelFamily: "nope" }, { name: "the count is checked before duplicates", names: Array.from({ length: 70 }, () => "a"), family: "gemini" },
  ].map((c: any) => { const names: string[] = c.names ?? Array.from({ length: c.count }, (_, i) => `t${i}`); return { ...c, out: attempt(() => compileCatalogue(names.map(tool), c.family, c.modelFamily), names.length < 4) }; });
  const restoreCases: [unknown, unknown][] = [
    [{ type: "object", required: ["r"], properties: { r: { type: "string" }, o: { type: "string" }, n: { type: ["string", "null"] }, e: { enum: [1, null] }, c: { const: null }, a: { anyOf: [{ type: "null" }, { type: "string" }] }, x: { anyOf: [{ type: "string" }, 5] }, sub: { type: "object", properties: { o: { type: "integer" } } }, list: { type: "array", items: { type: "object", properties: { o: { type: "integer" } } } }, t: { type: "null" } } },
      { r: null, o: null, n: null, e: null, c: null, a: null, x: null, sub: { o: null, keep: null }, list: [{ o: null }, { o: 1 }, null, [{ o: null }]], t: null, unknown: null }],
    [{ type: "object", properties: { o: { type: "string" } } }, [{ o: null }]], [{ type: "array", items: { type: "object", properties: { o: { type: "string" } } } }, [{ o: null, p: null }]], [{ type: "object", properties: { o: { type: "string" } } }, "x"], [{ type: "object" }, { a: null }], [{ properties: { o: { type: "string" } } }, { o: null }],
    [{ type: "object", properties: JSON.parse('{"__proto__":{"type":"string"},"b":{"type":"string"},"1":{"type":"string"}}') }, JSON.parse('{"b":null,"__proto__":null,"1":null,"toString":null,"0":"x"}')],
    [{ type: "object", required: ["a"], properties: { a: { type: "object", properties: { b: { type: "object", properties: { c: { type: "string" } } } } } } }, { a: { b: { c: null, d: null }, b2: null } }],
  ];
  const restore = restoreCases.map(([s, v]) => { const st = text(s), vt = text(v); return [st, vt, attempt(() => restoreStrictArguments(JSON.parse(st), JSON.parse(vt)))]; });
  const registered = text(fromRegisteredTool({ name: "n", description: "d", inputSchema: { type: "object" } } as any));
  return { compile, generated, catalogue, restore, registered, seed: "0xd1a1ec75" };
}

// ---- results -------------------------------------------------------------------------------------------------------

/** A tool's return value as the fixture describes it: `{ json }`, `{ failed: true }` (an `Error`), `{ binary: n }`
 *  (n bytes) or `{ undefined: true }`. */
function resultOf(spec: any): unknown {
  if (spec.failed) return new Error("boom at /Users/x");
  if (typeof spec.binary === "number") return new Uint8Array(spec.binary);
  if (spec.undefined) return undefined;
  return JSON.parse(spec.json);
}

async function buildResults() {
  const cap: unknown[] = [];
  const capCase = async (name: string, spec: any, maxBytes?: number, reference?: string) => {
    let puts = 0;
    const store = { async put() { puts++; return reference ?? `ref-${puts}`; } };
    let out: unknown;
    try { const t = text(await capResult(resultOf(spec), store, maxBytes)); out = answer(t, t.length < 400); } catch (e) { out = thrown(e); }
    cap.push({ name, value: spec, ...(maxBytes !== undefined ? { maxBytes } : {}), ...(reference !== undefined ? { reference } : {}), out, puts });
  };
  const j = (v: unknown) => ({ json: text(v) });
  await capCase("a small value", j({ b: 1, a: [true, null, "x"], 2: "two", 1: "one" }));
  await capCase("a string", j("plain"));
  await capCase("null", j(null));
  await capCase("minus zero and exponents", { json: '{"z":-0,"big":1e21,"small":1e-7,"int":100e-2}' });
  await capCase("a lone surrogate", { json: `["${U}d83d",{"${U}de00":1}]` });
  await capCase("undefined", { undefined: true });
  await capCase("an Error instance", { failed: true });
  await capCase("binary data is referenced", { binary: 4 });
  await capCase("empty binary data is referenced", { binary: 0 });
  // The bytes of the envelope around a string value, and around a reference.
  const around = Buffer.byteLength(text({ isError: false, value: "", truncated: false }));
  const aroundReference = Buffer.byteLength(text({ isError: false, truncated: true, reference: "" }));
  await capCase("exactly at the limit", j("x".repeat(200 - around)), 200);
  await capCase("one byte over the limit", j("x".repeat(201 - around)), 200);
  await capCase("the limit counts bytes: fits", j("é".repeat((200 - around) / 2)), 200);
  await capCase("the limit counts bytes: over", j("é".repeat((200 - around) / 2 + 1)), 200);
  await capCase("the default limit is 32 KiB", j("x".repeat(32 * 1024 - around)));
  await capCase("over the default limit", j("x".repeat(32 * 1024 - around + 1)));
  await capCase("budget 128 is the minimum", j("x"), 128);
  await capCase("budget 127 is refused", j("x"), 127);
  await capCase("budget 0 is refused", j("x"), 0);
  await capCase("a reference that does not fit", j("x".repeat(500)), 128, "r".repeat(100));
  await capCase("a reference that just fits", j("x".repeat(500)), 128, "r".repeat(128 - aroundReference));
  await capCase("a reference one byte too long", j("x".repeat(500)), 128, "r".repeat(129 - aroundReference));
  for (const [name, v] of [
    ["bare", { isError: true }], ["known code and hint", { isError: true, error: { code: "tool-denied", hint: "ask the owner" } }],
    ["unknown code", { isError: true, error: { code: "E_CUSTOM", hint: "h", stack: "at x (y.js:1)" } }], ["every known code", null],
    ["a hint with line breaks", { isError: true, error: { code: "tool-timeout", hint: "one\r\n\r\ntwo\nthree\rfour" } }],
    ["a long hint is cut at 80 units", { isError: true, error: { code: "aborted", hint: "h".repeat(79) + "😀" + "tail" } }],
    ["a hint that is not a string", { isError: true, error: { code: "tool-failed", hint: 5 } }], ["a code that is not a string", { isError: true, error: { code: 5 } }],
    ["error is an array", { isError: true, error: ["tool-denied"] }], ["error is null", { isError: true, error: null }], ["error is a string", { isError: true, error: "tool-denied" }],
    ["isError is not true", { isError: "true", error: { code: "tool-denied" } }], ["isError is 1", { isError: 1 }], ["isError false", { isError: false, value: 1 }],
    ["an array is never an error envelope", [{ isError: true }]], ["extra members are dropped", { isError: true, value: "secret-ish payload", error: { code: "tool-result-invalid", hint: "x", message: "m" }, meta: {} }],
  ] as [string, unknown][]) {
    if (v === null) { for (const code of ["tool-unknown", "tool-call-invalid", "tool-denied", "tool-not-approved", "tool-timeout", "tool-failed", "tool-result-too-large", "tool-result-invalid", "aborted", "Aborted", ""]) await capCase(`error: code ${code}`, j({ isError: true, error: { code } })); continue; }
    await capCase(`error: ${name}`, j(v));
  }
  await capCase("error: too large for the budget, referenced", j({ isError: true, error: { code: "tool-failed", hint: "h".repeat(80) } }), 128);
  await capCase("error: the reference does not fit either", j({ isError: true, error: { code: "tool-failed", hint: "h".repeat(80) } }), 128, "r".repeat(100));

  const rnd = mulberry32(0x1de0_0001);
  const keys: unknown[] = [];
  const key = (scope: string, name: string, args: string) => keys.push([scope, name, args, attempt(() => idempotencyKey(scope, name, JSON.parse(args)))]);
  for (const args of ['{"a":1,"b":2}', '{"b":2,"a":1}', '{"a":1,"b":2,"c":null}', "[1,2]", "[2,1]", "null", '"x"', "0", "-0", "1.0", "1e21", "1e-7", '{"a":{"y":[{"q":1,"p":2}],"x":0}}', '{"a":{"x":0,"y":[{"p":2,"q":1}]}}',
    '{"__proto__":{"a":1},"b":2}', '{"b":2}', '{"2":1,"10":2,"1":3}', '{"é":1,"e":2,"z":3,"Z":4,"\ud83d\ude00":5,"\uffff":6}', `{"${U}d83d":1}`, '{"":1}', "{}", "[]", '{"a":[]}', '{"a":{}}'])
    key("agent:session:task", "file.write", args);
  key("a", "b:c", "1"); key("a:b", "c", "1"); key("", "", "null"); key("scope", "n", '"😀"');
  for (let i = 0; i < 60; i++) key(randomString(rnd, 8).toWellFormed(), randomString(rnd, 8).toWellFormed(), text(randomJson(rnd)) ?? "null");

  const batches: unknown[] = [];
  const batch = async (name: string, scope: string, rounds: any[][], failing: string[] = []) => {
    const memory = new MemoryIdempotency();
    const executed: unknown[] = [];
    const outs: unknown[] = [];
    for (const calls of rounds) {
      const real = calls.map(c => ({ name: c.name, arguments: JSON.parse(c.arguments), parallelSafe: c.parallelSafe, ...(c.operationId !== undefined ? { operationId: c.operationId } : {}) }));
      try {
        outs.push(text(await executeBatch(scope, real, async (call, k) => { executed.push([call.name, k]); if (failing.includes(call.name)) throw new Error("x"); return { ran: call.name, with: call.arguments }; }, memory)));
      } catch (e) { outs.push(thrown(e)); }
    }
    batches.push({ name, scope, rounds, failing, executed, outs });
  };
  const call = (name: string, args: unknown, parallelSafe: boolean, operationId?: string) => ({ name, arguments: text(args), parallelSafe, ...(operationId !== undefined ? { operationId } : {}) });
  await batch("order is the request order", "s", [[call("a", 1, true), call("b", 2, true), call("c", 3, false), call("d", 4, true), call("e", 5, false), call("f", 6, false), call("g", 7, true)]]);
  await batch("a duplicate runs once", "s", [[call("a", { x: 1, y: 2 }, true), call("a", { y: 2, x: 1 }, true), call("a", { x: 1, y: 3 }, true), call("a", { x: 1, y: 2 }, false)]]);
  await batch("the memory lasts across batches", "s", [[call("a", 1, true)], [call("a", 1, false), call("a", 2, true)]]);
  await batch("a failure is a typed result and is remembered", "s", [[call("bad", 1, true), call("ok", 1, true), call("bad", 1, false)]], ["bad"]);
  await batch("the operation id separates equal calls", "s", [[call("a", 1, true, "op1"), call("a", 1, true, "op2"), call("a", 1, true, "op1"), call("a", 1, true), call("a", 1, true, "")]]);
  await batch("scope and operation id are joined injectively", "a:b", [[call("t", 1, true, "c"), call("t", 1, true, "c:d"), call("t", 1, true, "c\\d")]]);
  await batch("the other split of the same text", "a", [[call("t", 1, true, "b:c"), call("t", 1, true, "b\\:c")]]);
  await batch("empty", "s", [[]]);
  return { cap, keys, batches };
}

// ---- tool use ------------------------------------------------------------------------------------------------------

function buildToolUse() {
  const MESSAGES: string[] = [
    "", "hello there", "see https://example.com/a?b=1 please", "HTTP://EXAMPLE.COM", "xhttps://a", "_https://a", "-https://a", "https://", "http:// x", "https:/a", "ftp://a", "(http://a)", "éhttp://a", `${ch(0x17f)}https://a`, "https://" + ch(0xa0), "https://" + ch(0xd83d), "http" + ch(0x17f) + "://a", "HTTP" + ch(0x17f) + "://a", "Https://a", "hTtP://a",
    "./a", "../b", "~/c", "~\\c", ".\\x", "x./a", "a/b", "and/or", " /", "/ a", "(/x)", "\"/tmp\"", "'/tmp'", "`/tmp`", "1/2", "x /é", "x /😀", "/-x", "/@me", "/~u", "/_x", "/.hidden", "/", "//", "x//y", "a /", "=/x", "\t/x", "\n/x", ch(0xa0) + "/x", ch(0x2028) + "/x",
    "C:\\Users\\x", "c:/x", "open c:/x now", "abc:/x", "bc:\\x", "C:x", "C:\\", "C:/ x", "\\\\?\\C:\\x", "\\\\?\\c:/x", "\\\\server\\share\\f", "\\\\server\\share", "\\\\server\\", "\\\\\\x\\y", "x\\\\server\\share\\f", " \\\\s\\t", `${ch(0x212a)}:\\x`, `${ch(0x17f)}:/x`,
    "aktuell", "aktuelle", "aktuellen", "aktueller", "aktuelles", "aktuellem", "aktuellx", "aktuelleren", "Aktuell?", "neueste", "neuesten", "neuest", "heute", "HEUTE", "heutig", "heutige", "heutigen", "heutiges", "jetzt", "gestern", "morgen", "morgens", "übermorgen", "vorgestern",
    "derzeit", "derzeitig", "derzeitige", "derzeitigem", "today", "TODAY", "todays", "today's", "tonight", "yesterday", "tomorrow", "latest", "current", "currently", "currents", "recent", "recently", "recents", "newest", "up to date", "up-to-date", "uptodate", "up  to date", "up to-date", "real time", "real-time", "realtime",
    `today${ch(0x17f)}`, `${ch(0x17f)}today`, `today${ch(0x212a)}`, "today_", "today1", "todayé", "étoday", "tod" + ch(0x301) + "ay", `la${ch(0x17f)}test`, `${ch(0x212a)}urrent`, "LATEST", "Latest news", "the latest.", "what is new", "now", "this week",
    "today" + ch(0xd83d), ch(0xde00) + "today", "😀today", "today😀",
    "Was ist heute los und wie ist das Wetter?", "lies /etc/hosts und http://x.y", "nothing to see here: a and b; c, d.",
  ];
  const need: unknown[] = [];
  const record = (input: any) => need.push([{ ...input, message: str(input.message) }, attempt(() => detectToolNeed(input))]);
  for (const message of MESSAGES) record({ message });
  const rnd = mulberry32(0x7001_0a5e);
  const WORDS = ["today", "heute", "latest", "/tmp/x", "./a", "https://a.b", "C:\\x", "\\\\s\\t\\u", "plain", "words", "up", "to", "date", "real", "time", "aktuelle", "~", "/", ":", "(", "\"", " ", "\n", ch(0xa0), ch(0x17f), ch(0x212a), "é", "😀", ch(0xd83d), "_", "-", "1", "c:", "http", "s://"];
  for (let i = 0; i < 400; i++) record({ message: Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => pick(rnd, WORDS)).join(pick(rnd, ["", " ", ""])) });
  const tasks = (confidence: number, categories: Record<string, number>) => [{ confidence, categories }];
  for (const [confidence, p] of [[0.65, 1], [0.8, 0.8125], [0.8, 0.81], [1, 0.65], [1, 0.6499999], [0.7, 0.93], [0.5, 1], [1, 1], [0, 0], [0.9, 0.9]]) {
    record({ message: "x", tasks: tasks(confidence!, { "web.search": p!, "docs.read": 0.01 }), categoriesWithTools: ["web.search"] });
    record({ message: "x", tasks: tasks(confidence!, { "web.search": p! }), categoriesWithTools: ["docs.read"] });
    record({ message: "x", tasks: tasks(confidence!, { "web.search": p! }) });
  }
  for (const minConfidence of [0, 1, 0.5, 1.01, -0.1, 0.81, 0.8099]) record({ message: "x", tasks: tasks(0.9, { a: 0.9 }), categoriesWithTools: ["a"], minConfidence });
  record({ message: "x", tasks: [{ confidence: 0.1, categories: { a: 1 } }, { confidence: 0.9, categories: { b: 0.1, a: 0.8 } }], categoriesWithTools: ["a", "a"] });
  record({ message: "x", tasks: [] }); record({ message: "x", attachments: true }); record({ message: "x", attachments: false });
  for (const [allowedTools, offeredTools] of [[["a"], ["a", "b"]], [["a", "a"], ["a"]], [["a", "b"], ["a", "b"]], [["a", "b"], ["b"]], [["a"], undefined], [["a"], []], [[" ", "", "\t" + ch(0xa0)], [" "]], [[" a "], [" a "]], [[" a "], ["a"]], [[ch(0xfeff)], ["a"]], [[ch(0x85)], ["a"]], [[ch(0x180e)], ["a"]], [[ch(0x3000) + ch(0x2029)], ["a"]], [[], ["a"]], [["", "b"], ["b", ""]]] as [string[], string[] | undefined][])
    record({ message: "https://x today ./a", attachments: true, allowedTools, ...(offeredTools ? { offeredTools } : {}) });

  const choice: unknown[] = [];
  for (let i = 0; i < 700; i++) {
    const named = pick(rnd, [undefined, undefined, "a", "b", "zz", ""]);
    const input: any = {
      ...(rnd() < 0.8 ? { mode: pick(rnd, ["auto", "prefer", "require-first"]) } : {}),
      need: { needed: rnd() < 0.7, reasons: [], ...(named !== undefined ? { namedTool: named } : {}) },
      round: pick(rnd, [0, 0, 0, 1, 2]), ...(rnd() < 0.3 ? { retry: rnd() < 0.7 } : {}), ...(rnd() < 0.2 ? { hasToolCall: rnd() < 0.7 } : {}),
      tools: pick(rnd, [[], ["a"], ["a", "b"], ["b"], ["a", "b", ""]]), family: pick(rnd, ["openai-chat", "openai-responses", "anthropic", "gemini"]),
      ...(rnd() < 0.3 ? { model: pick(rnd, ["claude-sonnet-5-5", "claude-opus", "gpt"]) } : {}), ...(rnd() < 0.4 ? { local: rnd() < 0.7 } : {}),
      ...(rnd() < 0.5 ? { modelFamily: pick(rnd, ["local-small", "openai-chat", "openai-responses", "gemini", "anthropic", "nope"]) } : {}), ...(rnd() < 0.3 ? { thinking: rnd() < 0.7 } : {}),
    };
    choice.push([input, text(toolChoiceForTurn(input))]);
  }
  return { need, choice, seed: "0x70010a5e" };
}

// ---- stable tool offers --------------------------------------------------------------------------------------------

function buildStable() {
  const rnd = mulberry32(0x57ab_1e00);
  const POOL = [...CORE_TOOL_NAMES, "memory.recall", "memory.capture", "memory.", "memoryx", "Memory.a", "exec.run", "a", "b", "Z", "é", "😀", "web.search", "mcp.x.y", "file.write"];
  const some = (max: number) => Array.from({ length: Math.floor(rnd() * max) }, () => pick(rnd, POOL));
  const cases: unknown[] = [];
  const one = (input: any) => cases.push([input, attempt(() => stableToolOffer(input))]);
  one({ available: [], maxTools: 0 }); one({ available: ["a"], maxTools: 0 }); one({ available: [...CORE_TOOL_NAMES], maxTools: 7 }); one({ available: [...CORE_TOOL_NAMES].reverse(), maxTools: 8 });
  one({ available: ["b", "a", "memory.z", "memory.a", "file.read"], previous: ["b", "b", "gone"], relevant: ["a", "new"], maxTools: 3 });
  one({ available: ["b", "a"], previous: ["b"], relevant: ["a"], maxTools: 1 }); one({ available: ["😀", "\uff41", "b"], previous: ["\uff41", "😀", "b"], maxTools: 1 }); one({ available: ["😀", "\uff41"], previous: ["\uff41", "😀"], maxTools: 1 }); one({ available: ["b", "a"], relevant: ["b", "a"], maxTools: 1 });
  for (let i = 0; i < 250; i++) one({ available: some(14), ...(rnd() < 0.7 ? { previous: some(8) } : {}), ...(rnd() < 0.7 ? { relevant: some(8) } : {}), maxTools: Math.floor(rnd() * 14) });
  return { core: [...CORE_TOOL_NAMES], cases, seed: "0x57ab1e00" };
}

// ---- tables --------------------------------------------------------------------------------------------------------

function buildTables() {
  const lookups: unknown[] = [];
  for (const family of [...Object.keys(QUIRKS), "unknown", "", "__proto__", "constructor", "toString", "OpenAI-Chat", "anthropic "]) for (const model of [undefined, "claude-sonnet-5-5", "claude-sonnet-5-5 ", "gpt"]) lookups.push([family, model ?? null, text(lookupQuirks(family, model))]);
  // The shipped tools' discovery metadata, in the order the table was built; a name that is not in it has none.
  const firstParty = firstPartyToolNames().map(name => { const d = firstPartyDiscovery(name)!; return [name, d.category, d.summary, d.useWhen, d.notFor, d.kind]; });
  const unknown = ["nope", "", "__proto__", "constructor", "toString", "File.read", "file.read ", "hostctl", "memory.", "memory.forget"].map(name => [name, firstPartyDiscovery(name) === undefined]);
  return { quirks: Object.entries(QUIRKS).map(([name, q]) => [name, text(q)]), lookups, categories: CATEGORIES.map(c => [c.id, c.description]), categoryPrefix: CATEGORY_PREFIX, firstParty, unknown };
}

export async function buildToolcallVectors() {
  return { json: buildJson(), arguments: await buildArguments(), validation: buildValidation(), dialects: buildDialects(), tables: buildTables(), results: await buildResults(), "tool-use": buildToolUse(), "stable-tools": buildStable() };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await exporterMain({ area: "toolcall", build: buildToolcallVectors }));
