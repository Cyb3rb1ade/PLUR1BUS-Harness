import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry, RegistryError, HARD_MAX_TIMEOUT_MS, HARD_MAX_RESULT_BYTES, type ToolDef } from "../../src/tools/registry.ts";

const schema = { type: "object", additionalProperties: false, required: ["q"], properties: { q: { type: "string" } } };
const tool = (o: Partial<ToolDef> = {}): ToolDef => ({
  name: "demo.echo", description: "echo", inputSchema: schema, capability: "sys.read", effect: "read", risk: "low",
  execute: async (a) => a, ...o,
});
const rejects = (d: ToolDef, reason: string) => {
  assert.throws(() => new ToolRegistry().register(d), (e: unknown) => e instanceof RegistryError && e.reason === reason, reason);
};

describe("ToolRegistry", () => {
  it("registers, resolves and lists tools sorted, with defaults applied to limits", () => {
    const r = new ToolRegistry();
    r.register(tool({ name: "b.tool" })); r.register(tool({ name: "a.tool", limits: { timeoutMs: 50 } }));
    assert.equal(r.get("a.tool")?.limits.timeoutMs, 50);
    assert.ok(r.get("b.tool")!.limits.maxResultBytes > 0);
    assert.deepEqual(r.describe().map((t) => t.name), ["a.tool", "b.tool"]);
    assert.equal(r.get("nope"), undefined);
    assert.equal(r.size, 2);
  });
  it("describe() leaks nothing executable", () => {
    const r = new ToolRegistry(); r.register(tool());
    assert.deepEqual(Object.keys(r.describe()[0]!).sort(), ["description", "inputSchema", "name", "risk"]);
  });
  it("fails closed on a bad definition", () => {
    rejects(tool({ name: "Bad Name" }), "name");
    rejects(tool({ name: "" }), "name");
    rejects(tool({ description: "" }), "description");
    rejects(tool({ inputSchema: { type: "string" } }), "schema");
    rejects(tool({ capability: "nope.cap" }), "capability");
    rejects(tool({ effect: "bogus" as never }), "effect");
    rejects(tool({ risk: "bogus" as never }), "risk");
    rejects(tool({ capability: "fs.delete", effect: "local-destructive", risk: "low" }), "risk"); // below the capability's base risk
    rejects(tool({ effect: "read", capability: "fs.delete" }), "effect"); // below the capability's intrinsic effect
    rejects(tool({ limits: { timeoutMs: 0 } }), "limits");
    rejects(tool({ limits: { timeoutMs: HARD_MAX_TIMEOUT_MS + 1 } }), "limits");
    rejects(tool({ limits: { maxResultBytes: HARD_MAX_RESULT_BYTES + 1 } }), "limits");
  });
  it("refuses a duplicate name, also by case", () => {
    const r = new ToolRegistry(); r.register(tool());
    assert.throws(() => r.register(tool()), (e: unknown) => e instanceof RegistryError && e.reason === "duplicate");
  });
  it("the registry holds a frozen copy: mutating the input afterwards changes nothing", () => {
    const r = new ToolRegistry(); const d = tool(); r.register(d);
    d.risk = "critical"; (d.inputSchema as { required: string[] }).required.push("x");
    assert.equal(r.get("demo.echo")!.risk, "low");
    assert.deepEqual((r.get("demo.echo")!.inputSchema as { required: string[] }).required, ["q"]);
    assert.ok(Object.isFrozen(r.get("demo.echo")));
  });
});
