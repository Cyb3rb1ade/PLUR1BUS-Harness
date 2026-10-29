/** M-A8: the four protocol gaps, exercised through real PKCE and discovery boundaries. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { createAuthorizedFetch, PkceAuthProvider, type McpAuthChallenge } from "../../src/mcp/auth.ts";
import { createRedactor } from "../../src/mcp/redact.ts";

const RESOURCE = "https://mcp.example/mcp";
const ISSUER = "https://login.example";
const REDIRECT = "http://127.0.0.1:18761/callback";
const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), {
  status, headers: { "content-type": "application/json" },
});
const metadata = (issuer = ISSUER) => ({
  issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
  response_types_supported: ["code"], code_challenge_methods_supported: ["S256"],
});
const challenge = (extra: Partial<McpAuthChallenge> = {}): McpAuthChallenge => ({
  resource: RESOURCE, resourceMetadata: { resource: RESOURCE, authorization_servers: [ISSUER] },
  authorizationServer: metadata(), protect: () => {},
  fetch: async () => json({ access_token: "fixture-token", token_type: "Bearer", expires_in: 60 }), ...extra,
});

it("RFC 9207 refuses a missing required issuer before exchanging a code", async () => {
  let exchanges = 0;
  const provider = new PkceAuthProvider({ clientId: "registered-client", redirectUri: REDIRECT,
    authorize: async url => ({ code: "fixture-code", state: url.searchParams.get("state")! }),
  });
  await assert.rejects(provider.authorize(challenge({
    authorizationServer: { ...metadata(), authorization_response_iss_parameter_supported: true },
    fetch: async () => { exchanges++; return json({ access_token: "fixture-token", token_type: "Bearer" }); },
  })), /issuer/);
  assert.equal(exchanges, 0);
});

it("URL client IDs fetch and validate the client metadata document without dynamic registration", async () => {
  const clientId = "https://client.example/oauth-client.json";
  const requested: string[] = [];
  const provider = new PkceAuthProvider({ clientId, redirectUri: REDIRECT,
    authorize: async url => {
      assert.equal(url.searchParams.get("client_id"), clientId);
      return { code: "fixture-code", state: url.searchParams.get("state")! };
    },
  });
  await provider.authorize(challenge({
    authorizationServer: { ...metadata(), client_id_metadata_document_supported: true,
      registration_endpoint: `${ISSUER}/register` },
    fetch: async (raw, init) => {
      requested.push(String(raw));
      if (String(raw) === clientId) {
        assert.equal(init?.method ?? "GET", "GET");
        assert.equal(new Headers(init?.headers).has("authorization"), false);
        return json({ client_id: clientId, client_name: "Fixture", redirect_uris: [REDIRECT],
          token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] });
      }
      assert.equal(String(raw), `${ISSUER}/token`);
      return json({ access_token: "fixture-token", token_type: "Bearer" });
    },
  }));
  assert.deepEqual(requested, [clientId, `${ISSUER}/token`]);
});

it("discovery selects a usable listed authorization server and keeps its issuer and resource binding", async () => {
  const bad = "https://unavailable.example";
  let chosen = "";
  const provider = new PkceAuthProvider({ clientId: "registered-client", redirectUri: REDIRECT,
    authorize: async url => {
      chosen = url.origin;
      assert.equal(url.searchParams.get("resource"), RESOURCE);
      return { code: "fixture-code", state: url.searchParams.get("state")!, issuer: ISSUER };
    },
  });
  const authorized = createAuthorizedFetch(async (raw, init) => {
    const url = String(raw);
    if (url === RESOURCE) {
      return new Headers(init?.headers).has("authorization") ? json({ ok: true })
        : new Response(null, { status: 401, headers: { "www-authenticate":
          'Bearer resource_metadata="https://mcp.example/resource"' } });
    }
    if (url === "https://mcp.example/resource") return json({ resource: RESOURCE,
      authorization_servers: [bad, ISSUER] });
    if (url.startsWith(bad)) return new Response(null, { status: 404 });
    if (url === `${ISSUER}/.well-known/oauth-authorization-server`) return json(metadata());
    if (url === `${ISSUER}/token`) {
      assert.equal(new URLSearchParams(String(init?.body)).get("resource"), RESOURCE);
      return json({ access_token: "fixture-token", token_type: "Bearer" });
    }
    throw new Error("unexpected guarded request");
  }, RESOURCE, provider, createRedactor());
  assert.equal((await authorized(RESOURCE)).status, 200);
  assert.equal(chosen, ISSUER);
});

it("step-up requests the union of previously granted and newly required scopes", async () => {
  const scopes: string[] = [];
  const provider = new PkceAuthProvider({ clientId: "registered-client", redirectUri: REDIRECT,
    authorize: async url => {
      scopes.push(url.searchParams.get("scope")!);
      return { code: "fixture-code", state: url.searchParams.get("state")! };
    },
  });
  const fetch: McpAuthChallenge["fetch"] = async () => json({ access_token: "fixture-token", token_type: "Bearer",
    ...(scopes.length === 1 ? { scope: "read profile" } : {}),
  });
  await provider.authorize(challenge({ scope: "read", fetch }));
  await provider.authorize(challenge({ scope: "write read", fetch }));
  assert.deepEqual(scopes.map(s => s.split(" ").sort()), [["read"], ["profile", "read", "write"]]);
});

it("an insufficient-scope 403 starts a bounded step-up with the previous scopes", async () => {
  const scopes: string[] = [];
  let currentScope = "read";
  const provider = new PkceAuthProvider({ clientId: "registered-client", redirectUri: REDIRECT,
    authorize: async url => {
      currentScope = url.searchParams.get("scope")!;
      scopes.push(currentScope);
      return { code: "fixture-code", state: url.searchParams.get("state")! };
    },
  });
  await provider.authorize(challenge({ scope: "read" }));
  const authorized = createAuthorizedFetch(async (raw, init) => {
    const url = String(raw);
    if (url === RESOURCE) return currentScope.includes("write") ? json({ ok: true })
      : new Response(null, { status: 403, headers: { "www-authenticate":
        'Bearer error="insufficient_scope", scope="write", resource_metadata="https://mcp.example/resource"' } });
    if (url === "https://mcp.example/resource") return json({ resource: RESOURCE, authorization_servers: [ISSUER] });
    if (url === `${ISSUER}/.well-known/oauth-authorization-server`) return json(metadata());
    if (url === `${ISSUER}/token`) {
      assert.equal(new URLSearchParams(String(init?.body)).get("resource"), RESOURCE);
      return json({ access_token: "fixture-token", token_type: "Bearer" });
    }
    throw new Error("unexpected guarded request");
  }, RESOURCE, provider, createRedactor());
  assert.equal((await authorized(RESOURCE)).status, 200);
  assert.deepEqual(scopes, ["read", "read write"]);
});

it("pre-registered opaque URI client IDs remain usable without metadata-document discovery", async () => {
  const clientId = "urn:fixture:client";
  const provider = new PkceAuthProvider({ clientId, redirectUri: REDIRECT,
    authorize: async url => {
      assert.equal(url.searchParams.get("client_id"), clientId);
      return { code: "fixture-code", state: url.searchParams.get("state")! };
    },
  });
  assert.equal(await provider.authorize(challenge()), "fixture-token");
});

it("a missing authorization interaction reports auth-required with no challenge or token details", async () => {
  const authorized = createAuthorizedFetch(async () => new Response(null, { status: 401 }),
    RESOURCE, undefined, createRedactor());
  await assert.rejects(authorized(RESOURCE), error => {
    assert.equal((error as { code?: string }).code, "auth-required");
    assert.equal(String(error).includes(RESOURCE), false);
    return true;
  });
});

it("OAuth provider inspection never exposes held credentials", async () => {
  const provider = new PkceAuthProvider({ clientId: "registered-client", redirectUri: REDIRECT,
    authorize: async url => ({ code: "fixture-private-code", state: url.searchParams.get("state")! }),
  });
  await provider.authorize(challenge());
  for (const rendered of [JSON.stringify(provider), inspect(provider)]) {
    assert.equal(rendered.includes("fixture-token"), false);
  }
});

it("a malformed token response cannot put response bytes into an authorization error", async () => {
  const provider = new PkceAuthProvider({ clientId: "registered-client", redirectUri: REDIRECT,
    authorize: async url => ({ code: "fixture-private-code", state: url.searchParams.get("state")! }),
  });
  const malformed = challenge({ fetch: async () => new Response("TOKENLEAK not-json") });
  await assert.rejects(provider.authorize(malformed), error => {
    assert.equal(String(error).includes("TOKENLEAK"), false);
    return true;
  });
});

it("a host interaction failure cannot expose foreign error text or its cause", async () => {
  const provider = new PkceAuthProvider({ clientId: "registered-client", redirectUri: REDIRECT,
    authorize: async () => { throw new Error("TOKENLEAK host callback", { cause: "TOKENLEAK" }); },
  });
  await assert.rejects(provider.authorize(challenge()), error => {
    assert.equal(inspect(error).includes("TOKENLEAK"), false);
    assert.equal((error as { cause?: unknown }).cause, undefined);
    return true;
  });
});

it("a client metadata document cannot replace the client identity or redirect before human interaction", async () => {
  for (const document of [
    { client_id: "https://attacker.example/client.json", redirect_uris: [REDIRECT] },
    { client_id: "https://client.example/client.json", redirect_uris: ["http://127.0.0.1:1/other"] },
  ]) {
    let interacted = false;
    const provider = new PkceAuthProvider({ clientId: "https://client.example/client.json", redirectUri: REDIRECT,
      authorize: async () => { interacted = true; return { code: "fixture-code", state: "wrong" }; },
    });
    await assert.rejects(provider.authorize(challenge({
      authorizationServer: { ...metadata(), client_id_metadata_document_supported: true },
      fetch: async () => json(document),
    })), /metadata/);
    assert.equal(interacted, false);
  }
});

it("an issuer-mismatched metadata response is skipped before selecting the next listed issuer", async () => {
  const imposter = "https://imposter.example";
  let chosen = "";
  const authorized = createAuthorizedFetch(async raw => {
    const url = String(raw);
    if (url === RESOURCE) return chosen ? json({ ok: true }) : new Response(null, { status: 401,
      headers: { "www-authenticate": 'Bearer resource_metadata="https://mcp.example/resource"' } });
    if (url === "https://mcp.example/resource") {
      return json({ resource: RESOURCE, authorization_servers: [imposter, ISSUER] });
    }
    if (url === `${imposter}/.well-known/oauth-authorization-server`) return json(metadata("https://unlisted.example"));
    if (url === `${ISSUER}/.well-known/oauth-authorization-server`) return json(metadata());
    throw new Error("unexpected guarded request");
  }, RESOURCE, {
    accessToken: async () => undefined,
    authorize: async c => { chosen = c.authorizationServer.issuer; return "fixture-token"; },
  }, createRedactor());
  assert.equal((await authorized(RESOURCE)).status, 200);
  assert.equal(chosen, ISSUER);
});
