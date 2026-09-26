import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateErrorObject } from "@plur1bus/rpc-schema";
import { RpcError } from "../src/rpc/errors.ts";

describe("RpcError", () => {
  it("RpcError serialises ids only when present", () => {
    const plain = new RpcError("E_NOT_FOUND", "no such memory", { reason: "not-found" }).toJSON();
    assert.deepEqual(plain, { code: -32000, message: "no such memory", data: { error: "E_NOT_FOUND", reason: "not-found" } });
    const empty = new RpcError("E_NOT_FOUND", "no such memory", { reason: "not-found", ids: {} }).toJSON();
    assert.equal("ids" in empty.data, false, "an empty ids map is omitted");
    const withIds = new RpcError("E_STORAGE", "shared copy refresh failed", { reason: "storage", ids: { sourceId: "m-src", sharedId: "m-copy" } });
    assert.deepEqual(withIds.ids, { sourceId: "m-src", sharedId: "m-copy" });
    const json = withIds.toJSON();
    assert.deepEqual(json, { code: -32000, message: "shared copy refresh failed", data: { error: "E_STORAGE", reason: "storage", ids: { sourceId: "m-src", sharedId: "m-copy" } } });
    assert.deepEqual(validateErrorObject(json), { ok: true });
  });

  it("maps the five memory-op codes to -32000", () => {
    for (const code of ["E_NOT_FOUND", "E_DENIED", "E_APPROVAL_REQUIRED", "E_CONFLICT", "E_STORAGE"] as const) {
      assert.equal(new RpcError(code, "x").jsonrpcCode, -32000, code);
    }
  });

  it("refuses a code outside the closed enum", () => {
    assert.throws(() => new RpcError("E_NOPE" as any, "x"), /unknown error code/);
  });
});
