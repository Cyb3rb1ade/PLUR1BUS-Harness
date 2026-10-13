// core/toolcall argument parser, generative: 1500 seeded cases (spec minimum 300). Own PRNG (mulberry32), fixed seed in every message.
// Invariants (derived from the validation.ts contract, not from its output):
//  - prepareCall never throws on JSON-ish input (raw strings or parsed values),
//  - the result is either ok with arguments that re-validate clean, or the documented tool-call-invalid error with >= 1 issue,
//  - at most one model repair round, only when the first attempt was invalid,
//  - a document that is valid as-is is accepted unchanged and with no repair, whatever the model family,
//  - only the repairs allowed for the model family are ever logged, the same input gives the same output.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { prepareCall, validateArguments, type Schema, type ValidationIssue } from "../../src/toolcall/validation.ts";
import { QUIRKS } from "../../src/toolcall/quirks.ts";
import { mulberry32, randomString } from "./helpers.ts";

const SEED = 0x70011c;
const CASES = 1500;
const SCHEMA: Schema = {
  type: "object", additionalProperties: false, required: ["path", "count"],
  properties: {
    path: { type: "string", minLength: 1, maxLength: 40, pattern: "^[^\\u0000]*$" },
    count: { type: "integer", minimum: 0, maximum: 100 },
    ratio: { type: "number", exclusiveMinimum: 0, maximum: 1 },
    mode: { enum: ["r", "w", "rw"] },
    flag: { type: "boolean" },
    tags: { type: "array", maxItems: 4, uniqueItems: true, items: { type: "string", maxLength: 8 } },
    nested: { type: "object", additionalProperties: false, required: ["k"], properties: { k: { type: "integer" }, v: { anyOf: [{ type: "string" }, { type: "null" }] } } },
  },
};
const FAMILIES = ["openai-chat", "openai-responses", "anthropic", "gemini", "local-small", "unknown", "something-else"];

function validArgs(rnd: () => number): Record<string, unknown> {
  const a: Record<string, unknown> = { path: "p" + Math.floor(rnd() * 1000), count: Math.floor(rnd() * 101) };
  if (rnd() < .5) a["ratio"] = Math.round((rnd() * 0.99 + 0.01) * 1000) / 1000;
  if (rnd() < .5) a["mode"] = ["r", "w", "rw"][Math.floor(rnd() * 3)];
  if (rnd() < .5) a["flag"] = rnd() < .5;
  if (rnd() < .5) a["tags"] = Array.from({ length: Math.floor(rnd() * 4) }, (_, i) => `t${i}`);
  if (rnd() < .4) a["nested"] = { k: Math.floor(rnd() * 9), ...(rnd() < .5 ? { v: rnd() < .5 ? "s" : null } : {}) };
  if (rnd() < .2) a["path"] = randomString(rnd, 30).replace(/\u0000/g, "") || "x";
  return a;
}

type Mutation = (text: string, rnd: () => number) => string;
const mutations: Mutation[] = [
  (t, r) => t.slice(0, Math.floor(r() * t.length)),                                   // truncate
  (t, r) => { const i = Math.floor(r() * t.length); return t.slice(0, i) + t.slice(i + 1); }, // delete one char
  (t, r) => { const i = Math.floor(r() * t.length); return t.slice(0, i) + randomString(r, 3) + t.slice(i); }, // insert junk
  t => t.replace(/}$/, ",}"),                                                          // trailing comma
  t => t.replace(/\]/g, ",]"),                                                         // trailing commas in arrays
  t => JSON.stringify(t),                                                              // wrap once
  t => JSON.stringify(JSON.stringify(t)),                                              // wrap twice
  t => t.replace(/"/g, "'"),                                                           // single quotes
  t => t.replace(/"(\w+)":/g, "$1:"),                                                  // unquoted keys
  t => t.replace(/:(-?\d+(?:\.\d+)?)/g, ":\"$1\""),                                    // numbers become strings
  t => t.replace(/"path":"[^"]*",?/, ""),                                              // drop a required key
  t => t.replace(/^{/, "{\"zzz\":1,"),                                                 // extra key
  t => t.replace(/"count":\d+/, "\"count\":1.5"),                                      // integer violated
  t => t.replace(/"count":\d+/, "\"count\":1e400"),                                    // overflow literal
  t => "```json\n" + t + "\n```",                                                      // markdown fence
  t => "﻿" + t,                                                                   // BOM
  t => t + " trailing",                                                                // trailing text
  t => t.replace(/"path":"/, "\"path\":\"" + "x".repeat(100)),                         // overlong string
  t => t.replace(/^{/, "{\"__proto__\":{\"polluted\":true},"),                         // prototype key
  t => t.replace(/^{/, "{\"constructor\":{\"prototype\":{\"polluted\":true}},"),
  t => "[".repeat(200) + t + "]".repeat(200),                                          // deep nesting
  t => t.replace(/^{/, "{" + "\"a\":{".repeat(80)) + "}".repeat(80),                   // very deep object (unbalanced on purpose)
  t => t.replace(/"/g, "\\\""),                                                        // escaped quotes
  t => t.replace(/\s*/g, "") + "\u0000",                                               // NUL
  t => t.toUpperCase(),                                                                // case change
  () => "",                                                                           // empty
];

function rawInput(rnd: () => number, i: number): { raw: unknown; label: string } {
  const base = validArgs(rnd);
  const text = JSON.stringify(base);
  const kind = rnd();
  if (kind < .12) return { raw: base, label: "object" };
  if (kind < .16) return { raw: randomJsonLike(rnd), label: "random value" };
  if (kind < .18) return { raw: "x".repeat(256 * 1024 + 1 + Math.floor(rnd() * 5)), label: "oversize" };
  if (kind < .30) return { raw: JSON.stringify(base, null, rnd() < .5 ? 2 : "\t"), label: "pretty" };
  const n = 1 + Math.floor(rnd() * 3); let t = text; const applied: number[] = [];
  for (let m = 0; m < n; m++) { const idx = Math.floor(rnd() * mutations.length); applied.push(idx); t = mutations[idx]!(t, rnd); }
  return { raw: t, label: `mutations ${applied.join(",")}` };
}
function randomJsonLike(rnd: () => number): unknown {
  const pool: unknown[] = [null, true, 0, -1, 1.5, "", "s", [], {}, [1, "2"], { path: 1 }, { path: "a", count: "7" }, { path: "a", count: [] }, "{\"path\":\"a\",\"count\":2}", undefined, Number.NaN, 5n, new Date(0), Symbol.for("x")];
  return pool[Math.floor(rnd() * pool.length)];
}
const preview = (raw: unknown) => { try { return typeof raw === "string" ? JSON.stringify(raw.slice(0, 120)) : String(typeof raw); } catch { return "?"; } };

describe("prepareCall: seeded generative run", () => {
  it(`${CASES} generated inputs (seed 0x${SEED.toString(16)}): never an unexpected exception, always a valid result or the documented error`, async () => {
    const rnd = mulberry32(SEED);
    let accepted = 0, rejected = 0, repairedByLocal = 0, modelRounds = 0, acceptedAfterModel = 0;
    for (let i = 0; i < CASES; i++) {
      const family = FAMILIES[Math.floor(rnd() * FAMILIES.length)]!;
      const { raw, label } = rawInput(rnd, i);
      const ctx = `seed=0x${SEED.toString(16)} case=${i} family=${family} ${label} raw=${preview(raw)}`;
      const allowed = QUIRKS[family]?.malformedArguments ?? QUIRKS["local-small"]!.malformedArguments;

      // 1. Without a repair port.
      let r: Awaited<ReturnType<typeof prepareCall>>;
      try { r = await prepareCall("fuzz.tool", SCHEMA, raw, undefined, family); } catch (e) { assert.fail(`${ctx}: prepareCall threw ${String(e)}`); }
      assert.equal(r.repairRounds, 0, `${ctx}: no port, no round`);
      for (const rep of r.repairs) assert.ok(allowed.includes(rep.kind), `${ctx}: repair ${rep.kind} is not allowed for ${family}`);
      if (r.ok) {
        accepted++; if (r.repairs.length) repairedByLocal++;
        assert.deepEqual(validateArguments(SCHEMA, r.arguments), [], `${ctx}: accepted arguments do not re-validate`);
        assert.deepEqual(JSON.parse(JSON.stringify(r.arguments)), r.arguments, `${ctx}: accepted arguments are not plain JSON`);
        assert.equal(Object.getPrototypeOf(r.arguments), Object.prototype, `${ctx}: prototype`);
        assert.equal(({} as Record<string, unknown>)["polluted"], undefined, `${ctx}: prototype pollution`);
      } else {
        rejected++;
        assert.equal(r.error.code, "tool-call-invalid", ctx); assert.equal(r.error.message, "Invalid arguments for fuzz.tool", ctx);
        assert.ok(typeof r.error.hint === "string" && r.error.hint.length > 0, ctx);
        const issues = r.error.issues ?? [];
        assert.ok(issues.length >= 1, `${ctx}: error without issues`);
        for (const issue of issues as ValidationIssue[]) {
          assert.ok(typeof issue.path === "string" && (issue.path === "" || issue.path.startsWith("/")), `${ctx}: path ${issue.path}`);
          assert.ok(typeof issue.expected === "string" && issue.expected.length > 0, ctx);
          assert.ok(typeof issue.message === "string" && issue.message.length > 0, ctx);
          assert.ok(typeof issue.got === "string" && issue.got.length <= 80, `${ctx}: got is ${issue.got.length} chars`);
        }
      }
      assert.deepEqual(await prepareCall("fuzz.tool", SCHEMA, raw, undefined, family), r, `${ctx}: not deterministic`);

      // 2. With a repair port that answers from the seeded stream.
      const answer = rnd();
      let calls = 0;
      const port = async (req: { tool: string; issues: ValidationIssue[] }) => {
        calls++;
        assert.equal(req.tool, "fuzz.tool", ctx); assert.ok(req.issues.length >= 1, `${ctx}: repair asked without issues`);
        if (answer < .35) return validArgs(mulberry32(i + 1));
        if (answer < .5) return JSON.stringify(validArgs(mulberry32(i + 2)));
        if (answer < .65) throw new Error("repair port failure");
        if (answer < .8) return { nope: true };
        if (answer < .9) return undefined;
        return "{broken";
      };
      let withPort: Awaited<ReturnType<typeof prepareCall>>;
      try { withPort = await prepareCall("fuzz.tool", SCHEMA, raw, port, family); } catch (e) { assert.fail(`${ctx}: prepareCall with repair port threw ${String(e)}`); }
      assert.ok(calls <= 1, `${ctx}: repair port called ${calls} times`);
      assert.ok(withPort.repairRounds === 0 || withPort.repairRounds === 1, ctx);
      assert.equal(withPort.repairRounds, calls, `${ctx}: repairRounds must equal port calls`);
      if (r.ok) {
        assert.equal(calls, 0, `${ctx}: a valid first attempt must not ask the model`);
        assert.deepEqual(withPort, r, ctx);
      } else {
        assert.equal(calls, 1, `${ctx}: an invalid first attempt gets exactly one model round`);
        modelRounds++;
        if (withPort.ok) { acceptedAfterModel++; assert.deepEqual(validateArguments(SCHEMA, withPort.arguments), [], ctx); }
        else assert.equal(withPort.error.code, "tool-call-invalid", ctx);
      }
    }
    // The generator must exercise both outcomes, the local repairs and the model round; otherwise the invariants prove little.
    assert.ok(accepted > 300, `seed=0x${SEED.toString(16)}: only ${accepted} accepted cases`);
    assert.ok(rejected > 300, `seed=0x${SEED.toString(16)}: only ${rejected} rejected cases`);
    assert.ok(repairedByLocal > 20, `seed=0x${SEED.toString(16)}: only ${repairedByLocal} locally repaired cases`);
    assert.ok(modelRounds > 300 && acceptedAfterModel > 30, `seed=0x${SEED.toString(16)}: model rounds ${modelRounds}, accepted after model ${acceptedAfterModel}`);
  });

  it("metamorphic: any valid document accepted in one spelling is accepted in every spelling (pretty, reordered keys, escaped Unicode), for every family", async () => {
    const rnd = mulberry32(SEED + 1);
    for (let i = 0; i < 300; i++) {
      const args = validArgs(rnd);
      const keys = Object.keys(args); for (let j = keys.length - 1; j > 0; j--) { const k = Math.floor(rnd() * (j + 1)); [keys[j], keys[k]] = [keys[k]!, keys[j]!]; }
      const shuffled = Object.fromEntries(keys.map(k => [k, args[k]]));
      const spellings = [JSON.stringify(args), JSON.stringify(shuffled, null, 2), JSON.stringify(shuffled).replace(/[^\u0000-\u007f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`), args as unknown];
      for (const family of FAMILIES) for (const raw of spellings) {
        const r = await prepareCall("fuzz.tool", SCHEMA, raw, undefined, family);
        const ctx = `seed=0x${(SEED + 1).toString(16)} case=${i} family=${family}`;
        assert.equal(r.ok, true, ctx); assert.deepEqual(r.ok ? r.arguments : null, args, ctx); assert.deepEqual(r.repairs, [], ctx);
      }
    }
  });

  it("every one of 300 single-field corruptions of a valid document is rejected with an issue that points at (or into) that field", async () => {
    const rnd = mulberry32(SEED + 2);
    const corruptions: [string, (a: Record<string, unknown>) => unknown, string][] = [
      ["count float", a => ({ ...a, count: 2.5 }), "/count"], ["count too big", a => ({ ...a, count: 101 }), "/count"], ["count negative", a => ({ ...a, count: -1 }), "/count"],
      ["count text", a => ({ ...a, count: "lots" }), "/count"], ["path empty", a => ({ ...a, path: "" }), "/path"], ["path long", a => ({ ...a, path: "x".repeat(41) }), "/path"],
      ["path number", a => ({ ...a, path: 5 }), "/path"], ["mode other", a => ({ ...a, mode: "x" }), "/mode"], ["flag text", a => ({ ...a, flag: "yes" }), "/flag"],
      ["tags dup", a => ({ ...a, tags: ["a", "a"] }), "/tags"], ["tags too many", a => ({ ...a, tags: ["a", "b", "c", "d", "e"] }), "/tags"], ["tag too long", a => ({ ...a, tags: ["123456789"] }), "/tags/0"],
      ["nested missing k", a => ({ ...a, nested: {} }), "/nested/k"], ["nested extra", a => ({ ...a, nested: { k: 1, z: 1 } }), "/nested/z"], ["ratio zero", a => ({ ...a, ratio: 0 }), "/ratio"],
      ["extra key", a => ({ ...a, bogus: 1 }), "/bogus"], ["missing path", a => { const { path: _p, ...rest } = a; return rest; }, "/path"], ["missing count", a => { const { count: _c, ...rest } = a; return rest; }, "/count"],
    ];
    for (let i = 0; i < 300; i++) {
      const [label, corrupt, pointerPrefix] = corruptions[Math.floor(rnd() * corruptions.length)]!;
      const args = validArgs(rnd);
      const mutated = corrupt(args);
      for (const raw of [mutated, JSON.stringify(mutated)]) {
        const r = await prepareCall("fuzz.tool", SCHEMA, raw, undefined, "anthropic");
        const ctx = `seed=0x${(SEED + 2).toString(16)} case=${i} ${label}`;
        assert.equal(r.ok, false, `${ctx}: corruption accepted`);
        if (!r.ok) assert.ok((r.error.issues ?? []).some(x => x.path === pointerPrefix || x.path.startsWith(pointerPrefix + "/")), `${ctx}: no issue under ${pointerPrefix}: ${JSON.stringify(r.error.issues)}`);
      }
    }
  });
});
