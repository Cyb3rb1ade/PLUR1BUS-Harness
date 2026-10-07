import { it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createEgress } from "../../src/egress/index.ts";
import { createMcpFetch } from "../../src/mcp/http.ts";
import { createRedactor } from "../../src/mcp/redact.ts";
import { createAuthorizedFetch, SecretBearerAuthProvider, PkceAuthProvider } from "../../src/mcp/auth.ts";

it("static bearer uses a core secret lease, revokes it, and redacts tokens", async () => {
  let revoked = false;
  const auth = new SecretBearerAuthProvider({
    lease: async (p, name) => { assert.equal(p.kind, "core"); assert.equal(name, "mcp/test"); return { leaseId: "synthetic", value: "fake-test-token" }; },
    revokeLease: () => { revoked = true; return true; },
  }, "mcp/test");
  const redactor = createRedactor();
  let header = "";
  const fetch = createAuthorizedFetch(async (_url, init) => { header = new Headers(init?.headers).get("authorization")!; return new Response("{}", { status: 200 }); }, "https://mcp.invalid/mcp", auth, redactor);
  await fetch("https://mcp.invalid/mcp");
  assert.equal(header, "Bearer fake-test-token"); assert.ok(revoked);
  assert.equal(redactor.redact("fake-test-token"), "[REDACTED]");
});
it("401 metadata discovery and OAuth PKCE use local endpoints, resource binding and state", async () => {
  let base = ""; let challenge = ""; let exchanged = false; let metadataAuth = false;
  const server = createServer(async (req, res) => {
    if (req.url === "/mcp") {
      if (req.headers.authorization === "Bearer fake-access-token") res.writeHead(200).end("{}");
      else res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${base}/resource", scope="read"` }).end();
    } else if (req.url === "/resource") {
      metadataAuth ||= !!req.headers.authorization;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ resource: base + "/mcp", authorization_servers: [base], scopes_supported: ["read"] }));
    } else if (req.url === "/.well-known/oauth-authorization-server") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ issuer: base, response_types_supported: ["code"], authorization_endpoint: base + "/authorize", token_endpoint: base + "/token", code_challenge_methods_supported: ["S256"] }));
    } else if (req.url === "/token") {
      let body = ""; for await (const b of req) body += String(b);
      const p = new URLSearchParams(body);
      assert.equal(p.get("resource"), base + "/mcp"); assert.equal(p.get("grant_type"), "authorization_code");
      const { createHash } = await import("node:crypto");
      assert.equal(createHash("sha256").update(p.get("code_verifier")!).digest("base64url"), challenge);
      exchanged = true;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: "fake-access-token", token_type: "Bearer", expires_in: 60 }));
    } else res.writeHead(404).end();
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port; base = `http://127.0.0.1:${port}`;
  const egress = createEgress({ config: () => ({ allowHosts: ["127.0.0.1"], allowPorts: [port], allowLoopback: true }) });
  const fetch = createMcpFetch({ egress });
  const auth = new PkceAuthProvider({ clientId: "fixture", redirectUri: "http://127.0.0.1/callback",
    authorize: async url => {
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      assert.equal(url.searchParams.get("resource"), base + "/mcp");
      challenge = url.searchParams.get("code_challenge")!;
      return { code: "fake-code", state: url.searchParams.get("state")!, issuer: base };
    },
  });
  const redactor = createRedactor();
  try {
    const authorized = createAuthorizedFetch(fetch, base + "/mcp", auth, redactor);
    assert.equal((await authorized(base + "/mcp")).status, 200);
    assert.ok(exchanged); assert.equal(metadataAuth, false);
    assert.equal(redactor.redact("fake-access-token"), "[REDACTED]");
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});
it("auth refuses an unexpected resource and never leaks a provider exception", async () => {
  const auth = { accessToken: async () => { throw new Error("secret-never-print"); } };
  const f = createAuthorizedFetch(async () => new Response(), "https://mcp.invalid/mcp", auth, createRedactor());
  await assert.rejects(f("https://other.invalid/"), /endpoint/);
  await assert.rejects(f("https://mcp.invalid/mcp"), e => !String(e).includes("secret-never-print"));
});

it("PKCE rejects state, issuer and missing S256 before exchanging any token", async () => {
  for (const mode of ["state", "issuer", "pkce"] as const) {
    let exchanged = false;
    const provider = new PkceAuthProvider({ clientId: "fixture", redirectUri: "http://127.0.0.1/callback",
      authorize: async url => ({ code: "fake-code", state: mode === "state" ? "wrong" : url.searchParams.get("state")!, issuer: mode === "issuer" ? "https://wrong.invalid" : "https://issuer.invalid" }) });
    await assert.rejects(provider.authorize({ resource: "https://mcp.invalid/mcp", resourceMetadata: { resource: "https://mcp.invalid/mcp", authorization_servers: ["https://issuer.invalid"] },
      authorizationServer: { issuer: "https://issuer.invalid", response_types_supported: ["code"], authorization_endpoint: "https://issuer.invalid/authorize", token_endpoint: "https://issuer.invalid/token", code_challenge_methods_supported: mode === "pkce" ? ["plain"] : ["S256"] },
      fetch: async () => { exchanged = true; return new Response(); }, protect: () => {} }), /state|issuer|PKCE/);
    assert.equal(exchanged, false);
  }
});
it("OAuth refresh retains issuer/resource binding and forwards the new request signal", async () => {
  let requests = 0; let lastSignal: AbortSignal | null | undefined;
  const first = new AbortController(); const next = new AbortController();
  const provider = new PkceAuthProvider({ clientId: "fixture", redirectUri: "http://127.0.0.1/callback", authorize: async url => ({ code: "fake-code", state: url.searchParams.get("state")! }) });
  const fetch = async (_url: string | URL, init?: RequestInit) => {
    requests++; lastSignal = init?.signal;
    if (requests === 2) {
      const params = new URLSearchParams(String(init?.body)); assert.equal(params.get("grant_type"), "refresh_token"); assert.equal(params.get("resource"), "https://mcp.invalid/mcp");
    }
    return new Response(JSON.stringify({ access_token: "fake-access-token", refresh_token: "fake-refresh-token", expires_in: requests === 1 ? 1 : 60, token_type: "Bearer" }), { headers: { "content-type": "application/json" } });
  };
  await provider.authorize({ resource: "https://mcp.invalid/mcp", resourceMetadata: { resource: "https://mcp.invalid/mcp", authorization_servers: ["https://issuer.invalid"] }, authorizationServer: { issuer: "https://issuer.invalid", authorization_endpoint: "https://issuer.invalid/authorize", token_endpoint: "https://issuer.invalid/token", response_types_supported: ["code"], code_challenge_methods_supported: ["S256"] }, fetch, protect: () => {} }, first.signal);
  assert.equal(await provider.accessToken("https://different.invalid/mcp", next.signal), undefined);
  assert.equal(await provider.accessToken("https://mcp.invalid/mcp", next.signal), "fake-access-token"); assert.equal(lastSignal, next.signal);
});
