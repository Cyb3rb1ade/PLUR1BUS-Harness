import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { verifyApiDelegation, validApiPrincipal, apiPrincipal, apiTransport, bindApiPrincipal } from "../src/api-principal.ts";

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

test("transport is a closed delegation fact, separate from person authority", () => {
  const token = randomBytes(32).toString("hex"), principal = { userId: "alice", kind: "person", role: "admin" };
  for (const transport of ["loopback", "remote"]) assert.deepEqual(verifyApiDelegation({ clientId: "harness-api", token, principal, transport }, token), principal);
  for (const transport of [true, "desktop", "", { loopback: true }]) assert.throws(() => verifyApiDelegation({ clientId: "harness-api", token, principal, transport }, token));
  assert.equal(validApiPrincipal({ ...principal, transport: "loopback" }), false);
  const forged = { requestId: "r", connectionId: "c", signal: new AbortController().signal, transport: "loopback", principal: { ...principal, transport: "loopback" } };
  assert.equal(apiTransport(forged), undefined);
});

test("M6A-S9: validApiPrincipal accepts aligned token bindings with groups and freer agent IDs", () => {
  const base = { userId: "alice", kind: "agent" as const, role: "member" as const };
  // Freer agentId up to 128 characters with dots and colons
  const longAgentId = "agent.workspace:sub-agent-with-long-name-1234567890-abcdefghijklmnopqrstuvwxyz";
  assert.equal(validApiPrincipal({
    ...base,
    binding: {
      audience: "mcp",
      agentId: longAgentId,
      groups: ["memory", "agent"],
    },
  }), true);

  // Binding with projectId and system
  assert.equal(validApiPrincipal({
    ...base,
    binding: {
      audience: "a2a",
      agentId: "main",
      projectId: "proj-123",
      system: "system-instruction",
    },
  }), true);

  // Control characters rejected
  assert.equal(validApiPrincipal({
    ...base,
    binding: {
      audience: "mcp",
      agentId: "agent\0null",
    },
  }), false);
});
