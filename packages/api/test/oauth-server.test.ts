import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { FakeClock } from "../src/clock.ts";
import { DEFAULT_SESSION_LIMITS, SessionStore } from "../src/session.ts";
import { computeCodeChallenge, verifyPkce } from "../src/oauth/pkce.ts";
import { matchRedirectUri } from "../src/oauth/client-metadata.ts";
import { addUser, csrfToken, jsonHeaders, loginAs, raw, start, type Harness } from "./helpers.ts";
import type { OAuthClientMetadata } from "../src/oauth/types.ts";

const STATIC_CLIENT: OAuthClientMetadata = {
  client_id: "test-client",
  client_name: "Test OAuth Client",
  redirect_uris: ["https://client.example.com/callback", "http://127.0.0.1:8080/callback"],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  scope: "mcp.read mcp.write",
  token_endpoint_auth_method: "none",
};

const wide = {
  auth: { capacity: 1000, refillPerSec: 100 },
  read: { capacity: 1000, refillPerSec: 100 },
  write: { capacity: 1000, refillPerSec: 100 },
  totp: { capacity: 1000, refillPerSec: 100 },
  stream: { capacity: 1000, refillPerSec: 100 },
};

test("M6A-A3.1: PKCE enforces S256 and rejects plain", () => {
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = computeCodeChallenge(verifier);

  assert.equal(verifyPkce(verifier, challenge, "S256"), true);
  // Plain method must be rejected outright
  assert.equal(verifyPkce(verifier, verifier, "plain"), false);
  // Invalid method rejected
  assert.equal(verifyPkce(verifier, challenge, "S512"), false);
  // Wrong verifier rejected
  assert.equal(verifyPkce(verifier + "_wrong", challenge, "S256"), false);
  // Too short verifier rejected
  assert.equal(verifyPkce("short", challenge, "S256"), false);
});

test("M6A-A3.1: redirect_uri matching supports exact match and loopback dynamic port", () => {
  const allowed = ["https://client.example.com/callback", "http://127.0.0.1:8080/callback"];

  assert.equal(matchRedirectUri("https://client.example.com/callback", allowed), true);
  assert.equal(matchRedirectUri("https://client.example.com/other", allowed), false);
  // Exact loopback match
  assert.equal(matchRedirectUri("http://127.0.0.1:8080/callback", allowed), true);
  // Dynamic port on loopback per RFC 8252
  assert.equal(matchRedirectUri("http://127.0.0.1:9999/callback", allowed), true);
  assert.equal(matchRedirectUri("http://127.0.0.1:9999/wrong", allowed), false);
});

test("M6A-A3.1: GET /.well-known/oauth-authorization-server advertises RFC 8414 metadata", async (t) => {
  const h = await start({ oauthClients: { "test-client": STATIC_CLIENT } });
  t.after(() => h.close());

  const res = await raw(h, {
    method: "GET",
    path: "/.well-known/oauth-authorization-server",
  });

  assert.equal(res.status, 200);
  const data = JSON.parse(res.text) as Record<string, unknown>;
  assert.equal(data.issuer, h.url);
  assert.equal(data.authorization_endpoint, `${h.url}/oauth/authorize`);
  assert.equal(data.token_endpoint, `${h.url}/oauth/token`);
  assert.equal(data.revocation_endpoint, `${h.url}/oauth/revoke`);
  assert.deepEqual(data.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(data.response_types_supported, ["code"]);
  assert.deepEqual(data.grant_types_supported, ["authorization_code", "refresh_token"]);
  assert.equal(data.authorization_response_iss_parameter_supported, true);
});

test("M6A-A3.1: GET /oauth/authorize enforces session auth, client validation and PKCE", async (t) => {
  const h = await start({ oauthClients: { "test-client": STATIC_CLIENT }, rateClasses: wide });
  t.after(() => h.close());

  await addUser(h, { id: "u-1", username: "user1", role: "member", agentRights: { main: "use" } });
  const { cookie } = await loginAs(h, "user1");

  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = computeCodeChallenge(verifier);

  // 1. Without session, JSON request returns 401
  const unauth = await raw(h, {
    method: "GET",
    path: `/oauth/authorize?response_type=code&client_id=test-client&redirect_uri=${encodeURIComponent("https://client.example.com/callback")}&code_challenge=${challenge}&code_challenge_method=S256`,
    headers: { Accept: "application/json" },
  });
  assert.equal(unauth.status, 401);

  // 2. Unknown client returns 400 invalid_client
  const badClient = await raw(h, {
    method: "GET",
    path: `/oauth/authorize?response_type=code&client_id=unknown&redirect_uri=${encodeURIComponent("https://client.example.com/callback")}&code_challenge=${challenge}&code_challenge_method=S256`,
    headers: { Cookie: cookie, Accept: "application/json" },
  });
  assert.equal(badClient.status, 400);
  assert.equal(JSON.parse(badClient.text).reason, "invalid_client");

  // 3. Unregistered redirect_uri returns 400 invalid_request without redirecting
  const badRedirect = await raw(h, {
    method: "GET",
    path: `/oauth/authorize?response_type=code&client_id=test-client&redirect_uri=${encodeURIComponent("https://evil.com/callback")}&code_challenge=${challenge}&code_challenge_method=S256`,
    headers: { Cookie: cookie, Accept: "application/json" },
  });
  assert.equal(badRedirect.status, 400);
  assert.equal(JSON.parse(badRedirect.text).reason, "invalid_request");

  // 4. plain code challenge method redirects with error
  const plainMethod = await raw(h, {
    method: "GET",
    path: `/oauth/authorize?response_type=code&client_id=test-client&redirect_uri=${encodeURIComponent("https://client.example.com/callback")}&code_challenge=${challenge}&code_challenge_method=plain`,
    headers: { Cookie: cookie },
  });
  assert.equal(plainMethod.status, 302);
  const plainLoc = new URL(plainMethod.headers.location as string);
  assert.equal(plainLoc.searchParams.get("error"), "invalid_request");

  // 5. GET request with approve=true does NOT issue code (consent only via POST)
  const getAttempt = await raw(h, {
    method: "GET",
    path: `/oauth/authorize?response_type=code&client_id=test-client&redirect_uri=${encodeURIComponent("https://client.example.com/callback")}&code_challenge=${challenge}&code_challenge_method=S256&scope=mcp.read&state=xyz123&approve=true`,
    headers: { Cookie: cookie, Accept: "application/json" },
  });
  assert.equal(getAttempt.status, 200);
  assert.equal((JSON.parse(getAttempt.text) as { code?: string }).code, undefined);

  // 6. POST /oauth/authorize requires CSRF token
  const noCsrf = await raw(h, {
    method: "POST",
    path: "/oauth/authorize",
    headers: { Cookie: cookie, ...jsonHeaders() },
    body: JSON.stringify({
      client_id: "test-client",
      redirect_uri: "https://client.example.com/callback",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "mcp.read",
      state: "xyz123",
      approve: true,
    }),
  });
  assert.equal(noCsrf.status, 403);
  assert.equal(JSON.parse(noCsrf.text).reason, "csrf");

  // 7. POST /oauth/authorize with valid CSRF token issues authorization code
  const token = await csrfToken(h, cookie);
  const approved = await raw(h, {
    method: "POST",
    path: "/oauth/authorize",
    headers: { Cookie: cookie, "x-csrf-token": token, ...jsonHeaders() },
    body: JSON.stringify({
      client_id: "test-client",
      redirect_uri: "https://client.example.com/callback",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "mcp.read",
      state: "xyz123",
      approve: true,
    }),
  });
  assert.equal(approved.status, 200);
  const authPayload = JSON.parse(approved.text) as { redirect_uri: string; code: string; state?: string };
  assert.ok(authPayload.code.startsWith("plb_code_"));
  assert.equal(authPayload.state, "xyz123");
  const target = new URL(authPayload.redirect_uri);
  assert.equal(target.origin, "https://client.example.com");
  assert.equal(target.pathname, "/callback");
  assert.equal(target.searchParams.get("code"), authPayload.code);
  assert.equal(target.searchParams.get("state"), "xyz123");
  assert.equal(target.searchParams.get("iss"), h.url);
});

test("M6A-A3.1: remote listener enforces fresh 2FA on /oauth/authorize", async (t) => {
  const clock = new FakeClock();
  const sessions = new SessionStore(clock, DEFAULT_SESSION_LIMITS);
  const h = await start({
    clock,
    oauthClients: { "test-client": STATIC_CLIENT },
    requireSecondFactor: "always",
    sharedSessions: sessions,
  });
  t.after(() => h.close());

  // Create a session for owner without stepUpAt
  const { id: sessionId } = sessions.create({ kind: "owner", id: "owner", role: "owner" });
  const cookie = `plur1bus_session=${sessionId}`;

  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = computeCodeChallenge(verifier);

  const getRes = await raw(h, {
    method: "GET",
    path: `/oauth/authorize?response_type=code&client_id=test-client&redirect_uri=${encodeURIComponent("https://client.example.com/callback")}&code_challenge=${challenge}&code_challenge_method=S256`,
    headers: { Cookie: cookie, Accept: "application/json" },
  });
  assert.equal(getRes.status, 403);
  assert.equal(JSON.parse(getRes.text).reason, "second-factor-required");

  const t1 = sessions.issueCsrf(sessionId)!.token;
  const res = await raw(h, {
    method: "POST",
    path: "/oauth/authorize",
    headers: { Cookie: cookie, "x-csrf-token": t1, ...jsonHeaders() },
    body: JSON.stringify({
      client_id: "test-client",
      redirect_uri: "https://client.example.com/callback",
      code_challenge: challenge,
      code_challenge_method: "S256",
      approve: true,
    }),
  });
  assert.equal(res.status, 403);
  assert.equal(JSON.parse(res.text).reason, "second-factor-required");

  // Now create a session WITH stepUpAt (fresh 2FA)
  const { id: freshSessionId } = sessions.create({ kind: "owner", id: "owner", role: "owner" }, { stepUpAt: clock.now() });
  const freshCookie = `plur1bus_session=${freshSessionId}`;

  const t2 = sessions.issueCsrf(freshSessionId)!.token;
  const freshRes = await raw(h, {
    method: "POST",
    path: "/oauth/authorize",
    headers: { Cookie: freshCookie, "x-csrf-token": t2, ...jsonHeaders() },
    body: JSON.stringify({
      client_id: "test-client",
      redirect_uri: "https://client.example.com/callback",
      code_challenge: challenge,
      code_challenge_method: "S256",
      approve: true,
    }),
  });
  assert.equal(freshRes.status, 200);
  assert.ok(JSON.parse(freshRes.text).code?.startsWith("plb_code_"));
});

test("M6A-A3.1: POST /oauth/token exchanges authorization code and issues bound personal token", async (t) => {
  const h = await start({
    oauthClients: { "test-client": STATIC_CLIENT },
    rateClasses: wide,
    mcpConfig: {
      mcpServer: { enabled: true },
      agents: {
        main: {
          mcpServer: {
            exposed: true,
            groups: ["agent"],
          },
        },
      },
    },
  });
  t.after(() => h.close());

  await addUser(h, { id: "u-1", username: "user1", role: "member", agentRights: { main: "use" } });
  const { cookie } = await loginAs(h, "user1");

  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = computeCodeChallenge(verifier);

  // 1. Authorize to get code
  const authRes = await raw(h, {
    method: "POST",
    path: "/oauth/authorize",
    headers: { Cookie: cookie, "x-csrf-token": await csrfToken(h, cookie), ...jsonHeaders() },
    body: JSON.stringify({
      approve: true,
      client_id: "test-client",
      redirect_uri: "https://client.example.com/callback",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "agent.use",
      state: "state1",
    }),
  });
  assert.equal(authRes.status, 200);
  const authBody = JSON.parse(authRes.text) as { code: string; redirect_uri: string };
  const code = authBody.code;
  assert.ok(code.startsWith("plb_code_"));

  // 2. Exchange code for tokens (using form-urlencoded)
  const tokenRes = await raw(h, {
    method: "POST",
    path: "/oauth/token",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: "test-client",
      redirect_uri: "https://client.example.com/callback",
      code_verifier: verifier,
    }).toString(),
  });

  assert.equal(tokenRes.status, 200);
  const tokens = JSON.parse(tokenRes.text) as {
    access_token: string;
    token_type: string;
    expires_in: number;
    refresh_token: string;
    scope: string;
  };
  assert.ok(tokens.access_token.startsWith("plb_"));
  assert.equal(tokens.token_type, "Bearer");
  assert.equal(tokens.expires_in, 3600);
  assert.ok(tokens.refresh_token.startsWith("plb_rt_"));
  assert.equal(tokens.scope, "agent.use");

  // 3. The minted access token works on bound /mcp endpoint before any replay
  const mcpResBefore = await raw(h, {
    method: "POST",
    path: "/mcp",
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    }),
  });
  assert.equal(mcpResBefore.status, 200);
  const mcpData = JSON.parse(mcpResBefore.text) as { result?: { tools?: unknown[] } };
  assert.ok(Array.isArray(mcpData.result?.tools));

  // 4. S1: Code reuse fails with 400 invalid_grant AND revokes the first issued tokens
  const replayRes = await raw(h, {
    method: "POST",
    path: "/oauth/token",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: "test-client",
      redirect_uri: "https://client.example.com/callback",
      code_verifier: verifier,
    }).toString(),
  });
  assert.equal(replayRes.status, 400);
  assert.equal(JSON.parse(replayRes.text).error, "invalid_grant");

  // 5. Verify the previously minted access token is revoked and rejected on /mcp
  const mcpResAfter = await raw(h, {
    method: "POST",
    path: "/mcp",
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    }),
  });
  assert.equal(mcpResAfter.status, 401, "revoked access token must be rejected after code reuse");

  // 6. Verify the refresh token is also revoked
  const refreshRes = await raw(h, {
    method: "POST",
    path: "/oauth/token",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: "test-client",
    }).toString(),
  });
  assert.equal(refreshRes.status, 400);
  assert.equal(JSON.parse(refreshRes.text).error, "invalid_grant");
});

test("M6A-A3.1: refresh token rotation and family revocation on replay", async (t) => {
  const h = await start({
    oauthClients: { "test-client": STATIC_CLIENT },
    rateClasses: wide,
    mcpConfig: {
      mcpServer: { enabled: true },
      agents: {
        main: {
          mcpServer: {
            exposed: true,
            groups: ["agent"],
          },
        },
      },
    },
  });
  t.after(() => h.close());

  await addUser(h, { id: "u-1", username: "user1", role: "member", agentRights: { main: "use" } });
  const { cookie } = await loginAs(h, "user1");

  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = computeCodeChallenge(verifier);

  const authRes = await raw(h, {
    method: "POST",
    path: "/oauth/authorize",
    headers: { Cookie: cookie, "x-csrf-token": await csrfToken(h, cookie), ...jsonHeaders() },
    body: JSON.stringify({
      approve: true,
      client_id: "test-client",
      redirect_uri: "https://client.example.com/callback",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "mcp.read mcp.write",
    }),
  });
  const code = (JSON.parse(authRes.text) as { code: string }).code;

  const t1Res = await raw(h, {
    method: "POST",
    path: "/oauth/token",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      client_id: "test-client",
      redirect_uri: "https://client.example.com/callback",
      code_verifier: verifier,
    }),
  });
  const t1 = JSON.parse(t1Res.text) as { access_token: string; refresh_token: string };

  // 1. Refreshing rotates to a new refresh token
  const t2Res = await raw(h, {
    method: "POST",
    path: "/oauth/token",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: t1.refresh_token,
      client_id: "test-client",
    }),
  });
  assert.equal(t2Res.status, 200);
  const t2 = JSON.parse(t2Res.text) as { access_token: string; refresh_token: string };
  assert.notEqual(t2.refresh_token, t1.refresh_token);
  assert.notEqual(t2.access_token, t1.access_token);

  // The old access token t1.access_token is revoked
  const oldAccessCheck = await raw(h, {
    method: "POST",
    path: "/mcp",
    headers: {
      Authorization: `Bearer ${t1.access_token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assert.equal(oldAccessCheck.status, 401);

  // The new access token t2.access_token is active
  const newAccessCheck = await raw(h, {
    method: "POST",
    path: "/mcp",
    headers: {
      Authorization: `Bearer ${t2.access_token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assert.equal(newAccessCheck.status, 200);

  // 2. REPLAY ATTACK: Re-using the old refresh token t1.refresh_token revokes the entire family!
  const replayRes = await raw(h, {
    method: "POST",
    path: "/oauth/token",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: t1.refresh_token,
      client_id: "test-client",
    }),
  });
  assert.equal(replayRes.status, 400);
  assert.equal(JSON.parse(replayRes.text).error, "invalid_grant");

  // Entire family is revoked: t2.access_token is now revoked!
  const revokedAccessCheck = await raw(h, {
    method: "POST",
    path: "/mcp",
    headers: {
      Authorization: `Bearer ${t2.access_token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assert.equal(revokedAccessCheck.status, 401);

  // Even t2.refresh_token cannot be used anymore
  const t2Retry = await raw(h, {
    method: "POST",
    path: "/oauth/token",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: t2.refresh_token,
      client_id: "test-client",
    }),
  });
  assert.equal(t2Retry.status, 400);
  assert.equal(JSON.parse(t2Retry.text).error, "invalid_grant");
});

test("M6A-S2: parallel refreshes with the same refresh token are atomic and cannot both succeed", async (t) => {
  const h = await start({
    oauthClients: { "test-client": STATIC_CLIENT },
    rateClasses: wide,
  });
  t.after(() => h.close());

  await addUser(h, { id: "u-atomic", username: "user-atomic", role: "member", agentRights: { main: "use" } });
  const { cookie } = await loginAs(h, "user-atomic");

  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = computeCodeChallenge(verifier);

  const authRes = await raw(h, {
    method: "POST",
    path: "/oauth/authorize",
    headers: { Cookie: cookie, "x-csrf-token": await csrfToken(h, cookie), ...jsonHeaders() },
    body: JSON.stringify({
      approve: true,
      client_id: "test-client",
      redirect_uri: "https://client.example.com/callback",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "mcp.read",
    }),
  });
  const code = (JSON.parse(authRes.text) as { code: string }).code;

  const t1Res = await raw(h, {
    method: "POST",
    path: "/oauth/token",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      client_id: "test-client",
      redirect_uri: "https://client.example.com/callback",
      code_verifier: verifier,
    }),
  });
  const t1 = JSON.parse(t1Res.text) as { refresh_token: string };

  // Trigger two concurrent refresh calls simultaneously with the same refresh token
  const refreshReq = () =>
    raw(h, {
      method: "POST",
      path: "/oauth/token",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: t1.refresh_token,
        client_id: "test-client",
      }),
    });

  const [resA, resB] = await Promise.all([refreshReq(), refreshReq()]);

  // Both cannot succeed: at least one must fail with 400 invalid_grant
  const statuses = [resA.status, resB.status];
  assert.ok(statuses.includes(400), "concurrent refresh race must not both succeed");
  const failed = statuses.find((s) => s === 400);
  assert.equal(failed, 400);
});

test("M6A-A3.1: POST /oauth/revoke revokes tokens per RFC 7009", async (t) => {
  const h = await start({
    oauthClients: { "test-client": STATIC_CLIENT },
    rateClasses: wide,
    mcpConfig: {
      mcpServer: { enabled: true },
      agents: {
        main: {
          mcpServer: {
            exposed: true,
            groups: ["agent"],
          },
        },
      },
    },
  });
  t.after(() => h.close());

  await addUser(h, { id: "u-1", username: "user1", role: "member", agentRights: { main: "use" } });
  const { cookie } = await loginAs(h, "user1");

  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = computeCodeChallenge(verifier);

  const authRes = await raw(h, {
    method: "POST",
    path: "/oauth/authorize",
    headers: { Cookie: cookie, "x-csrf-token": await csrfToken(h, cookie), ...jsonHeaders() },
    body: JSON.stringify({
      approve: true,
      client_id: "test-client",
      redirect_uri: "https://client.example.com/callback",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "mcp.read",
    }),
  });
  const code = (JSON.parse(authRes.text) as { code: string }).code;

  const tokenRes = await raw(h, {
    method: "POST",
    path: "/oauth/token",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      client_id: "test-client",
      redirect_uri: "https://client.example.com/callback",
      code_verifier: verifier,
    }),
  });
  const tokens = JSON.parse(tokenRes.text) as { access_token: string; refresh_token: string };

  // Revoke refresh token
  const revokeRes = await raw(h, {
    method: "POST",
    path: "/oauth/revoke",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      token: tokens.refresh_token,
      token_type_hint: "refresh_token",
    }).toString(),
  });
  assert.equal(revokeRes.status, 200);

  // Access token is revoked
  const whoami = await raw(h, {
    method: "GET",
    path: "/api/v1/whoami",
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  assert.equal(whoami.status, 401);

  // Revoking invalid/unknown token returns 200 OK
  const revokeUnknown = await raw(h, {
    method: "POST",
    path: "/oauth/revoke",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: "unknown_token" }).toString(),
  });
  assert.equal(revokeUnknown.status, 200);

  // M6A-B4: Revocation with token ID but wrong secret has no effect
  // Issue another token
  const authRes2 = await raw(h, {
    method: "POST",
    path: "/oauth/authorize",
    headers: { Cookie: cookie, "x-csrf-token": await csrfToken(h, cookie), ...jsonHeaders() },
    body: JSON.stringify({
      client_id: "test-client",
      redirect_uri: "https://client.example.com/callback",
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      approve: true,
      scope: "mcp.read",
    }),
  });
  const code2 = (JSON.parse(authRes2.text) as { code: string }).code;
  const tokenRes2 = await raw(h, {
    method: "POST",
    path: "/oauth/token",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: code2,
      client_id: "test-client",
      redirect_uri: "https://client.example.com/callback",
      code_verifier: verifier,
    }),
  });
  const tokens2 = JSON.parse(tokenRes2.text) as { access_token: string; refresh_token: string };
  const realToken = tokens2.access_token;
  const match = /^plb_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/.exec(realToken);
  assert.ok(match);
  const tokenId = match[1]!;
  // Fake secret with real token ID
  const fakeToken = `plb_${tokenId}_0000000000000000000000000000000000000000000`;

  // POST /oauth/revoke with fake secret returns 200 per RFC 7009
  const revokeFake = await raw(h, {
    method: "POST",
    path: "/oauth/revoke",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: fakeToken, token_type_hint: "access_token" }).toString(),
  });
  assert.equal(revokeFake.status, 200);

  // The real token was NOT revoked!
  const mcpCheck2 = await raw(h, {
    method: "POST",
    path: "/mcp",
    headers: {
      Authorization: `Bearer ${realToken}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assert.equal(mcpCheck2.status, 200);

  // Now revoking with the real secret succeeds
  const revokeReal = await raw(h, {
    method: "POST",
    path: "/oauth/revoke",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: realToken, token_type_hint: "access_token" }).toString(),
  });
  assert.equal(revokeReal.status, 200);

  // Now the real token is revoked
  const mcpCheck3 = await raw(h, {
    method: "POST",
    path: "/mcp",
    headers: {
      Authorization: `Bearer ${realToken}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assert.equal(mcpCheck3.status, 401);
});

test("M6A-A3.1: client_id metadata document resolves dynamically and blocks SSRF", async (t) => {
  const dynamicClientId = "https://app.example.com/oauth-metadata.json";
  const fetchMock = async (url: string) => {
    if (url === dynamicClientId) {
      return {
        client_id: dynamicClientId,
        client_name: "Dynamic App",
        redirect_uris: ["https://app.example.com/oauth/callback"],
        grant_types: ["authorization_code"],
        response_types: ["code"],
      };
    }
    throw new Error("404");
  };

  const { ClientMetadataResolver } = await import("../src/oauth/client-metadata.ts");
  const resolver = new ClientMetadataResolver({
    fetchMetadata: fetchMock,
  });

  // Dynamic HTTPS client resolves
  const client = await resolver.resolveClient(dynamicClientId);
  assert.ok(client);
  assert.equal(client.client_id, dynamicClientId);
  assert.equal(client.client_name, "Dynamic App");
  assert.deepEqual(client.redirect_uris, ["https://app.example.com/oauth/callback"]);

  // SSRF protection blocks private and loopback IP ranges with default production settings
  const ssrfResolver = new ClientMetadataResolver();
  await assert.rejects(
    async () => ssrfResolver.resolveClient("https://169.254.169.254/latest/meta-data"),
    (err: { reason?: string }) => err.reason === "client_id",
  );
  await assert.rejects(
    async () => ssrfResolver.resolveClient("https://10.0.0.1/metadata.json"),
    (err: { reason?: string }) => err.reason === "client_id",
  );
  await assert.rejects(
    async () => ssrfResolver.resolveClient("https://127.0.0.1:8443/metadata.json"),
    (err: { reason?: string }) => err.reason === "client_id",
  );
  await assert.rejects(
    async () => ssrfResolver.resolveClient("https://localhost:8443/metadata.json"),
    (err: { reason?: string }) => err.reason === "client_id",
  );
  // Plain HTTP is rejected
  assert.equal(await ssrfResolver.resolveClient("http://127.0.0.1:8080/metadata.json"), undefined);
  assert.equal(await ssrfResolver.resolveClient("http://example.com/metadata.json"), undefined);

  // Streaming size limit: metadata document exceeding 64 KB rejects
  const oversizedResolver = new ClientMetadataResolver({
    allowLoopbackMetadata: true,
  });
  // Use http server on loopback with allowLoopbackMetadata enabled to test streaming size limit
  const { createServer } = await import("node:http");
  let serverCalled = false;
  const bigServer = createServer((req, res) => {
    serverCalled = true;
    res.writeHead(200, { "content-type": "application/json" });
    // Write 70 KB of data
    res.write("{\"client_id\":\"http://127.0.0.1:" + (bigServer.address() as any).port + "/metadata\",\"junk\":\"");
    res.write("x".repeat(70 * 1024));
    res.end("\"}");
  });
  await new Promise<void>((resolve) => bigServer.listen(0, "127.0.0.1", () => resolve()));
  const port = (bigServer.address() as any).port;
  try {
    await assert.rejects(
      async () => oversizedResolver.resolveClient(`http://127.0.0.1:${port}/metadata`),
      (err: { reason?: string; message?: string }) =>
        err.reason === "client_id" && err.message?.includes("exceeds maximum size"),
    );
  } finally {
    bigServer.close();
  }
});

test("M6A-B2: unauthenticated GET /oauth/authorize never fetches client metadata", async (t) => {
  const h = await start({ oauthClients: { "test-client": STATIC_CLIENT }, rateClasses: wide });
  t.after(() => h.close());

  let probed = false;
  const { createServer } = await import("node:http");
  const canaryServer = createServer((req, res) => {
    probed = true;
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => canaryServer.listen(0, "127.0.0.1", () => resolve()));
  const canaryPort = (canaryServer.address() as any).port;
  try {
    const res = await raw(h, {
      method: "GET",
      path: `/oauth/authorize?client_id=https://127.0.0.1:${canaryPort}/meta&redirect_uri=https://app/callback&response_type=code&code_challenge=xyz&code_challenge_method=S256`,
      headers: { Accept: "application/json" },
    });
    // Unauthenticated request fails with 401 without ever contacting the canary server
    assert.equal(res.status, 401);
    assert.equal(probed, false);
  } finally {
    canaryServer.close();
  }
});

test("M6A-B3: FileOAuthStore throws on persist write errors", async () => {
  const { FileOAuthStore } = await import("../src/oauth/store.ts");
  // Non-writable path
  const store = new FileOAuthStore("/non_existent_root_dir/not_possible/store.json");
  const grant = {
    id: "g-fail",
    familyId: "fam-fail",
    userId: "u-1",
    clientId: "client-a",
    agentId: "main",
    audience: "mcp" as const,
    scopes: ["mcp.read"],
    createdAt: 1000,
    lastUsedAt: 1000,
  };
  await assert.rejects(
    async () => store.saveGrant(grant),
    (err: Error) => !!err,
  );
});

test("M6A-B6: OAuth limits scopes to protocol fixed set, intersects with user rights, and rejects bound tokens on non-protocol routes", async (t) => {
  const h = await start({
    oauthClients: { "test-client": STATIC_CLIENT },
    rateClasses: wide,
  });
  t.after(() => h.close());

  // User 1: member with "use" right on "main"
  await addUser(h, { id: "u-member", username: "member1", role: "member", agentRights: { main: "use" } });
  const { cookie: memberCookie } = await loginAs(h, "member1");

  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = computeCodeChallenge(verifier);

  // 1. Requesting non-protocol scope is rejected as invalid_scope
  const invalidScopeRes = await raw(h, {
    method: "GET",
    path: `/oauth/authorize?response_type=code&client_id=test-client&redirect_uri=${encodeURIComponent("https://client.example.com/callback")}&code_challenge=${challenge}&code_challenge_method=S256&scope=${encodeURIComponent("users.manage")}`,
    headers: { Cookie: memberCookie },
  });
  assert.equal(invalidScopeRes.status, 302);
  const invalidLoc = new URL(invalidScopeRes.headers.location as string);
  assert.equal(invalidLoc.searchParams.get("error"), "invalid_scope");

  // 2. Consent presentation filters scopes down to what the user actually can grant:
  // Member with only "use" right requesting "mcp.read agent.manage" gets only ["mcp.read"]
  const probeRes = await raw(h, {
    method: "GET",
    path: `/oauth/authorize?response_type=code&client_id=test-client&redirect_uri=${encodeURIComponent("https://client.example.com/callback")}&code_challenge=${challenge}&code_challenge_method=S256&scope=${encodeURIComponent("mcp.read agent.manage")}`,
    headers: { Cookie: memberCookie, Accept: "application/json" },
  });
  assert.equal(probeRes.status, 200);
  const probeData = JSON.parse(probeRes.text) as { scopes: string[] };
  assert.deepEqual(probeData.scopes, ["mcp.read"]);

  // 3. Requesting ONLY scopes the user cannot hold returns invalid_scope
  const unpermittedRes = await raw(h, {
    method: "GET",
    path: `/oauth/authorize?response_type=code&client_id=test-client&redirect_uri=${encodeURIComponent("https://client.example.com/callback")}&code_challenge=${challenge}&code_challenge_method=S256&scope=${encodeURIComponent("agent.manage")}`,
    headers: { Cookie: memberCookie },
  });
  assert.equal(unpermittedRes.status, 302);
  const unpermLoc = new URL(unpermittedRes.headers.location as string);
  assert.equal(unpermLoc.searchParams.get("error"), "invalid_scope");

  // 4. Issue token to member1 and verify it is rejected on non-protocol routes (e.g. /api/v1/whoami)
  const csrf = await csrfToken(h, memberCookie);
  const authRes = await raw(h, {
    method: "POST",
    path: "/oauth/authorize",
    headers: { Cookie: memberCookie, "x-csrf-token": csrf, ...jsonHeaders() },
    body: JSON.stringify({
      approve: true,
      client_id: "test-client",
      redirect_uri: "https://client.example.com/callback",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "mcp.read agent.use",
    }),
  });
  assert.equal(authRes.status, 200);
  const code = (JSON.parse(authRes.text) as { code: string }).code;

  const tokenRes = await raw(h, {
    method: "POST",
    path: "/oauth/token",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      client_id: "test-client",
      redirect_uri: "https://client.example.com/callback",
      code_verifier: verifier,
    }),
  });
  assert.equal(tokenRes.status, 200);
  const oauthTokens = JSON.parse(tokenRes.text) as { access_token: string };

  // Agent-bound token is refused on /api/v1/whoami
  const whoamiRes = await raw(h, {
    method: "GET",
    path: "/api/v1/whoami",
    headers: { Authorization: `Bearer ${oauthTokens.access_token}` },
  });
  assert.equal(whoamiRes.status, 403);
  assert.equal(JSON.parse(whoamiRes.text).reason, "token-bound-protocol-only");

  // Agent-bound token is refused on /api/v1/agents
  const agentsRes = await raw(h, {
    method: "GET",
    path: "/api/v1/agents",
    headers: { Authorization: `Bearer ${oauthTokens.access_token}` },
  });
  assert.equal(agentsRes.status, 403);
  assert.equal(JSON.parse(agentsRes.text).reason, "token-bound-protocol-only");
});
