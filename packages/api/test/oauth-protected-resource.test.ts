import test from "node:test";
import assert from "node:assert/strict";
import { addUser, jsonHeaders, loginAs, raw, start, type Harness } from "./helpers.ts";
import type { OAuthClientMetadata } from "../src/oauth/types.ts";
import { computeCodeChallenge } from "../src/oauth/pkce.ts";
import { MemoryTokenStore } from "../src/memory-stores.ts";
import { TokenService } from "../src/tokens.ts";
import { FakeClock } from "../src/clock.ts";

const STATIC_CLIENT: OAuthClientMetadata = {
  client_id: "test-client",
  client_name: "Test OAuth Client",
  redirect_uris: ["https://client.example.com/callback"],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  scope: "mcp.read mcp.write a2a.task",
  token_endpoint_auth_method: "none",
};

const wide = {
  auth: { capacity: 1000, refillPerSec: 100 },
  read: { capacity: 1000, refillPerSec: 100 },
  write: { capacity: 1000, refillPerSec: 100 },
  rpc: { capacity: 1000, refillPerSec: 100 },
};

test("M6A-A3.3: GET /.well-known/oauth-protected-resource returns general RFC 9728 metadata", async (t) => {
  const h = await start({ rateClasses: wide });
  t.after(() => h.close());

  const res = await raw(h, {
    method: "GET",
    path: "/.well-known/oauth-protected-resource",
    headers: { host: `127.0.0.1:${h.port}` },
  });

  assert.equal(res.status, 200);
  const data = res.json as Record<string, unknown>;
  assert.equal(data.resource, `http://127.0.0.1:${h.port}`);
  assert.deepEqual(data.authorization_servers, [`http://127.0.0.1:${h.port}`]);
  assert.deepEqual(data.bearer_methods_supported, ["header"]);
  const scopes = data.scopes_supported as string[];
  assert.ok(scopes.includes("mcp.read"));
  assert.ok(scopes.includes("a2a.task"));
  assert.ok(scopes.includes("agent.use"));
});

test("M6A-A3.3: GET /.well-known/oauth-protected-resource?resource=... filters by target resource", async (t) => {
  const h = await start({ rateClasses: wide });
  t.after(() => h.close());

  // 1. MCP resource query
  const mcpRes = await raw(h, {
    method: "GET",
    path: `/.well-known/oauth-protected-resource?resource=${encodeURIComponent(`http://127.0.0.1:${h.port}/mcp`)}`,
    headers: { host: `127.0.0.1:${h.port}` },
  });

  assert.equal(mcpRes.status, 200);
  const mcpData = mcpRes.json as Record<string, unknown>;
  assert.equal(mcpData.resource, `http://127.0.0.1:${h.port}/mcp`);
  assert.ok((mcpData.resource_documentation as string).includes("mcp-server.md"));
  const mcpScopes = mcpData.scopes_supported as string[];
  assert.ok(mcpScopes.includes("mcp.read"));
  assert.ok(mcpScopes.includes("mcp.write"));
  assert.ok(!mcpScopes.includes("a2a.task"));

  // 2. A2A resource query
  const a2aRes = await raw(h, {
    method: "GET",
    path: `/.well-known/oauth-protected-resource?resource=${encodeURIComponent(`http://127.0.0.1:${h.port}/a2a`)}`,
    headers: { host: `127.0.0.1:${h.port}` },
  });

  assert.equal(a2aRes.status, 200);
  const a2aData = a2aRes.json as Record<string, unknown>;
  assert.equal(a2aData.resource, `http://127.0.0.1:${h.port}/a2a`);
  assert.ok((a2aData.resource_documentation as string).includes("a2a.md"));
  const a2aScopes = a2aData.scopes_supported as string[];
  assert.ok(a2aScopes.includes("a2a.task"));
  assert.ok(!a2aScopes.includes("mcp.read"));
});

test("M6A-A3.3: 401 on unauthenticated protocol route advertises WWW-Authenticate resource_metadata", async (t) => {
  const h = await start({ rateClasses: wide });
  t.after(() => h.close());

  const res = await raw(h, {
    method: "POST",
    path: "/mcp",
    headers: { host: `127.0.0.1:${h.port}` },
  });

  assert.equal(res.status, 401);
  const authHeader = res.headers["www-authenticate"];
  assert.ok(authHeader);
  assert.match(authHeader, /^Bearer /);
  assert.ok(authHeader.includes(`resource_metadata="http://127.0.0.1:${h.port}/.well-known/oauth-protected-resource"`));
});

test("M6A-A3.3: audience enforcement rejects cross-resource tokens with 401 invalid-audience", async (t) => {
  const clock = new FakeClock();
  const tokenStore = new MemoryTokenStore();
  const tokens = new TokenService({ store: tokenStore, clock });

  const h = await start({
    clock,
    tokens: tokenStore,
    rateClasses: wide,
    mcpConfig: {
      mcpServer: { enabled: true },
      agents: { main: { mcpServer: { exposed: true } } },
    },
  });
  t.after(() => h.close());

  // Create user and an a2a-bound token
  await addUser(h, { id: "user1", username: "user1", role: "member" });
  const a2aToken = await tokens.create("user1", {
    name: "a2a-test-token",
    scopes: ["agent.use"],
    binding: { audience: "a2a", agentId: "main" },
  });

  // Try to use a2a token on /mcp endpoint
  const res = await raw(h, {
    method: "POST",
    path: "/mcp",
    headers: {
      host: `127.0.0.1:${h.port}`,
      authorization: `Bearer ${a2aToken.token}`,
      "content-type": "application/json",
      "mcp-protocol-version": "2026-07-28",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: { _meta: { protocolVersion: "2026-07-28" } },
    }),
  });

  assert.equal(res.status, 401);
  const body = res.json as Record<string, unknown>;
  assert.equal(body.reason, "invalid-audience");
  assert.match(res.headers["www-authenticate"] ?? "", /Bearer /);
});

test("M6A-A3.3: scope leak prevention rejects cross-audience scope requests", async (t) => {
  const h = await start({
    rateClasses: wide,
    oauthClients: { "test-client": STATIC_CLIENT },
  });
  t.after(() => h.close());

  await addUser(h, { id: "alice", username: "alice", role: "member" });
  const { cookie } = await loginAs(h, "alice");

  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = computeCodeChallenge(verifier);

  // 1. Requesting a2a.task for MCP resource is rejected with invalid_scope
  const mcpScopeRes = await raw(h, {
    method: "GET",
    path: `/oauth/authorize?response_type=code&client_id=test-client&redirect_uri=${encodeURIComponent("https://client.example.com/callback")}&code_challenge=${challenge}&code_challenge_method=S256&resource=/mcp&scope=${encodeURIComponent("mcp.read a2a.task")}`,
    headers: {
      cookie,
      host: `127.0.0.1:${h.port}`,
    },
  });

  assert.equal(mcpScopeRes.status, 302);
  const mcpLocation = new URL(mcpScopeRes.headers["location"]!);
  assert.equal(mcpLocation.searchParams.get("error"), "invalid_scope");

  // 2. Requesting mcp.read for A2A resource is rejected with invalid_scope
  const a2aScopeRes = await raw(h, {
    method: "GET",
    path: `/oauth/authorize?response_type=code&client_id=test-client&redirect_uri=${encodeURIComponent("https://client.example.com/callback")}&code_challenge=${challenge}&code_challenge_method=S256&resource=/a2a&scope=${encodeURIComponent("a2a.task mcp.read")}`,
    headers: {
      cookie,
      host: `127.0.0.1:${h.port}`,
    },
  });

  assert.equal(a2aScopeRes.status, 302);
  const a2aLocation = new URL(a2aScopeRes.headers["location"]!);
  assert.equal(a2aLocation.searchParams.get("error"), "invalid_scope");
});
