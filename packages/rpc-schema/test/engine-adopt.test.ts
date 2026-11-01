import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { engineRpcSurface } from "../src/engine-contract.mjs";
import { RPC_VERSION } from "../src/index.ts";
// Freeze already published introductions without assigning an old version to future methods.
import engineMethodVersions from "../fixtures/engine-method-versions.json" with { type: "json" };

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
    for (const [name, since] of Object.entries(engineMethodVersions))
      assert.equal((methods[name] as Record<string, unknown>)["x-since"], since, name);
  });

  it("publishes engine adoption under the current RPC version at or after its introduction", () => {
    const schema = JSON.parse(readFileSync(new URL("../schema/rpc.schema.json", import.meta.url), "utf8"));
    const [major = 0, minor = 0] = RPC_VERSION.split(".").map(Number);
    assert.ok(major > 1 || (major === 1 && minor >= 17), RPC_VERSION);
    assert.equal(schema["x-rpc-version"], RPC_VERSION);
    assert.equal(schema.$id, `https://plur1bus.dev/schema/rpc/${RPC_VERSION}/rpc.schema.json`);
    assert.equal(schema.title, `PLUR1BUS harness RPC ${RPC_VERSION}`);
    assert.deepEqual(schema.$defs.methods["engine.adopt"], engineRpcSurface().methods["engine.adopt"]);
  });
});
