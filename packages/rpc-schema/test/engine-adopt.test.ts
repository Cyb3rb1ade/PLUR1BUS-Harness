import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { engineRpcSurface } from "../src/engine-contract.mjs";

describe("engine process adoption contract", () => {
  it("adds the supervisor nonce exchange without changing existing engine method versions", () => {
    const { methods } = engineRpcSurface();
    const { description: _description, ...adopt } = (methods["engine.adopt"] ?? {}) as Record<string, unknown>;
    assert.deepEqual(adopt, {
      "x-server": "engine",
      "x-stability": "experimental",
      "x-since": "1.17.0",
      params: {
        type: "object",
        additionalProperties: false,
        required: ["nonce"],
        properties: { nonce: { type: "string", minLength: 64, maxLength: 64 } },
      },
      result: {
        type: "object",
        additionalProperties: false,
        required: ["status"],
        properties: { status: { $ref: "#/$defs/EngineProcessStatus" } },
      },
    });
    for (const [name, method] of Object.entries(methods) as [string, any][])
      if (name !== "engine.adopt") assert.equal(method["x-since"], "1.7.0", name);
  });

  it("publishes the additive engine adoption method under the reserved RPC version", () => {
    const schema = JSON.parse(readFileSync(new URL("../schema/rpc.schema.json", import.meta.url), "utf8"));
    assert.equal(schema["x-rpc-version"], "1.17.0");
    assert.equal(schema.$id, "https://plur1bus.dev/schema/rpc/1.17.0/rpc.schema.json");
    assert.equal(schema.title, "PLUR1BUS harness RPC 1.17.0");
    assert.deepEqual(schema.$defs.methods["engine.adopt"], engineRpcSurface().methods["engine.adopt"]);
  });
});
