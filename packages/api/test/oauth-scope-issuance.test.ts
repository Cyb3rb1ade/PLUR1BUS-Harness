/** OAuth protocol grants must mint canonical RBAC scopes without bypassing audience or current object rights. */
import assert from "node:assert/strict";
import test from "node:test";
import { FakeClock } from "../src/clock.ts";
import { MemoryTokenStore } from "../src/memory-stores.ts";
import { computeCodeChallenge } from "../src/oauth/pkce.ts";
import { OAuthApiError, OAuthService } from "../src/oauth/service.ts";
import { MemoryOAuthStore } from "../src/oauth/store.ts";
import type { TokenAudience } from "../src/ports.ts";
import { authorize, type RbacPrincipal } from "../src/rbac-bridge.ts";
import { requireTokenBinding, TokenService } from "../src/tokens.ts";
import { addUser, csrfToken, jsonHeaders, loginAs, raw, start } from "./helpers.ts";

const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const REDIRECT_URI = "https://client.example.com/callback";

function fixture() {
  const clock = new FakeClock();
  const tokens = new TokenService({ store: new MemoryTokenStore(), clock });
  const store = new MemoryOAuthStore();
  const oauth = new OAuthService({ tokens, store, clock });
  const exchange = (audience: TokenAudience, scopes: readonly string[]) => oauth.exchangeAuthorizationCode({
    code: oauth.createAuthorizationCode({
      clientId: "test-client", redirectUri: REDIRECT_URI,
      codeChallenge: computeCodeChallenge(VERIFIER), codeChallengeMethod: "S256",
      userId: "member", agentId: "main", projectId: "project-1", audience, scopes,
    }),
    clientId: "test-client", redirectUri: REDIRECT_URI, codeVerifier: VERIFIER,
  });
  return { tokens, store, oauth, exchange };
}

test("default A2A authorization exchanges and refreshes a task grant with the real token validator", async (t) => {
  const tokenStore = new MemoryTokenStore();
  const oauthStore = new MemoryOAuthStore();
  const h = await start({
    tokens: tokenStore, oauthStore,
    oauthClients: {
      "test-client": { client_id: "test-client", redirect_uris: [REDIRECT_URI] },
    },
  });
  t.after(() => h.close());
  await addUser(h, { id: "member", username: "member", role: "member", agentRights: { main: "use" } });
  const { cookie } = await loginAs(h, "member");
  const approved = await raw(h, {
    method: "POST", path: "/oauth/authorize",
    headers: { Cookie: cookie, "x-csrf-token": await csrfToken(h, cookie), ...jsonHeaders() },
    body: JSON.stringify({
      approve: true, client_id: "test-client", redirect_uri: REDIRECT_URI,
      code_challenge: computeCodeChallenge(VERIFIER), code_challenge_method: "S256", resource: "/a2a",
    }),
  });
  assert.equal(approved.status, 200);
  const code = JSON.parse(approved.text).code as string;
  assert.equal(typeof code, "string");
  const exchanged = await raw(h, {
    method: "POST", path: "/oauth/token", headers: jsonHeaders(),
    body: JSON.stringify({
      grant_type: "authorization_code", code, client_id: "test-client",
      redirect_uri: REDIRECT_URI, code_verifier: VERIFIER,
    }),
  });
  assert.equal(exchanged.status, 200);
  const first = JSON.parse(exchanged.text) as { refresh_token: string; scope: string };
  assert.equal(first.scope, "a2a.task");
  const refreshed = await raw(h, {
    method: "POST", path: "/oauth/token", headers: jsonHeaders(),
    body: JSON.stringify({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: "test-client" }),
  });
  assert.equal(refreshed.status, 200);
  assert.equal(JSON.parse(refreshed.text).scope, "a2a.task");
  const live = (await tokenStore.listByUser("member")).filter((r) => r.revokedAt === undefined);
  assert.equal(live.length, 1);
  assert.deepEqual(live[0]!.scopes, ["agent.use", "agent.read"]);
  assert.deepEqual(live[0]!.binding, { audience: "a2a", agentId: "main" });
  assert.deepEqual((await oauthStore.listGrantsByUser("member"))[0]!.scopes, ["a2a.task"]);
});

test("MCP memory aliases mint explicit actions and refresh narrowing permanently removes write permissions", async () => {
  const { tokens, oauth, exchange } = fixture();
  const first = await exchange("mcp", ["memory.read", "memory.write"]);
  assert.equal(first.scope, "memory.read memory.write");
  const initial = await tokens.authenticate(first.access_token);
  assert.equal(initial.ok, true);
  if (!initial.ok) return;
  assert.deepEqual(initial.record.scopes, [
    "memory.workspace.read", "memory.user.read", "memory.agent-private.read",
    "memory.workspace.write", "memory.user.write", "memory.agent-private.write",
  ]);
  assert.deepEqual(requireTokenBinding(initial.record, "mcp"), {
    audience: "mcp", agentId: "main", projectId: "project-1",
  });
  assert.throws(() => requireTokenBinding(initial.record, "a2a"), { status: 401 });
  const narrowed = await oauth.refresh({
    refreshToken: first.refresh_token!, clientId: "test-client", scope: "memory.read",
  });
  assert.equal(narrowed.scope, "memory.read");
  const readOnly = await tokens.authenticate(narrowed.access_token);
  assert.equal(readOnly.ok, true);
  if (!readOnly.ok) return;
  assert.deepEqual(readOnly.record.scopes, [
    "memory.workspace.read", "memory.user.read", "memory.agent-private.read",
  ]);
  assert.equal((await tokens.authenticate(first.access_token)).ok, false);
  assert.deepEqual((await oauth.listGrantsForUser("member"))[0]!.scopes, ["memory.read"]);
  const rotated = await oauth.refresh({ refreshToken: narrowed.refresh_token!, clientId: "test-client" });
  assert.equal(rotated.scope, "memory.read");
  await assert.rejects(oauth.refresh({
    refreshToken: rotated.refresh_token!, clientId: "test-client", scope: "memory.write",
  }), (error: unknown) => error instanceof OAuthApiError && error.oauthError === "invalid_scope");
});

test("mapped memory scopes still intersect current roles, agent rights and user ownership", async () => {
  const { tokens, exchange } = fixture();
  const issued = await exchange("mcp", ["memory.read", "memory.write"]);
  const auth = await tokens.authenticate(issued.access_token);
  assert.equal(auth.ok, true);
  if (!auth.ok) return;
  const member: RbacPrincipal = {
    userId: "member", kind: "person", role: "member", agentRights: { main: "use" }, tokenScopes: auth.record.scopes,
  };
  assert.equal(authorize(member, "memory.workspace.read", {
    kind: "memory", scope: "workspace", agentId: "main",
  }).effect, "allow");
  assert.equal(authorize(member, "memory.workspace.write", {
    kind: "memory", scope: "workspace", agentId: "main",
  }).effect, "allow");
  assert.equal(authorize(member, "memory.agent-private.read", {
    kind: "memory", scope: "agent-private", agentId: "main",
  }).effect, "deny");
  assert.equal(authorize(member, "memory.user.read", {
    kind: "memory", scope: "user", ownerUserId: "someone-else",
  }).effect, "deny");
  assert.equal(authorize({ ...member, agentRights: {} }, "memory.workspace.read", {
    kind: "memory", scope: "workspace", agentId: "main",
  }).effect, "deny");
  assert.equal(authorize({ ...member, role: "viewer" }, "memory.workspace.write", {
    kind: "memory", scope: "workspace", agentId: "main",
  }).effect, "deny");
  assert.equal(authorize({ ...member, agentRights: { main: "manage" } }, "memory.agent-private.read", {
    kind: "memory", scope: "agent-private", agentId: "main",
  }).effect, "allow");
  assert.equal(authorize(member, "agent.manage", { kind: "agent", agentId: "main" }).effect, "deny");
});

test("canonical OAuth scopes remain unchanged when mixed with mapped aliases", async () => {
  const { tokens, exchange } = fixture();
  const response = await exchange("mcp", ["mcp.read", "mcp.write", "agent.use", "agent.manage", "memory.read"]);
  const auth = await tokens.authenticate(response.access_token);
  assert.equal(auth.ok, true);
  if (!auth.ok) return;
  assert.deepEqual(auth.record.scopes, [
    "mcp.read", "mcp.write", "agent.use", "agent.manage",
    "memory.workspace.read", "memory.user.read", "memory.agent-private.read",
  ]);
});

test("issuance rejects cross-audience aliases and unadvertised actions without a permissive fallback", async () => {
  for (const [audience, scopes] of [
    ["a2a", ["memory.read"]], ["mcp", ["a2a.task"]], ["mcp", ["agent.delete"]],
  ] as const) {
    const { exchange } = fixture();
    await assert.rejects(exchange(audience, scopes),
      (error: unknown) => error instanceof OAuthApiError && error.oauthError === "invalid_scope");
  }
});
