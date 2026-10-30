import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { BIN, cli, coreEnv, home, startDaemon, waitFor, reapHome } from "./helpers.ts";

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
      name: `test-${audience}`,
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

test("system: mcp server over HTTP and stdio bridge against live daemon", { timeout: 60000 }, async () => {
  const h = home();
  try {
    cli(h, ["agent", "create", "main"]);
    const config = {
      schemaVersion: 1,
      mcpServer: { enabled: true },
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

    const { cookie } = await bootstrapAndLoginOwner(h, url);
    const mcpToken = await mintToken(url, cookie, "mcp", "main");
    const a2aToken = await mintToken(url, cookie, "a2a", "main");

    // 1. Missing auth -> 401
    const unauthRes = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert.equal(unauthRes.status, 401);

    // 2. Cross-audience token (a2a token on mcp) -> 401 invalid-audience
    const crossAudRes = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${a2aToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert.equal(crossAudRes.status, 401);
    const crossAudData = (await crossAudRes.json()) as any;
    assert.equal(crossAudData.reason, "invalid-audience");

    // 3. Modern MCP era (2026-07-28) server/discover request
    const initRes = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${mcpToken}`,
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
    assert.equal(initRes.status, 200);
    const initData = (await initRes.json()) as any;
    if (!initData.result) {
      throw new Error(`server/discover failed: ${JSON.stringify(initData)}`);
    }
    assert.equal(initData.result.resultType, "complete");
    assert.ok(initData.result.capabilities.tools);

    // 4. Modern MCP tools/list
    const toolsRes = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${mcpToken}`,
        "content-type": "application/json",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/list",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {
          _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
        },
      }),
    });
    assert.equal(toolsRes.status, 200);
    const toolsData = (await toolsRes.json()) as any;
    const toolNames = toolsData.result.tools.map((t: any) => t.name);
    assert.ok(toolNames.includes("memory_recall"));
    assert.ok(toolNames.includes("agent_status"));

    // 5. Legacy MCP era (2024-11-05) initialize request
    const legacyInitRes = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${mcpToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "legacy-test", version: "1.0.0" },
        },
      }),
    });
    assert.equal(legacyInitRes.status, 200);
    const legacyData = (await legacyInitRes.json()) as any;
    assert.equal(legacyData.result.protocolVersion, "2024-11-05");

    // 6. Stdio bridge via `plur1bus mcp serve --agent main`
    const stdioChild = spawn(BIN, ["--home", h, "mcp", "serve", "--agent", "main"], {
      env: coreEnv({ PLUR1BUS_MCP_TOKEN: mcpToken }),
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdioResponse = await new Promise<string>((resolve, reject) => {
      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        reject(new Error(`stdio timed out after 5s; stderr: ${err}`));
      }, 5000);
      stdioChild.stdout.on("data", (d: Buffer) => {
        out += String(d);
        if (out.includes("\n")) {
          clearTimeout(timer);
          resolve(out.trim());
        }
      });
      stdioChild.stderr.on("data", (d: Buffer) => {
        err += String(d);
      });
      stdioChild.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      stdioChild.on("exit", (code) => {
        clearTimeout(timer);
        if (!out) reject(new Error(`stdio exited with code ${code}; stderr: ${err}`));
      });
      stdioChild.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 42,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "stdio-client", version: "1.0" },
          },
        }) + "\n"
      );
    });

    stdioChild.kill("SIGTERM");
    const stdioJson = JSON.parse(stdioResponse);
    if (stdioJson.error) {
      throw new Error(`stdio response error: ${JSON.stringify(stdioJson)}`);
    }
    assert.equal(stdioJson.id, 42);
    assert.equal(stdioJson.result.protocolVersion, "2024-11-05");
  } finally {
    cli(h, ["daemon", "stop"], { allowFail: true });
    await reapHome(h);
    rmSync(h, { recursive: true, force: true });
  }
});
