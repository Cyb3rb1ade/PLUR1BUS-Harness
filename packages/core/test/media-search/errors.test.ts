import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RpcError } from "../../src/rpc/errors.ts";
import { mediaError } from "../../src/media-search/errors.ts";

describe("mediaError", () => {
  it("returns an RpcError carrying the media code", () => {
    const e = mediaError("E_MEDIA_DIMENSION", "bad dim", { reason: "dim" });
    assert.ok(e instanceof RpcError);
    assert.equal(e.error, "E_MEDIA_DIMENSION");
    assert.equal(e.message, "bad dim");
    assert.equal(e.reason, "dim");
  });
});
