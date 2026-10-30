import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli, home, startDaemon, waitFor, reapHome } from "./helpers.ts";

function computeCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

async function bootstrapAndLoginOwner(h: string, url: string) {
  const proof = readFileSync(join(h, "run", "api-bootstrap.token"), "utf8").trim();
  const post = (path: string, body: object, headers: Record<string, string> = {}) =>
    fetch(url + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  const bootRes = await post("/api/v1/accounts/bootstrap", {
    proof,
    username: "systemowner",
    password: "Password123456!",
  });
  assert.equal(bootRes.status, 201);

  const loginRes = await post("/api/v1/session", {
    username: "systemowner",
    password: "Password123456!",
  });
  assert.equal(loginRes.status, 200);
  const cookie = loginRes.headers.get("set-cookie")!.split(";")[0]!;

  return { cookie };
}

test("system: oauth authorization server against live daemon", { timeout: 60000 }, async () => {
  const h = home();
  try {
    cli(h, ["agent", "create", "main"]);
    const config = {
      schemaVersion: 1,
      mcpServer: { enabled: true },
      oauth: {
        clients: {
          "test-client": {
            client_id: "test-client",
            client_name: "Test Client",
            redirect_uris: ["http://127.0.0.1:9999/callback"],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            scope: "agent.use mcp.read mcp.write",
            token_endpoint_auth_method: "none",
          },
        },
      },
      agents: {
        main: {
          mcpServer: {
            exposed: true,
            groups: ["memory", "agent"],
          },
        },
      },
    };
    writeFileSync(join(h, "config.json"), JSON.stringify(config, null, 2));

    startDaemon(h);
    const api = await waitFor(
      "verified api.json",
      () => {
        try {
          return JSON.parse(readFileSync(join(h, "run", "api.json"), "utf8"));
        } catch {
          return false;
        }
      },
      30000
    );
    const url = `http://${api.address}:${api.port}`;

    // 1. Discovery metadata
    const asMetaRes = await fetch(`${url}/.well-known/oauth-authorization-server`);
    assert.equal(asMetaRes.status, 200);
    const asMeta = (await asMetaRes.json()) as any;
    assert.equal(asMeta.issuer, url);
    assert.equal(asMeta.authorization_endpoint, `${url}/oauth/authorize`);
    assert.equal(asMeta.token_endpoint, `${url}/oauth/token`);
    assert.equal(asMeta.revocation_endpoint, `${url}/oauth/revoke`);
    assert.deepEqual(asMeta.code_challenge_methods_supported, ["S256"]);

    const prMetaRes = await fetch(`${url}/.well-known/oauth-protected-resource?resource=${encodeURIComponent(`${url}/mcp`)}`);
    assert.equal(prMetaRes.status, 200);
    const prMeta = (await prMetaRes.json()) as any;
    assert.equal(prMeta.resource, `${url}/mcp`);

    // 2. Authorize with PKCE
    const { cookie } = await bootstrapAndLoginOwner(h, url);
    const verifier = randomBytes(32).toString("base64url");
    const challenge = computeCodeChallenge(verifier);

    const authUrl = `${url}/oauth/authorize?response_type=code&client_id=test-client&redirect_uri=${encodeURIComponent(
      "http://127.0.0.1:9999/callback"
    )}&code_challenge=${challenge}&code_challenge_method=S256&scope=${encodeURIComponent(
      "agent.use mcp.read"
    )}&state=state123&approve=true`;

    const authRes = await fetch(authUrl, {
      method: "GET",
      headers: { cookie },
      redirect: "manual",
    });
    if (authRes.status !== 302) {
      throw new Error(`authorize failed: ${authRes.status} ${await authRes.text()}`);
    }
    assert.equal(authRes.status, 302);
    const redirectLocation = authRes.headers.get("location");
    assert.ok(redirectLocation);
    const redirectUrl = new URL(redirectLocation);
    const code = redirectUrl.searchParams.get("code");
    assert.ok(code?.startsWith("plb_code_"));
    assert.equal(redirectUrl.searchParams.get("state"), "state123");

    // 3. Exchange code at token endpoint
    const tokenRes = await fetch(`${url}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        redirect_uri: "http://127.0.0.1:9999/callback",
        client_id: "test-client",
        code_verifier: verifier,
      }).toString(),
    });
    assert.equal(tokenRes.status, 200);
    const tokenData = (await tokenRes.json()) as any;
    assert.equal(tokenData.token_type, "Bearer");
    assert.ok(tokenData.access_token);
    assert.ok(tokenData.refresh_token);

    // 4. Use issued access token on /mcp
    const mcpRes = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokenData.access_token}`,
        "content-type": "application/json",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "server/discover",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "server/discover",
        params: {
          _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
        },
      }),
    });
    if (mcpRes.status !== 200) {
      throw new Error(`mcp request failed: ${mcpRes.status} ${await mcpRes.text()}`);
    }
    assert.equal(mcpRes.status, 200);

    // 5. Refresh token
    const refreshRes = await fetch(`${url}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokenData.refresh_token,
        client_id: "test-client",
      }).toString(),
    });
    assert.equal(refreshRes.status, 200);
    const refreshData = (await refreshRes.json()) as any;
    assert.ok(refreshData.access_token);
    assert.ok(refreshData.refresh_token);
    assert.notEqual(refreshData.refresh_token, tokenData.refresh_token);

    // 6. Revocation
    const revokeRes = await fetch(`${url}/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: refreshData.access_token,
        token_type_hint: "access_token",
      }).toString(),
    });
    assert.equal(revokeRes.status, 200);
  } finally {
    cli(h, ["daemon", "stop"], { allowFail: true });
    await reapHome(h);
    rmSync(h, { recursive: true, force: true });
  }
});
