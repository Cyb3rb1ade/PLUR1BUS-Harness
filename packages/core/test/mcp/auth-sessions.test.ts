/** M-A8: explicit human attempts own OAuth interaction; tool discovery cannot start sign-in. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { authorize } from "../../src/rbac/authorize.ts";
import type { Principal } from "../../src/rbac/types.ts";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

const RESOURCE = "https://mcp.example/mcp", ISSUER = "https://login.example";
const REDIRECT = "http://127.0.0.1:18761/callback";
const owner: Principal = { userId: "alice", kind: "person", role: "owner" };
const other: Principal = { userId: "bob", kind: "person", role: "admin" };
const env = { env: { SSH_CONNECTION: "fixture" }, platform: "linux" as const, stdoutIsTTY: true };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json" },
});
async function api() {
  const module = await import("../../src/mcp/auth-sessions.ts").catch(() => null);
  assert.equal(typeof module?.McpAuthSessions, "function", "MCP needs a real human-bound authorization service");
  return module!;
}
const allowed = (person: Principal) => authorize(person, "settings.write", { kind: "system" }).effect === "allow";
it("the initiating person's read scope can inspect an attempt without granting submit or cancellation", async () => {
  const { McpAuthSessions } = await api();
  const service = new McpAuthSessions({ binding: () => ({ resource: RESOURCE, clientId: "registered-client", redirectUri: REDIRECT }),
    fetch: wire().fetch, env, protect: () => {},
    authorize: (p: Principal, action: "read" | "manage") => p.tokenScopes === undefined || p.tokenScopes.includes(`extensions.${action}`),
  });
  try {
    const attempt = service.start(owner, { name: "fixture", method: "paste_callback" });
    const request = { name: "fixture", attemptId: attempt.attemptId };
    const readOnly = { ...owner, tokenScopes: ["extensions.read"] };
    assert.equal(service.status(readOnly, request).attemptId, attempt.attemptId);
    assert.throws(() => service.cancel(readOnly, request), error => (error as { error?: string }).error === "E_DENIED");
    assert.throws(() => service.submit(readOnly, { ...request, callbackUrl: REDIRECT + "?code=private" }), error => (error as { error?: string }).error === "E_DENIED");
  } finally { service.close(); }
});
function wire(device = false): { fetch: FetchLike; forms: URLSearchParams[] } {
  const forms: URLSearchParams[] = [];
  const fetch: FetchLike = async (raw, init) => {
    const url = String(raw);
    if (url.includes(".well-known/oauth-protected-resource")) {
      return json({ resource: RESOURCE, authorization_servers: [ISSUER] });
    }
    if (url === `${ISSUER}/.well-known/oauth-authorization-server`) {
      return json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`,
        response_types_supported: ["code"], code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true,
        ...(device ? { device_authorization_endpoint: `${ISSUER}/device` } : {}),
      });
    }
    const form = new URLSearchParams(String(init?.body)); forms.push(form);
    assert.equal(form.get("resource"), RESOURCE);
    if (url === `${ISSUER}/device`) {
      return json({ device_code: "DEVICE-PRIVATE", user_code: "HUMAN-CODE",
        verification_uri: `${ISSUER}/activate`, expires_in: 600, interval: 1 });
    }
    assert.equal(url, `${ISSUER}/token`);
    return json({
      access_token: "ACCESS-PRIVATE", refresh_token: "REFRESH-PRIVATE", token_type: "Bearer", expires_in: 60,
    });
  };
  return { fetch, forms };
}
async function until(read: () => { status: string }, status: string) {
  for (let turn = 0; turn < 100; turn++) {
    const current = read();
    if (current.status === status) return current;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.equal(read().status, status);
  return read();
}

it("only an explicit human start can authorize, and callback submission stays person/server bound", async () => {
  const { McpAuthSessions } = await api();
  const transport = wire();
  const service = new McpAuthSessions({ binding: name => name === "fixture" ? {
    resource: RESOURCE, clientId: "registered-client", redirectUri: REDIRECT,
  } : undefined, fetch: transport.fetch, env, authorize: allowed, protect: () => {} });
  try {
    assert.equal(service.ready("fixture"), true);
    const provider = service.provider("fixture")!;
    assert.equal(await provider.accessToken(RESOURCE), undefined);
    await assert.rejects(provider.authorize!({} as never), error =>
      (error as { code?: string }).code === "auth-required");
    assert.equal(transport.forms.length, 0);
    const attempt = service.start(owner, { name: "fixture", method: "paste_callback" });
    const request = { name: "fixture", attemptId: attempt.attemptId };
    await until(() => service.status(owner, request), "awaiting-callback");
    const view = service.status(owner, request);
    assert.equal(view.method, "paste_callback");
    const authorizeUrl = new URL(view.authorizationUrl!);
    assert.equal(authorizeUrl.searchParams.get("client_id"), "registered-client");
    assert.equal(authorizeUrl.searchParams.get("resource"), RESOURCE);
    assert.throws(() => service.status(other, request), /not found/i);
    assert.throws(() => service.submit(other, { ...request, callbackUrl: REDIRECT }), /not found/i);
    assert.throws(() => service.status(owner, { ...request, name: "other" }), /not found/i);
    const callback = new URL(REDIRECT);
    callback.searchParams.set("code", "CALLBACK-PRIVATE");
    callback.searchParams.set("state", authorizeUrl.searchParams.get("state")!);
    callback.searchParams.set("iss", ISSUER);
    service.submit(owner, { ...request, callbackUrl: callback.href });
    await until(() => service.status(owner, request), "authorized");
    assert.equal(await provider.accessToken(RESOURCE), "ACCESS-PRIVATE");
    const output = JSON.stringify(service.status(owner, request)) + inspect(service);
    for (const marker of ["ACCESS-PRIVATE", "REFRESH-PRIVATE", "CALLBACK-PRIVATE"]) {
      assert.equal(output.includes(marker), false);
    }
    assert.equal(transport.forms[0]!.get("grant_type"), "authorization_code");
    assert.ok(transport.forms[0]!.get("code_verifier"));
  } finally { service.close(); }
});

it("a supplied registered client identity enables the real headless device ladder and polling", async () => {
  const { McpAuthSessions } = await api();
  const transport = wire(true);
  let release!: () => void;
  const service = new McpAuthSessions({ binding: () => ({ resource: RESOURCE }), fetch: transport.fetch,
    env, authorize: allowed, protect: () => {},
    sleep: async () => await new Promise<void>(resolve => { release = resolve; }),
  });
  try {
    assert.equal(service.ready("fixture"), false);
    const attempt = service.start(owner, { name: "fixture", clientId: "registered-client", redirectUri: REDIRECT });
    assert.equal(service.ready("fixture"), true);
    const request = { name: "fixture", attemptId: attempt.attemptId };
    await until(() => service.status(owner, request), "awaiting-device");
    const view = service.status(owner, request);
    assert.equal(view.method, "device_code");
    assert.equal(view.device?.userCode, "HUMAN-CODE");
    assert.equal(JSON.stringify(view).includes("DEVICE-PRIVATE"), false);
    await new Promise<void>(resolve => setImmediate(resolve));
    release();
    await until(() => service.status(owner, request), "authorized");
    assert.equal(transport.forms[1]!.get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code");
    assert.equal(await service.provider("fixture")!.accessToken(RESOURCE), "ACCESS-PRIVATE");
  } finally { service.close(); }
});

it("cancel, expiry and capacity limits stop pending attempts without exposing another person's state", async () => {
  const { McpAuthSessions } = await api();
  let now = 0;
  const service = new McpAuthSessions({ binding: () => ({ resource: RESOURCE,
    clientId: "registered-client", redirectUri: REDIRECT }), fetch: wire().fetch, env,
    authorize: allowed, protect: () => {}, now: () => now, lifetimeMs: 1000, maxAttempts: 1,
  });
  try {
    const first = service.start(owner, { name: "fixture", method: "paste_callback" });
    const request = { name: "fixture", attemptId: first.attemptId };
    await until(() => service.status(owner, request), "awaiting-callback");
    assert.throws(() => service.start(other, { name: "other", method: "paste_callback" }), /busy/i);
    service.cancel(owner, request);
    assert.equal(service.status(owner, request).status, "cancelled");
    const second = service.start(owner, { name: "fixture", method: "paste_callback" });
    now = 1001;
    assert.equal(service.status(owner, { name: "fixture", attemptId: second.attemptId }).status, "expired");
    assert.throws(() => service.submit(owner, { ...request, callbackUrl: REDIRECT }), /not found/i);
  } finally { service.close(); }
});

it("agents, PAT-shaped principals, role denials and narrowed scopes cannot create authorization attempts", async () => {
  const { McpAuthSessions } = await api();
  let requests = 0;
  const service = new McpAuthSessions({ binding: () => ({ resource: RESOURCE,
    clientId: "registered-client", redirectUri: REDIRECT }), fetch: async () => { requests++; return json({}); },
    env, authorize: allowed, protect: () => {},
  });
  try {
    for (const principal of [{ ...owner, kind: "agent" }, { ...owner, role: "viewer" },
      { ...owner, tokenScopes: [] }] as Principal[]) {
      assert.throws(() => service.start(principal, { name: "fixture" }), /denied/i);
    }
    assert.equal(requests, 0);
  } finally { service.close(); }
});

it("another person cannot replace an active attempt by supplying different client setup", async () => {
  const { McpAuthSessions } = await api();
  const service = new McpAuthSessions({ binding: () => ({ resource: RESOURCE }), fetch: wire().fetch,
    env, authorize: allowed, protect: () => {},
  });
  try {
    const attempt = service.start(owner, { name: "fixture", clientId: "registered-client",
      redirectUri: REDIRECT, method: "paste_callback" });
    const request = { name: "fixture", attemptId: attempt.attemptId };
    await until(() => service.status(owner, request), "awaiting-callback");
    assert.throws(() => service.start(other, { name: "fixture", clientId: "other-client",
      redirectUri: REDIRECT, method: "paste_callback" }), /busy/i);
    assert.equal(service.status(owner, request).status, "awaiting-callback");
  } finally { service.close(); }
});

it("cancellation refuses a late token response even when the HTTP port ignores abort", async () => {
  const { McpAuthSessions } = await api();
  const transport = wire();
  let tokenRequest = false, release!: () => void;
  const service = new McpAuthSessions({ binding: () => ({ resource: RESOURCE,
    clientId: "registered-client", redirectUri: REDIRECT }), env, authorize: allowed, protect: () => {},
    fetch: async (raw, init) => {
      if (String(raw) === `${ISSUER}/token`) {
        tokenRequest = true;
        await new Promise<void>(resolve => { release = resolve; });
      }
      return await transport.fetch(raw, init);
    },
  });
  try {
    const attempt = service.start(owner, { name: "fixture", method: "paste_callback" });
    const request = { name: "fixture", attemptId: attempt.attemptId };
    await until(() => service.status(owner, request), "awaiting-callback");
    const url = new URL(service.status(owner, request).authorizationUrl!);
    const callback = new URL(REDIRECT);
    callback.searchParams.set("code", "CALLBACK-PRIVATE");
    callback.searchParams.set("state", url.searchParams.get("state")!);
    callback.searchParams.set("iss", ISSUER);
    service.submit(owner, { ...request, callbackUrl: callback.href });
    for (let turn = 0; !tokenRequest && turn < 100; turn++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(tokenRequest, true);
    service.cancel(owner, request);
    release();
    for (let turn = 0; turn < 5; turn++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(await service.provider("fixture")!.accessToken(RESOURCE), undefined);
    assert.equal(service.status(owner, request).status, "cancelled");
  } finally { service.close(); }
});

it("current host registration replaces earlier session setup metadata", async () => {
  const { McpAuthSessions } = await api();
  let binding: { resource: string; clientId?: string; redirectUri?: string } = { resource: RESOURCE };
  const service = new McpAuthSessions({ binding: () => binding, fetch: wire().fetch,
    env, authorize: allowed, protect: () => {},
  });
  try {
    const first = service.start(owner, { name: "fixture", clientId: "registered-client",
      redirectUri: REDIRECT, method: "paste_callback" });
    const request = { name: "fixture", attemptId: first.attemptId };
    await until(() => service.status(owner, request), "awaiting-callback");
    service.cancel(owner, request);
    binding = { resource: RESOURCE, clientId: "rotated-client", redirectUri: REDIRECT };
    const second = service.start(owner, { name: "fixture", method: "paste_callback" });
    const next = { name: "fixture", attemptId: second.attemptId };
    await until(() => service.status(owner, next), "awaiting-callback");
    assert.equal(new URL(service.status(owner, next).authorizationUrl!).searchParams.get("client_id"), "rotated-client");
  } finally { service.close(); }
});

it("Core handlers bind their resolver's person and reject principal fields from request text", async () => {
  const { McpAuthSessions, buildMcpAuthSessionMethods } = await api();
  let principal: Principal | null = owner;
  let requests = 0;
  const service = new McpAuthSessions({ binding: () => ({ resource: RESOURCE,
    clientId: "registered-client", redirectUri: REDIRECT }), env, authorize: allowed, protect: () => {},
    fetch: async () => { requests++; return json({}); },
  });
  const handlers = buildMcpAuthSessionMethods(service, async () => principal);
  const start = handlers["admin.extensions.auth.start"]!;
  const context = { connectionId: "fixture", requestId: "fixture", signal: new AbortController().signal };
  try {
    await assert.rejects(async () => await start({ name: "fixture", principal: owner }, context), error =>
      (error as { error?: string }).error === "E_INVALID_PARAMS");
    principal = null;
    await assert.rejects(async () => await start({ name: "fixture" }, context), error =>
      (error as { error?: string }).error === "E_UNAUTHORIZED");
    principal = { ...owner, kind: "agent" };
    await assert.rejects(async () => await start({ name: "fixture" }, context), error =>
      (error as { error?: string }).error === "E_DENIED");
    assert.equal(requests, 0);
  } finally { service.close(); }
});
