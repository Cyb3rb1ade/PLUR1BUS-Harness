import test from "node:test";
import assert from "node:assert/strict";
import { bindApiPrincipal, RpcError } from "@plur1bus/module-api";
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

test("stopping identity resolution refuses before consulting a store that shutdown can close", () => {
  let stopping = false, reads = 0;
  const identities = apiIdentities(p => { reads++; return p; }, () => stopping);
  const principal = { userId: "alice", kind: "person", role: "owner" } as const;
  assert.equal(identities.forwarded(principal)?.userId, "alice");
  stopping = true;
  assert.throws(() => identities.forwarded(principal),
    e => e instanceof RpcError && e.error === "E_NOT_AVAILABLE" && e.reason === "stopping");
  assert.equal(reads, 1, "shutdown cannot turn a closed identity database into a false authentication failure");
});
