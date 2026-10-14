import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateArgs, callWithRepair, type RepairRequest } from "../../src/tools/repair.ts";

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["url"],
  properties: {
    url: { type: "string", minLength: 1, maxLength: 20 },
    mode: { enum: ["auto", "raw"] },
    maxTokens: { type: "integer", minimum: 100, maximum: 1000 },
    crawl: { type: "boolean" },
    tags: { type: "array", maxItems: 2, items: { type: "string" } },
  },
} as const;

describe("repair: validateArgs", () => {
  it("accepts valid arguments", () => {
    assert.deepEqual(validateArgs(schema, { url: "x", mode: "raw", maxTokens: 100, crawl: true, tags: ["a"] }), []);
  });
  it("reports every problem with a path, what was expected and what came", () => {
    const issues = validateArgs(schema, { mode: "fast", maxTokens: "lots", crawl: "yes", extra: 1, tags: ["a", "b", "c", 5] });
    const by = (path: string) => issues.find((i) => i.path === path);
    assert.ok(by("/url")?.message.includes("required"));
    assert.ok(by("/mode")?.expected.includes("auto"));
    assert.equal(by("/maxTokens")?.expected, "integer");
    assert.equal(by("/maxTokens")?.got, "string");
    assert.equal(by("/crawl")?.expected, "boolean");
    assert.ok(by("/extra")?.message.includes("unknown"));
    assert.ok(by("/tags")?.message.includes("at most 2"));
    assert.ok(by("/tags/3")?.expected === "string");
  });
  it("bounds: numbers and string length", () => {
    assert.equal(validateArgs(schema, { url: "x", maxTokens: 99 })[0]?.path, "/maxTokens");
    assert.equal(validateArgs(schema, { url: "x", maxTokens: 100.5 })[0]?.expected, "integer");
    assert.equal(validateArgs(schema, { url: "x".repeat(21) })[0]?.path, "/url");
    assert.equal(validateArgs(schema, { url: "" })[0]?.path, "/url");
  });
  it("non-object arguments are one issue at the root", () => {
    for (const bad of [null, 5, "x", [1]]) assert.equal(validateArgs(schema, bad)[0]?.path, "");
  });
  it("never echoes long values back", () => {
    const issues = validateArgs(schema, { url: "x", mode: "q".repeat(5000) });
    assert.ok(issues[0]!.got.length < 80);
  });
});

describe("repair: callWithRepair (D97 item 1)", () => {
  const mkTool = () => {
    const calls: unknown[] = [];
    return { calls, tool: { name: "t", inputSchema: schema as unknown as Record<string, unknown>, execute: async (a: unknown) => (calls.push(a), { ok: a }) } };
  };

  it("valid arguments execute directly; the hook is never consulted", async () => {
    const { tool, calls } = mkTool();
    const out = await callWithRepair(tool, { url: "x" }, { repair: async () => assert.fail("no repair needed") });
    assert.deepEqual(out, { repairRounds: 0, result: { ok: { url: "x" } } });
    assert.equal(calls.length, 1);
  });

  it("invalid arguments are NOT executed; one structured repair round, then executed", async () => {
    const { tool, calls } = mkTool();
    const reqs: RepairRequest[] = [];
    const out = await callWithRepair(tool, { url: "x", maxTokens: "5000" }, {
      repair: async (req) => {
        reqs.push(req);
        return { url: "x", maxTokens: 500 };
      },
    });
    assert.equal(reqs.length, 1);
    assert.equal(reqs[0]!.tool, "t");
    assert.equal(reqs[0]!.issues[0]!.path, "/maxTokens");
    assert.match(reqs[0]!.message, /maxTokens/);
    assert.deepEqual(out, { repairRounds: 1, result: { ok: { url: "x", maxTokens: 500 } } });
    assert.deepEqual(calls, [{ url: "x", maxTokens: 500 }]);
  });

  it("a second failure yields tool-call-invalid and never executes", async () => {
    const { tool, calls } = mkTool();
    let rounds = 0;
    const out = await callWithRepair(tool, { nope: 1 }, { repair: async () => (rounds++, { still: "wrong" }) });
    assert.equal(rounds, 1, "exactly one round");
    assert.equal(calls.length, 0);
    assert.equal(out.repairRounds, 1);
    const r = out.result as { isError: boolean; error: { code: string; issues: unknown[]; hint: string } };
    assert.equal(r.isError, true);
    assert.equal(r.error.code, "tool-call-invalid");
    assert.ok(r.error.issues.length > 0);
    assert.ok(r.error.hint.length > 0);
  });

  it("no hook, a hook that throws or returns nothing: tool-call-invalid, never a crash", async () => {
    const { tool, calls } = mkTool();
    for (const repair of [undefined, async () => { throw new Error("model down"); }, async () => undefined]) {
      const out = await callWithRepair(tool, {}, repair ? { repair } : {});
      assert.equal((out.result as { error: { code: string } }).error.code, "tool-call-invalid");
      assert.ok(!JSON.stringify(out).includes("model down"));
    }
    assert.equal(calls.length, 0);
  });

  it("a thrown tool error is not swallowed here (the tool turns its own failures into results)", async () => {
    const tool = { name: "t", inputSchema: schema as unknown as Record<string, unknown>, execute: async () => { throw new Error("boom"); } };
    await assert.rejects(callWithRepair(tool, { url: "x" }, {}), /boom/);
  });
});

describe("validateArgs: prototype names and unchecked branches", () => {
  it("a required property is not satisfied by an inherited one, and an own __proto__ key is unknown", () => {
    const s = { type: "object", additionalProperties: false, required: ["toString"], properties: { toString: { type: "string" } } };
    assert.equal(validateArgs(s, {}).length, 1);
    assert.equal(validateArgs(s, { toString: "x" }).length, 0);
    const polluted = JSON.parse('{"toString":"x","__proto__":{"admin":true}}') as unknown;
    const issues = validateArgs(s, polluted);
    assert.deepEqual(issues.map((i) => i.path), ["/__proto__"]);
  });
  it("enum is exact (no coercion), integers reject floats and NaN/Infinity, arrays check count and items", () => {
    const s = { type: "object", properties: { e: { enum: [1, "a", null] }, n: { type: "integer", minimum: -5, maximum: 5 }, a: { type: "array", minItems: 1, maxItems: 2, items: { type: "string" } } } };
    assert.equal(validateArgs(s, { e: "1" }).length, 1);
    assert.equal(validateArgs(s, { e: null }).length, 0);
    for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY, -6, 6, "3"]) assert.equal(validateArgs(s, { n: bad }).length, 1, String(bad));
    assert.equal(validateArgs(s, { n: -5 }).length, 0);
    assert.equal(validateArgs(s, { a: [] }).length, 1);
    assert.equal(validateArgs(s, { a: ["x", "y", "z"] }).length, 1);
    assert.deepEqual(validateArgs(s, { a: ["x", 2] }).map((i) => i.path), ["/a/1"]);
  });
  it("arguments that are not an object are reported once at the root", () => {
    for (const bad of [null, [], "x", 3, undefined]) assert.deepEqual(validateArgs(schema, bad).map((i) => i.path), [""], String(bad));
  });
});
