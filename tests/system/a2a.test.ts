import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli, home, startDaemon, waitFor, reapHome } from "./helpers.ts";

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

async function mintToken(url: string, cookie: string, audience: "mcp" | "a2a", agentId = "main") {
  const csrfRes = await fetch(url + "/api/v1/csrf", { headers: { cookie } });
  const { token: csrfToken } = (await csrfRes.json()) as any;
  const post = (path: string, body: object, headers: Record<string, string> = {}) =>
    fetch(url + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  const tokenRes = await post(
    "/api/v1/tokens",
    {
      name: `test-${audience}-${agentId}`,
      scopes: ["agent.use"],
      binding: { audience, agentId },
    },
    { cookie, "x-csrf-token": csrfToken }
  );
  if (tokenRes.status !== 201) {
    throw new Error(`mint token failed: ${tokenRes.status} ${await tokenRes.text()}`);
  }
  const tokenData = (await tokenRes.json()) as any;
  return tokenData.token as string;
}

test("system: a2a agent card discovery and task operations against live daemon", { timeout: 60000 }, async () => {
  const h = home();
  try {
    cli(h, ["agent", "create", "main"]);
    cli(h, ["agent", "create", "secondary"]);
    const config = {
      schemaVersion: 1,
      a2aServer: {
        enabled: true,
        defaultAgentId: "main",
      },
      agents: {
        main: {
          a2aServer: {
            exposed: true,
            name: "Main A2A Agent",
            description: "Agent for A2A system testing",
          },
        },
        secondary: {
          a2aServer: {
            exposed: true,
            name: "Secondary A2A Agent",
            description: "Second test agent",
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

    // 1. Agent card discovery
    const defaultCardRes = await fetch(`${url}/.well-known/agent-card.json`);
    assert.equal(defaultCardRes.status, 200);
    const defaultCard = (await defaultCardRes.json()) as any;
    assert.equal(defaultCard.name, "Main A2A Agent");
    assert.equal(defaultCard.description, "Agent for A2A system testing");
    assert.ok(Array.isArray(defaultCard.supportedInterfaces));

    const agentCardRes = await fetch(`${url}/a2a/main/.well-known/agent-card.json`);
    assert.equal(agentCardRes.status, 200);
    const agentCard = (await agentCardRes.json()) as any;
    assert.equal(agentCard.name, "Main A2A Agent");

    // 2. Auth tokens & audience boundary
    const { cookie } = await bootstrapAndLoginOwner(h, url);
    const a2aToken = await mintToken(url, cookie, "a2a", "main");
    const mcpToken = await mintToken(url, cookie, "mcp", "main");
    const secondaryToken = await mintToken(url, cookie, "a2a", "secondary");

    // 2a. Unauthenticated request -> 401
    const unauthRes = await fetch(`${url}/a2a/main`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ListTasks", params: {} }),
    });
    assert.equal(unauthRes.status, 401);

    // 2b. MCP token on A2A endpoint -> 401 invalid-audience
    const wrongAudRes = await fetch(`${url}/a2a/main`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${mcpToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ListTasks", params: {} }),
    });
    assert.equal(wrongAudRes.status, 401);
    const wrongAud = (await wrongAudRes.json()) as any;
    assert.equal(wrongAud.reason, "invalid-audience");

    // 2c. Token bound to secondary agent on /a2a/main -> 403 token-agent-mismatch
    const agentMismatchRes = await fetch(`${url}/a2a/main`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secondaryToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ListTasks", params: {} }),
    });
    assert.equal(agentMismatchRes.status, 403);
    const agentMismatch = (await agentMismatchRes.json()) as any;
    assert.equal(agentMismatch.reason, "token-agent-mismatch");

    // 3. Valid A2A 1.0 call
    const listRes = await fetch(`${url}/a2a/main`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${a2aToken}`,
        "a2a-version": "1.0",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "ListTasks", params: {} }),
    });
    assert.equal(listRes.status, 200);
    const listData = (await listRes.json()) as any;
    assert.equal(listData.jsonrpc, "2.0");
    assert.equal(listData.id, 4);
    assert.ok(Array.isArray(listData.result?.tasks));
  } finally {
    cli(h, ["daemon", "stop"], { allowFail: true });
    await reapHome(h);
    rmSync(h, { recursive: true, force: true });
  }
});
