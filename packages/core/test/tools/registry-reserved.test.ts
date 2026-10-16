import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry, RegistryError, type ToolDef } from "../../src/tools/registry.ts";
import { METHODS } from "@plur1bus/rpc-schema";

const schema = { type: "object", additionalProperties: false, properties: {} };
const tool = (name: string, o: Partial<ToolDef> = {}): ToolDef => ({
  name, description: "x", inputSchema: schema, capability: "sys.read", effect: "read", risk: "low",
  execute: async (a) => a, ...o,
});

describe("ToolRegistry reserved names from RPC schema", () => {
  it("refuses a name that collides with a harness RPC method (grant.create)", () => {
    assert.ok(METHODS.includes("grant.create"));
    assert.throws(
      () => new ToolRegistry().register(tool("grant.create")),
      (e: unknown) => e instanceof RegistryError && (e as RegistryError).reason === "reserved",
    );
  });
  it("refuses approval.decide", () => {
    assert.throws(
      () => new ToolRegistry().register(tool("approval.decide")),
      (e: unknown) => e instanceof RegistryError && (e as RegistryError).reason === "reserved",
    );
  });
  it("still accepts a first-party tool name that is also an RPC method (media.generate) and a normal tool name", () => {
    const r = new ToolRegistry();
    r.register(tool("demo.echo"));
    r.register(tool("media.generate", { capability: "net.submit", effect: "money", risk: "high" }));
    assert.equal(r.size, 2);
  });
});
