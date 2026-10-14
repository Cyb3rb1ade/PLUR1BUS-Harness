import test from "node:test";
import assert from "node:assert/strict";
import { bindApiPrincipal } from "@plur1bus/module-api";
import { apiIdentities } from "../../src/rpc/api-identity.ts";

test("explicit missing API identity never falls back to a cached person or the local-owner compatibility resolver", () => {
  const identities = apiIdentities(p => p);
  const ctx = { connectionId: "api", requestId: "missing", signal: new AbortController().signal };
  assert.equal(identities.resolve(ctx), undefined, "ordinary local connection keeps its compatibility resolver");
  identities.authenticated("api", { userId: "alice", kind: "person", role: "owner" });
  assert.equal(identities.resolve(ctx)?.userId, "alice");
  bindApiPrincipal(ctx, null);
  assert.equal(identities.resolve(ctx), null, "explicit request-level absence wins over the cached person");
  identities.closed("api");
  assert.equal(identities.resolve(ctx), null, "explicit absence remains denied after disconnect");
});
