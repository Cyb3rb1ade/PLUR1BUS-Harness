/** M-A8: the production Core binds explicit human OAuth attempts to its live registry and guarded HTTP client. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import { createCore } from "../../src/core.ts";
import type { Principal } from "../../src/rbac/types.ts";
import type { McpAuthAttemptView } from "../../src/mcp/auth-sessions.ts";
import type { TurnProviderOptions } from "../../src/composition/provider.ts";
import { connect } from "../helpers/connect.ts";
import { flatTestInternals } from "../helpers/flat-embedder.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { modernHandler } from "../mcp/helpers/dual-fixture.ts";

async function oauthServer() {
  const access = randomUUID(), refresh = randomUUID(), code = randomUUID();
  const requests: { path: string; authorized: boolean; method?: string }[] = [];
  const forms: URLSearchParams[] = [];
  let origin = "";
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += String(chunk);
    const path = new URL(req.url!, origin).pathname;
    const authorized = req.headers.authorization === `Bearer ${access}`;
    requests.push({ path, authorized });
    const json = (value: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (path === "/.well-known/oauth-protected-resource/mcp") {
      json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
    } else if (path === "/.well-known/oauth-authorization-server") {
      json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`,
        response_types_supported: ["code"], code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true });
    } else if (path === "/token") {
      const form = new URLSearchParams(body);
      forms.push(form);
      if (form.get("grant_type") !== "authorization_code" || form.get("code") !== code ||
          form.get("resource") !== `${origin}/mcp` || !form.get("code_verifier")) {
        json({ error: "invalid_grant" }, 400);
      } else json({ access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: 600 });
    } else if (path === "/mcp") {
      if (!authorized) {
        res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` });
        res.end();
      } else {
        const message = JSON.parse(body) as Record<string, unknown>;
        requests[requests.length - 1]!.method = String(message.method);
        if (message.method === "subscriptions/listen") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/subscriptions/acknowledged",
            params: { notifications: (message.params as Record<string, unknown>).notifications,
              _meta: { "io.modelcontextprotocol/subscriptionId": message.id } } })}\n\n`);
        } else json(modernHandler(message));
      }
    } else json({ error: "not_found" }, 404);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, requests, forms, code, privateValues: [access, refresh, code], async close() {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}

async function install(home: string, resource: string) {
  const root = join(home, "mcp", "oauthsrv", "1.0.0");
  await mkdir(root, { recursive: true });
  await mkdir(join(home, "extensions"), { recursive: true });
  const manifest = { id: "test/oauthsrv", name: "oauthsrv", kind: "mcp-server", version: "1.0.0",
    requires: { runtime: { type: "none" } }, remote: { url: resource, auth: "oauth" },
    capabilities: { network: { mode: "allowlist", hosts: ["127.0.0.1"] }, tools: [], secrets: [] } };
  const bytes = JSON.stringify(manifest);
  await writeFile(join(root, "p1x.json"), bytes);
  await writeFile(join(home, "extensions", "state.json"), JSON.stringify({ schemaVersion: 1, items: { oauthsrv: {
    id: manifest.id, name: manifest.name, kind: manifest.kind, version: manifest.version, activeVersion: manifest.version,
    capabilities: manifest.capabilities, manifestSha256: createHash("sha256").update(bytes).digest("hex"),
  } } }));
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean,
  diagnostics?: () => Promise<unknown>): Promise<T> {
  const deadline = Date.now() + 10_000;
  let current = await read();
  while (!done(current) && Date.now() < deadline) {
    await new Promise<void>(resolve => setTimeout(resolve, 10));
    current = await read();
  }
  assert.ok(done(current), `production OAuth flow did not reach its expected state${
    diagnostics ? `: ${JSON.stringify(await diagnostics())}` : ""}`);
  return current;
}

it("real Core requires a human callback, isolates attempts and retries the live MCP registry with the resulting token", {
  timeout: 60_000,
}, async () => {
  const home = tempDir("p1b-A8-core-");
  const remote = await oauthServer();
  const cfg = defaults();
  cfg.agents.a = {};
  cfg.mcp.servers.oauthsrv = { enabled: true, agents: "all" };
  cfg.egress.allowHosts = ["127.0.0.1"];
  cfg.egress.allowPorts = [Number(new URL(remote.origin).port)];
  cfg.egress.allowLoopback = true;
  cfg.engine = { neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false },
    merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false },
    temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false }, reranker: { enabled: false } };
  await writeFile(join(home, "config.json"), JSON.stringify(cfg));
  await install(home, `${remote.origin}/mcp`);
  const saved = { internals: process.env.PLUR1BUS_ALLOW_TEST_INTERNALS, keyring: process.env.PLUR1BUS_SECRETS_KEYRING };
  process.env.PLUR1BUS_ALLOW_TEST_INTERNALS = "1";
  process.env.PLUR1BUS_SECRETS_KEYRING = "memory";
  let principal: Principal = { userId: "local-owner", kind: "person", role: "owner" };
  let toolsForTurn: TurnProviderOptions["toolsForTurn"];
  const core = createCore({ home, testInternals: flatTestInternals(), discovery: { scheduler: false },
    rbac: { resolve: () => principal }, composition: {
      providers: { profiles: { default: [{ provider: "fixture", model: "fixture", adapter: { async *stream() {} } }] } },
      createTurnProvider: options => {
        if (options.toolsForTurn) toolsForTurn = options.toolsForTurn;
        return { id: "fixture", telemetry: {}, async *stream() {} } as never;
      },
    } });
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  let delegated: Awaited<ReturnType<typeof connect>> | undefined;
  const views: unknown[] = [];
  try {
    await core.start();
    client = await connect({ address: core.address, token: core.token });
    const call = <T>(method: string, params: object) => client!.call<T>(`admin.extensions.${method}`, params);
    const runtimeStatus = () => call<{ overlay?: string; reason?: string }>("runtime.status", { name: "oauthsrv" });
    assert.deepEqual(await runtimeStatus(), { name: "oauthsrv", overlay: "error", reason: "auth-required" });
    assert.ok(toolsForTurn);
    const request = { sessionId: "oauth-test", agentId: "a", principal: "local-owner", messages: [], summaries: [], memory: "",
      signal: new AbortController().signal };
    assert.equal((await toolsForTurn(request)).entries().some(tool => tool.name.startsWith("mcp.oauthsrv.")), false);
    assert.equal(remote.requests.length, 0, "a missing client registration must never create an anonymous connection");
    await assert.rejects(call("auth.start", { name: "oauthsrv" }),
      (error: { error?: string }) => error.error === "E_NOT_AVAILABLE");
    principal = { userId: "viewer", kind: "person", role: "viewer" };
    await assert.rejects(call("auth.start", { name: "oauthsrv" }),
      (error: { error?: string }) => error.error === "E_DENIED");
    principal = { userId: "local-owner", kind: "person", role: "owner" };
    const apiToken = (await readFile(join(home, "run", "api-delegation.token"), "utf8")).trim();
    delegated = await connect({ address: core.address, token: core.token, api: { clientId: "harness-api", token: apiToken,
      principal: { userId: "local-owner", kind: "agent", role: "owner" } } });
    await assert.rejects(delegated.call("admin.extensions.auth.start", { name: "oauthsrv" }),
      (error: { error?: string }) => error.error === "E_DENIED");
    principal = { userId: "local-owner", kind: "person", role: "owner", tokenScopes: ["extensions.*"] };
    const start = () => call<McpAuthAttemptView>("auth.start", { name: "oauthsrv", clientId: "registered-fixture-client",
      redirectUri: "http://127.0.0.1:18761/callback", method: "paste_callback" });
    let attempt = await start();
    let ref = { name: "oauthsrv", attemptId: attempt.attemptId };
    const status = () => call<McpAuthAttemptView>("auth.status", ref);
    attempt = await until(status, value => value.status === "awaiting-callback");
    views.push(attempt);
    principal = { userId: "local-owner", kind: "person", role: "owner", tokenScopes: ["extensions.read"] };
    views.push(await status());
    await assert.rejects(call("auth.submit", { ...ref, callbackUrl: attempt.redirectUri }),
      (error: { error?: string }) => error.error === "E_DENIED");
    principal = { userId: "bob", kind: "person", role: "admin" };
    for (const method of ["status", "cancel", "submit"]) {
      await assert.rejects(call(`auth.${method}`, { ...ref, ...(method === "submit" ? { callbackUrl: attempt.redirectUri } : {}) }),
        (error: { error?: string }) => error.error === "E_NOT_FOUND");
    }
    principal = { userId: "local-owner", kind: "person", role: "owner" };
    const callback = (view: McpAuthAttemptView, issuer: string) => {
      const url = new URL(view.redirectUri!);
      url.searchParams.set("state", new URL(view.authorizationUrl!).searchParams.get("state")!);
      url.searchParams.set("code", remote.code);
      url.searchParams.set("iss", issuer);
      return url.href;
    };
    await call("auth.submit", { ...ref, callbackUrl: callback(attempt, `${remote.origin}/wrong-issuer`) });
    views.push(await until(status, value => value.status === "failed"));
    assert.equal(remote.forms.length, 0, "an issuer mismatch must fail before exchanging a code");
    assert.equal((await runtimeStatus()).reason, "auth-required");
    attempt = await start();
    ref = { name: "oauthsrv", attemptId: attempt.attemptId };
    attempt = await until(status, value => value.status === "awaiting-callback");
    const authorization = new URL(attempt.authorizationUrl!);
    assert.equal(authorization.searchParams.get("resource"), `${remote.origin}/mcp`);
    assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
    assert.equal((await toolsForTurn(request)).entries().some(tool => tool.name.startsWith("mcp.oauthsrv.")), false);
    assert.equal((await status()).status, "awaiting-callback", "tool discovery cannot consume the human attempt");
    assert.equal(remote.forms.length, 0);
    await call("auth.submit", { ...ref, callbackUrl: callback(attempt, remote.origin) });
    views.push(await until(status, value => value.status === "authorized"));
    const registry = await until(() => toolsForTurn!(request), registry =>
      registry.entries().some(tool => tool.name === "mcp.oauthsrv.echo"),
    async () => ({ runtime: await runtimeStatus(), requests: remote.requests.slice(-8), exchanges: remote.forms.length }));
    const tool = registry.entries().find(tool => tool.name === "mcp.oauthsrv.echo")!;
    views.push(await tool.execute({ text: "human-authorized" }, { sessionId: request.sessionId, agentId: "a",
      principal: "local-owner", signal: request.signal, surface: 0 }));
    assert.equal(remote.forms.length, 1);
    assert.equal(remote.forms[0]!.get("client_id"), "registered-fixture-client");
    assert.ok(createHash("sha256").update(remote.forms[0]!.get("code_verifier")!).digest("base64url") ===
      authorization.searchParams.get("code_challenge"), "the successful exchange must use the shown PKCE challenge");
    assert.ok(remote.requests.some(request => request.authorized && request.method === "tools/call"));
    assert.deepEqual(await runtimeStatus(), { name: "oauthsrv" });
  } finally {
    await delegated?.close(); await client?.close();
    await core.stop({ budgetMs: 5000 });
    await remote.close();
    for (const [key, value] of Object.entries(saved)) {
      const name = key === "internals" ? "PLUR1BUS_ALLOW_TEST_INTERNALS" : "PLUR1BUS_SECRETS_KEYRING";
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
  const logs = await readdir(join(home, "logs"));
  const output = JSON.stringify(views) + (await Promise.all(logs.filter(name => /\.(?:log|jsonl)$/.test(name))
    .map(name => readFile(join(home, "logs", name), "utf8")))).join("\n");
  assert.ok(remote.privateValues.every(value => !output.includes(value)), "OAuth values must never escape into views or Core logs");
});
