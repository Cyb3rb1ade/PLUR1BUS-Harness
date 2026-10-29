import test from "node:test";
import assert from "node:assert/strict";
import { addUser, jsonHeaders, loginAs, raw, start, write } from "./helpers.ts";
import type { OAuthClientMetadata } from "../src/oauth/types.ts";
import { computeCodeChallenge } from "../src/oauth/pkce.ts";

const STATIC_CLIENT: OAuthClientMetadata = {
  client_id: "test-client",
  client_name: "Test Audit Client",
  redirect_uris: ["https://client.example.com/callback"],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  scope: "mcp.read agent.use",
  token_endpoint_auth_method: "none",
};

const wide = {
  auth: { capacity: 1000, refillPerSec: 100 },
  read: { capacity: 1000, refillPerSec: 100 },
  write: { capacity: 1000, refillPerSec: 100 },
  rpc: { capacity: 1000, refillPerSec: 100 },
};

test("M6A-A3.4: oauth audit lifecycle emits authorize, token, refresh, revoke, and denied", async (t) => {
  const h = await start({
    rateClasses: wide,
    oauthClients: { "test-client": STATIC_CLIENT },
  });
  t.after(() => h.close());

  await addUser(h, { id: "alice", username: "alice", role: "member", agentRights: { main: "use" } });
  const { cookie } = await loginAs(h, "alice");

  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = computeCodeChallenge(verifier);

  // 1. Authorization denial audits oauth.denied
  const denyRes = await raw(h, {
    method: "POST",
    path: "/oauth/authorize",
    headers: {
      cookie,
      host: `127.0.0.1:${h.port}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: "test-client",
      redirect_uri: "https://client.example.com/callback",
      code_challenge: challenge,
      code_challenge_method: "S256",
      approve: "false",
      resource: "/mcp",
    }).toString(),
  });
  assert.equal(denyRes.status, 200);

  const deniedEv = h.audit.events.find((e) => e.action === "oauth.denied");
  assert.ok(deniedEv, "expected oauth.denied event");
  assert.equal(deniedEv.actor.user, "alice");
  assert.equal(deniedEv.target, "oauth:test-client");
  assert.equal(deniedEv.detail.reason, "access_denied");

  // 2. Authorization approval audits oauth.authorize
  const authRes = await raw(h, {
    method: "POST",
    path: "/oauth/authorize",
    headers: {
      cookie,
      host: `127.0.0.1:${h.port}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: "test-client",
      redirect_uri: "https://client.example.com/callback",
      code_challenge: challenge,
      code_challenge_method: "S256",
      approve: "true",
      scope: "mcp.read agent.use",
      resource: "/mcp",
    }).toString(),
  });
  assert.equal(authRes.status, 200);
  const code = authRes.json.code as string;
  assert.ok(code);

  const authEv = h.audit.events.find((e) => e.action === "oauth.authorize");
  assert.ok(authEv, "expected oauth.authorize event");
  assert.equal(authEv.actor.user, "alice");
  assert.equal(authEv.target, "agent:main");
  assert.equal(authEv.detail.clientId, "test-client");
  assert.equal(authEv.detail.audience, "mcp");
  assert.equal(authEv.detail.scopes, "mcp.read agent.use");

  // 3. Token exchange audits oauth.token
  const tokenRes = await raw(h, {
    method: "POST",
    path: "/oauth/token",
    headers: {
      host: `127.0.0.1:${h.port}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "test-client",
      redirect_uri: "https://client.example.com/callback",
      code,
      code_verifier: verifier,
    }).toString(),
  });
  assert.equal(tokenRes.status, 200);
  const accessToken = tokenRes.json.access_token as string;
  const refreshToken = tokenRes.json.refresh_token as string;
  assert.ok(accessToken);
  assert.ok(refreshToken);

  const tokenEv = h.audit.events.find((e) => e.action === "oauth.token");
  assert.ok(tokenEv, "expected oauth.token event");
  assert.equal(tokenEv.actor.user, "oauth:test-client");
  assert.match(tokenEv.target, /^token:[0-9a-f]{12}$/);
  assert.equal(tokenEv.detail.clientId, "test-client");
  assert.equal(tokenEv.detail.audience, "mcp");
  assert.equal(tokenEv.detail.agentId, "main");

  // 4. Token refresh audits oauth.refresh
  const refreshRes = await raw(h, {
    method: "POST",
    path: "/oauth/token",
    headers: {
      host: `127.0.0.1:${h.port}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: "test-client",
      refresh_token: refreshToken,
    }).toString(),
  });
  assert.equal(refreshRes.status, 200);
  const newRefreshToken = refreshRes.json.refresh_token as string;
  assert.ok(newRefreshToken);

  const refreshEv = h.audit.events.find((e) => e.action === "oauth.refresh");
  assert.ok(refreshEv, "expected oauth.refresh event");
  assert.equal(refreshEv.actor.user, "oauth:test-client");
  assert.match(refreshEv.target, /^token:[0-9a-f]{12}$/);
  assert.equal(refreshEv.detail.clientId, "test-client");
  assert.ok(refreshEv.detail.familyId);

  // 5. Token revocation audits oauth.revoke
  const revokeRes = await raw(h, {
    method: "POST",
    path: "/oauth/revoke",
    headers: {
      host: `127.0.0.1:${h.port}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      token: newRefreshToken,
      token_type_hint: "refresh_token",
      client_id: "test-client",
    }).toString(),
  });
  assert.equal(revokeRes.status, 200);

  const revokeEv = h.audit.events.find((e) => e.action === "oauth.revoke");
  assert.ok(revokeEv, "expected oauth.revoke event");
  assert.equal(revokeEv.detail.clientId, "test-client");
});

test("M6A-A3.4: user can list and revoke OAuth grants via API", async (t) => {
  const h = await start({
    rateClasses: wide,
    oauthClients: { "test-client": STATIC_CLIENT },
  });
  t.after(() => h.close());

  await addUser(h, { id: "bob", username: "bob", role: "member", agentRights: { main: "use" } });
  const { cookie } = await loginAs(h, "bob");

  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = computeCodeChallenge(verifier);

  // Authorize & get token
  const authRes = await raw(h, {
    method: "POST",
    path: "/oauth/authorize",
    headers: {
      cookie,
      host: `127.0.0.1:${h.port}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: "test-client",
      redirect_uri: "https://client.example.com/callback",
      code_challenge: challenge,
      code_challenge_method: "S256",
      approve: "true",
      scope: "mcp.read agent.use",
      resource: "/mcp",
    }).toString(),
  });
  assert.equal(authRes.status, 200);
  const code = authRes.json.code as string;

  const tokenRes = await raw(h, {
    method: "POST",
    path: "/oauth/token",
    headers: {
      host: `127.0.0.1:${h.port}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "test-client",
      redirect_uri: "https://client.example.com/callback",
      code,
      code_verifier: verifier,
    }).toString(),
  });
  assert.equal(tokenRes.status, 200);
  const refreshToken = tokenRes.json.refresh_token as string;

  // 1. List grants via GET /api/v1/oauth/grants
  const listRes = await raw(h, {
    method: "GET",
    path: "/api/v1/oauth/grants",
    headers: { cookie, host: `127.0.0.1:${h.port}` },
  });
  assert.equal(listRes.status, 200);
  const grants = listRes.json.grants as Array<{ id: string; clientId: string; activeTokenId?: string }>;
  assert.equal(grants.length, 1);
  assert.equal(grants[0]!.clientId, "test-client");
  const grantId = grants[0]!.id;

  // 2. Revoke grant via POST /api/v1/oauth/grants/revoke
  const revRes = await write(h, cookie, {
    path: "/api/v1/oauth/grants/revoke",
    body: { id: grantId },
  });
  assert.equal(revRes.status, 200);
  assert.equal(revRes.json.revoked, true);

  // 3. Grant is no longer listed
  const listAfter = await raw(h, {
    method: "GET",
    path: "/api/v1/oauth/grants",
    headers: { cookie, host: `127.0.0.1:${h.port}` },
  });
  assert.equal(listAfter.json.grants.length, 0);

  // 4. Refresh token fails with invalid_grant because family was revoked
  const failRefresh = await raw(h, {
    method: "POST",
    path: "/oauth/token",
    headers: {
      host: `127.0.0.1:${h.port}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: "test-client",
      refresh_token: refreshToken,
    }).toString(),
  });
  assert.equal(failRefresh.status, 400);
  assert.equal(failRefresh.json.error, "invalid_grant");
});
