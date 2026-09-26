import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertEngineContract } from "../src/engine.ts";
import { RpcError } from "../src/rpc/errors.ts";

// The engine's own `ContractVersion` type is pinned to the literal `"1.6.0"` at the current pin,
// so these fixtures (deliberately mismatched or malformed) are widened to plain strings — exactly
// what `assertEngineContract` must guard against at runtime, where the engine's declared type is
// no guarantee against a differently-pinned build.
function fixture(contract: string): Parameters<typeof assertEngineContract>[0] {
  return { contract } as Parameters<typeof assertEngineContract>[0];
}

describe("assertEngineContract", () => {
  it("accepts 1.6.0 and 1.99.0", () => {
    assert.doesNotThrow(() => assertEngineContract(fixture("1.6.0")));
    assert.doesNotThrow(() => assertEngineContract(fixture("1.99.0")));
  });

  it("refuses 2.0.0 with E_RPC_VERSION engine-contract-major", () => {
    try {
      assertEngineContract(fixture("2.0.0"));
      assert.fail("expected assertEngineContract to throw");
    } catch (e) {
      assert.ok(e instanceof RpcError);
      const err = e as RpcError;
      assert.equal(err.error, "E_RPC_VERSION");
      assert.equal(err.reason, "engine-contract-major");
      assert.equal(err.detail, "2.0.0");
    }
  });

  it("refuses a non-semver contract", () => {
    for (const bad of ["1.6", ""]) {
      try {
        assertEngineContract(fixture(bad));
        assert.fail(`expected assertEngineContract to throw for ${JSON.stringify(bad)}`);
      } catch (e) {
        assert.ok(e instanceof RpcError);
        const err = e as RpcError;
        assert.equal(err.error, "E_RPC_VERSION");
        assert.equal(err.reason, "engine-contract-major");
        assert.equal(err.detail, bad);
      }
    }
  });
});
