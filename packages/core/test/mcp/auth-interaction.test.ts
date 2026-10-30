/** M-A8: host interaction chooses a ladder step; the MCP provider alone owns token exchange. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { inspect } from "node:util";
import { PkceAuthProvider, type McpAuthChallenge } from "../../src/mcp/auth.ts";
import { createMcpAuthInteraction } from "../../src/mcp/auth-interaction.ts";

const RESOURCE = "https://mcp.example/mcp";
const ISSUER = "https://login.example";
const metadata = {
  issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`,
  device_authorization_endpoint: `${ISSUER}/device`, response_types_supported: ["code"],
  code_challenge_methods_supported: ["S256"], authorization_response_iss_parameter_supported: true,
};
const env = { env: { SSH_CONNECTION: "fixture" }, platform: "linux" as const, stdoutIsTTY: true };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "content-type": "application/json" },
});
async function factory() {
  return createMcpAuthInteraction;
}
async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

it("headless MCP offers device, SSH loopback and paste in the shared ladder order", async () => {
  const create = await factory();
  const interaction = create({ env });
  const plan = interaction.plan(metadata);
  assert.deepEqual([plan.method, ...plan.fallbacks], ["device_code", "loopback_ssh", "paste_callback"]);
  assert.match(plan.sshHint!(18761), /ssh -L 18761:127\.0\.0\.1:18761/);
});

it("the device ladder step exchanges a device code rather than fabricating an authorization code", async () => {
  const create = await factory();
  let now = 0;
  const requests: URLSearchParams[] = [];
  const protectedValues: string[] = [];
  const interaction = create({ env, now: () => now, sleep: async ms => { now += ms; },
    onDevice: async prompt => {
      assert.equal(prompt.userCode, "fixture-user-code");
      assert.equal(JSON.stringify(prompt).includes("fixture-user-code"), false);
      assert.equal(inspect(prompt).includes("fixture-user-code"), false);
    },
  });
  const provider = new PkceAuthProvider({
    clientId: "registered-client", redirectUri: "http://127.0.0.1:18761/callback", interaction,
  });
  const fetch: McpAuthChallenge["fetch"] = async (raw, init) => {
    const form = new URLSearchParams(String(init?.body)); requests.push(form);
    assert.equal(form.get("client_id"), "registered-client");
    assert.equal(form.get("resource"), RESOURCE);
    if (String(raw) === `${ISSUER}/device`) return json({
      device_code: "fixture-device-code", user_code: "fixture-user-code",
      verification_uri: `${ISSUER}/activate`, expires_in: 600, interval: 1,
    });
    assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code");
    assert.equal(form.get("device_code"), "fixture-device-code");
    assert.equal(form.has("code"), false);
    return requests.length === 2 ? json({ error: "authorization_pending" }, 400)
      : json({ access_token: "fixture-device-token", token_type: "Bearer", expires_in: 60 });
  };
  assert.equal(await provider.authorize({ resource: RESOURCE,
    resourceMetadata: { resource: RESOURCE, authorization_servers: [ISSUER] }, authorizationServer: metadata,
    fetch, protect: value => protectedValues.push(value), scope: "read" }), "fixture-device-token");
  assert.equal(requests.length, 3);
  assert.equal(requests[0]!.get("scope"), "read");
  assert.ok(protectedValues.includes("fixture-device-code"));
  assert.ok(protectedValues.includes("fixture-device-token"));
});

it("SSH loopback reuses the provider's state and verifier while showing the forwarding hint", async () => {
  const create = await factory();
  const redirect = `http://127.0.0.1:${await unusedPort()}/callback`;
  let hint = "";
  const interaction = create({ env, method: "loopback_ssh", onAuthorization: async prompt => {
    hint = prompt.sshHint!;
    const authorize = new URL(prompt.authorizationUrl);
    const callback = new URL(prompt.redirectUri);
    callback.searchParams.set("code", "fixture-loopback-code");
    callback.searchParams.set("state", authorize.searchParams.get("state")!);
    callback.searchParams.set("iss", ISSUER);
    assert.equal((await fetch(callback)).status, 200);
  } });
  const provider = new PkceAuthProvider({ clientId: "registered-client", redirectUri: redirect, interaction });
  assert.equal(await provider.authorize({ resource: RESOURCE,
    resourceMetadata: { resource: RESOURCE, authorization_servers: [ISSUER] }, authorizationServer: metadata,
    fetch: async (_raw, init) => {
      const form = new URLSearchParams(String(init?.body));
      assert.equal(form.get("code"), "fixture-loopback-code");
      assert.equal(form.get("redirect_uri"), redirect);
      assert.ok(form.get("code_verifier"));
      return json({ access_token: "fixture-loopback-token", token_type: "Bearer" });
    }, protect: () => {},
  }), "fixture-loopback-token");
  assert.match(hint, /ssh -L/);
});

it("cancelling a pasted callback ends the interaction without token exchange or a silent fallback", async () => {
  const create = await factory();
  const controller = new AbortController();
  let exchanged = false;
  const interaction = create({ env, pasteCallback: true,
    readCallback: async (_prompt, signal) => {
      assert.equal(signal.aborted, false);
      controller.abort();
      return await new Promise(() => {});
    },
  });
  const provider = new PkceAuthProvider({
    clientId: "registered-client", redirectUri: "http://127.0.0.1:18761/callback", interaction,
  });
  await assert.rejects(provider.authorize({ resource: RESOURCE,
    resourceMetadata: { resource: RESOURCE, authorization_servers: [ISSUER] }, authorizationServer: metadata,
    fetch: async () => { exchanged = true; return json({}); }, protect: () => {},
  }, controller.signal), error => (error as { code?: string }).code === "auth-required");
  assert.equal(exchanged, false);
});

it("forged loopback callbacks never consume or rate-limit a genuine callback", async () => {
  const create = await factory();
  const redirect = `http://127.0.0.1:${await unusedPort()}/callback`;
  const url = new URL(`${ISSUER}/authorize`);
  url.searchParams.set("redirect_uri", redirect);
  url.searchParams.set("state", "fixture-private-state");
  const interaction = create({ env, method: "loopback_ssh", onAuthorization: async () => {
    const callback = new URL(redirect);
    callback.searchParams.set("code", "fixture-code");
    callback.searchParams.set("state", "forged");
    for (let attempt = 0; attempt < 34; attempt++) {
      assert.ok([400, 429].includes((await fetch(callback)).status));
    }
    callback.searchParams.set("state", "fixture-private-state");
    callback.searchParams.set("iss", ISSUER);
    assert.equal((await fetch(callback)).status, 200);
  } });
  const response = await interaction.authorize(url, metadata);
  assert.equal("code" in response ? response.code : undefined, "fixture-code");
});

it("time spent presenting a device prompt cannot extend the device code lifetime", async () => {
  let now = 0, tokenRequests = 0;
  const interaction = createMcpAuthInteraction({ env, now: () => now,
    sleep: async ms => { now += ms; }, onDevice: async () => { now += 2000; },
  });
  const provider = new PkceAuthProvider({
    clientId: "registered-client", redirectUri: "http://127.0.0.1:18761/callback", interaction,
  });
  await assert.rejects(provider.authorize({ resource: RESOURCE,
    resourceMetadata: { resource: RESOURCE, authorization_servers: [ISSUER] }, authorizationServer: metadata,
    protect: () => {}, fetch: async raw => {
      if (String(raw) === `${ISSUER}/device`) return json({ device_code: "fixture-device-code",
        user_code: "fixture-user-code", verification_uri: `${ISSUER}/activate`, expires_in: 1, interval: 0.1 });
      tokenRequests++;
      return json({ access_token: "fixture-device-token", token_type: "Bearer" });
    },
  }));
  assert.equal(tokenRequests, 0);
});
