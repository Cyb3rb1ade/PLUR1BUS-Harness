import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { verifyApiDelegation, validApiPrincipal, apiPrincipal, bindApiPrincipal } from "../src/api-principal.ts";

test("a separate API credential is needed; missing identity remains absent and agents stay agents", () => {
  const token = randomBytes(32).toString("hex"), local = randomBytes(32).toString("hex");
  const person = { userId: "alice", kind: "person", role: "member" };
  assert.throws(() => verifyApiDelegation({ clientId: "harness-api", token: local, principal: person }, token));
  assert.throws(() => verifyApiDelegation({ clientId: "other-client", token, principal: person }, token));
  assert.equal(verifyApiDelegation({ clientId: "harness-api", token }, token), null);
  assert.deepEqual(verifyApiDelegation({ clientId: "harness-api", token, principal: person }, token), person);
  const agent = { ...person, kind: "agent" };
  assert.deepEqual(verifyApiDelegation({ clientId: "harness-api", token, principal: agent }, token), agent);
  assert.equal(validApiPrincipal({ ...person, breakGlass: [] }), false);
  assert.equal(validApiPrincipal({ ...person, role: "root" }), false);
  const ctx = { connectionId: "c", requestId: "r", signal: new AbortController().signal };
  assert.equal(apiPrincipal(ctx), undefined); bindApiPrincipal(ctx, null); assert.equal(apiPrincipal(ctx), null);
});
