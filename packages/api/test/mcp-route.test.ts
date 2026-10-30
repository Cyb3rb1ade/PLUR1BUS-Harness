import assert from "node:assert/strict";
import test from "node:test";
import { addUser, fakeCore, loginAs, raw, start, write, type Harness } from "./helpers.ts";

const wide = {
  auth: { capacity: 1000, refillPerSec: 100 },
  read: { capacity: 1000, refillPerSec: 100 },
  write: { capacity: 1000, refillPerSec: 100 },
  totp: { capacity: 1000, refillPerSec: 100 },
  stream: { capacity: 1000, refillPerSec: 100 },
  rpc: { capacity: 1000, refillPerSec: 100 },
  expensive: { capacity: 10, refillPerSec: 10 },
};

const setupMcp = async (opts: {
  mcpServerEnabled?: boolean;
  agentExposed?: boolean;
  agentGroups?: readonly string[];
  expensiveCapacity?: number;
  expensiveConcurrency?: number;
} = {}) => {
  const core = fakeCore();
  core.impl = async (m, p) => {
    if (m === "agent.list") {
      return { agents: [{ agentId: "main", open: true, activity: { state: "idle", since: 1 } }] };
    }
    if (m === "core.status") {
      return { rpc: "1.8.0", contract: "c", uptimeMs: 1, engine: { ready: true, degraded: null } };
    }
    if (m === "memory.recall") {
      return { memories: [{ id: "mem-1", text: "sample memory", score: 0.95 }] };
    }
    if (m === "agent.status") {
      return { agentId: "main", state: "idle" };
    }
    throw new Error(`unexpected rpc ${m}`);
  };

  const rateClasses = {
    ...wide,
    expensive: {
      capacity: opts.expensiveCapacity ?? 10,
      refillPerSec: 1 / 60,
    },
  };

  const mcpConfig = {
    mcpServer: {
      enabled: opts.mcpServerEnabled ?? true,
    },
    agents: {
      main: {
        mcpServer: {
          exposed: opts.agentExposed ?? true,
          groups: opts.agentGroups ?? ["memory", "agent"],
        },
      },
    },
  };

  const h = await start({
    rateClasses,
    core,
    mcpConfig,
    expensiveConcurrency: opts.expensiveConcurrency ?? 8,
  });

  await addUser(h, { id: "u-mcp", username: "mcpuser", role: "member", agentRights: { main: "use" } });
  return h;
};

const mintBoundToken = async (h: Harness, cookie: string, audience: "mcp" | "a2a", agentId = "main") => {
  const r = await write(h, cookie, {
    path: "/api/v1/tokens",
    body: { name: `tok-${audience}`, scopes: ["agent.use"], binding: { audience, agentId } },
  });
  assert.equal(r.status, 201, r.text);
  return { token: r.json.token as string, id: (r.json.record as { id: string }).id };
};

test("M6A-A2.5: /mcp enforces Bearer-only auth, audience binding and HTTP method restrictions", async () => {
  const h = await setupMcp();
  try {
    const { cookie } = await loginAs(h, "mcpuser");
    const mcpToken = await mintBoundToken(h, cookie, "mcp");
    const a2aToken = await mintBoundToken(h, cookie, "a2a");

    // 1. Missing auth -> 401
    const noAuth = await raw(h, { method: "POST", path: "/mcp", body: "{}" });
    assert.equal(noAuth.status, 401);
    assert.ok(String(noAuth.headers["www-authenticate"]).includes("resource_metadata="));

    // 2. Cookie only -> 401
    const cookieOnly = await raw(h, { method: "POST", path: "/mcp", headers: { cookie }, body: "{}" });
    assert.equal(cookieOnly.status, 401);

    // 3. Wrong audience -> 401 invalid-audience
    const wrongAud = await raw(h, {
      method: "POST",
      path: "/mcp",
      headers: { authorization: `Bearer ${a2aToken.token}` },
      body: "{}",
    });
    assert.equal(wrongAud.status, 401);
    assert.equal(wrongAud.json.reason, "invalid-audience");

    // 4. GET /mcp -> 405 Method Not Allowed
    const getRes = await raw(h, {
      method: "GET",
      path: "/mcp",
      headers: { authorization: `Bearer ${mcpToken.token}` },
    });
    assert.equal(getRes.status, 405);
    assert.equal(getRes.headers.allow, "POST");

    // 5. DELETE /mcp -> 405 Method Not Allowed
    const deleteRes = await raw(h, {
      method: "DELETE",
      path: "/mcp",
      headers: { authorization: `Bearer ${mcpToken.token}` },
    });
    assert.equal(deleteRes.status, 405);
    assert.equal(deleteRes.headers.allow, "POST");
  } finally {
    await h.close();
  }
});

test("M6A-A2.5: unexposed agent is denied with 403 and audits mcp.server.denied", async () => {
  const h = await setupMcp({ agentExposed: false });
  try {
    const { cookie } = await loginAs(h, "mcpuser");
    const mcpToken = await mintBoundToken(h, cookie, "mcp");

    const res = await raw(h, {
      method: "POST",
      path: "/mcp",
      headers: { authorization: `Bearer ${mcpToken.token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(res.status, 403);
    assert.equal(res.json.reason, "agent-not-exposed");

    const denied = h.audit.events.find((e) => e.action === "mcp.server.denied");
    assert.ok(denied, "mcp.server.denied audit event must be emitted");
    assert.equal(denied.target, "agent:main");
    assert.equal((denied.detail as { tokenId?: string }).tokenId, mcpToken.id);
    assert.equal((denied.detail as { agentId?: string }).agentId, "main");
    assert.equal((denied.detail as { reason?: string }).reason, "agent-not-exposed");
    assert.equal((denied.detail as { tool?: string }).tool, "-");
  } finally {
    await h.close();
  }
});

test("M6A-A2.5: modern era MCP calls are audited with mcp.server.call and no secrets/payloads leak", async () => {
  const h = await setupMcp();
  try {
    const { cookie } = await loginAs(h, "mcpuser");
    const mcpToken = await mintBoundToken(h, cookie, "mcp");

    // 1. server/discover
    const discoverRes = await raw(h, {
      method: "POST",
      path: "/mcp",
      headers: {
        authorization: `Bearer ${mcpToken.token}`,
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "server/discover",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "d-1",
        method: "server/discover",
        params: {
          _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
        },
      }),
    });
    assert.equal(discoverRes.status, 200);
    assert.equal(discoverRes.json.result.resultType, "complete");

    // 2. tools/call for memory_recall
    const callRes = await raw(h, {
      method: "POST",
      path: "/mcp",
      headers: {
        authorization: `Bearer ${mcpToken.token}`,
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call",
        "mcp-name": "memory_recall",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "c-1",
        method: "tools/call",
        params: {
          name: "memory_recall",
          arguments: { query: "super confidential secret memory search" },
          _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
        },
      }),
    });
    assert.equal(callRes.status, 200);
    assert.equal(callRes.json.result.isError, false);

    // Verify audit event for call
    const callEvent = h.audit.events.find((e) => e.action === "mcp.server.call");
    assert.ok(callEvent, "mcp.server.call must be emitted on tool execution");
    assert.equal(callEvent.target, "agent:main");
    assert.equal((callEvent.detail as { tokenId?: string }).tokenId, mcpToken.id);
    assert.equal((callEvent.detail as { tool?: string }).tool, "memory_recall");
    assert.equal((callEvent.detail as { agentId?: string }).agentId, "main");

    // Ensure audit detail never holds arguments, query, or output
    const rawDetail = JSON.stringify(callEvent.detail);
    assert.ok(!rawDetail.includes("confidential"));
    assert.ok(!rawDetail.includes("super"));
    assert.ok(!rawDetail.includes("sample memory"));

    // 3. tools/call for unknown tool -> denied audit
    const unknownRes = await raw(h, {
      method: "POST",
      path: "/mcp",
      headers: {
        authorization: `Bearer ${mcpToken.token}`,
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call",
        "mcp-name": "unknown_tool",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "c-2",
        method: "tools/call",
        params: {
          name: "unknown_tool",
          _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
        },
      }),
    });
    assert.equal(unknownRes.status, 200);
    assert.ok(unknownRes.json.error);

    const deniedEvent = h.audit.events.find(
      (e) => e.action === "mcp.server.denied" && (e.detail as { tool?: string }).tool === "unknown_tool",
    );
    assert.ok(deniedEvent, "mcp.server.denied must be emitted on unknown tool");
    assert.equal((deniedEvent.detail as { tokenId?: string }).tokenId, mcpToken.id);
    assert.equal((deniedEvent.detail as { reason?: string }).reason, "tool-not-found");
  } finally {
    await h.close();
  }
});

test("M6A-A2.5: legacy era MCP calls are audited with mcp.server.call", async () => {
  const h = await setupMcp();
  try {
    const { cookie } = await loginAs(h, "mcpuser");
    const mcpToken = await mintBoundToken(h, cookie, "mcp");

    // Legacy initialize (2025-11-25)
    const initRes = await raw(h, {
      method: "POST",
      path: "/mcp",
      headers: {
        authorization: `Bearer ${mcpToken.token}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "init-1",
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      }),
    });
    assert.equal(initRes.status, 200);

    // Legacy tools/call for agent_status
    const callRes = await raw(h, {
      method: "POST",
      path: "/mcp",
      headers: {
        authorization: `Bearer ${mcpToken.token}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "call-legacy",
        method: "tools/call",
        params: {
          name: "agent_status",
          arguments: {},
        },
      }),
    });
    assert.equal(callRes.status, 200);

    const callEvent = h.audit.events.find(
      (e) => e.action === "mcp.server.call" && (e.detail as { tool?: string }).tool === "agent_status",
    );
    assert.ok(callEvent, "mcp.server.call must be emitted for legacy tools/call");
    assert.equal((callEvent.detail as { tokenId?: string }).tokenId, mcpToken.id);
    assert.equal((callEvent.detail as { agentId?: string }).agentId, "main");
  } finally {
    await h.close();
  }
});

test("M6A-A2.5: agent_ask draws on expensive rate class and audits rate-limited denial", async () => {
  // Capacity of 1 for expensive class
  const h = await setupMcp({ expensiveCapacity: 1 });
  try {
    const { cookie } = await loginAs(h, "mcpuser");
    const mcpToken = await mintBoundToken(h, cookie, "mcp");

    const makeAsk = () =>
      raw(h, {
        method: "POST",
        path: "/mcp",
        headers: {
          authorization: `Bearer ${mcpToken.token}`,
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "tools/call",
          "mcp-name": "agent_ask",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "ask-1",
          method: "tools/call",
          params: {
            name: "agent_ask",
            arguments: { message: "test prompt" },
            _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
          },
        }),
      });

    // 1st request succeeds or executes
    const first = await makeAsk();
    assert.equal(first.status, 200);

    // 2nd request exhausts the expensive capacity of 1 -> 429
    const second = await makeAsk();
    assert.equal(second.status, 429);
    assert.ok(second.headers["retry-after"]);

    // Verify rate-limited audit event
    const rateLimitedDenied = h.audit.events.find(
      (e) => e.action === "mcp.server.denied" && (e.detail as { reason?: string }).reason === "rate-limited",
    );
    assert.ok(rateLimitedDenied, "mcp.server.denied with reason rate-limited must be emitted");
    assert.equal((rateLimitedDenied.detail as { tool?: string }).tool, "agent_ask");
    assert.equal((rateLimitedDenied.detail as { tokenId?: string }).tokenId, mcpToken.id);
    assert.equal((rateLimitedDenied.detail as { agentId?: string }).agentId, "main");
  } finally {
    await h.close();
  }
});

test("M6A-A2.5: agent_ask respects expensiveConcurrency and audits concurrency-limit denial", async () => {
  // Concurrency cap of 1
  const h = await setupMcp({ expensiveConcurrency: 1, expensiveCapacity: 10 });
  try {
    const { cookie } = await loginAs(h, "mcpuser");
    const mcpToken = await mintBoundToken(h, cookie, "mcp");

    // Hook core to simulate a long turn on chat.ask / agent.read
    let resolveTurn: () => void;
    const turnPromise = new Promise<void>((r) => {
      resolveTurn = r;
    });

    const originalImpl = h.core.impl;
    h.core.impl = async (m, p) => {
      if (m === "external.turn.start" || m === "chat.ask" || m === "agent.ask") {
        await turnPromise;
        return { reply: "done" };
      }
      return originalImpl(m, p);
    };

    const makeAsk = () =>
      raw(h, {
        method: "POST",
        path: "/mcp",
        headers: {
          authorization: `Bearer ${mcpToken.token}`,
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "tools/call",
          "mcp-name": "agent_ask",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "ask-conc",
          method: "tools/call",
          params: {
            name: "agent_ask",
            arguments: { message: "test prompt" },
            _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
          },
        }),
      });

    // Start first turn (holds the slot)
    const firstPromise = makeAsk();

    // Give it a tick to acquire the slot
    await new Promise((r) => setTimeout(r, 20));

    // Second turn immediately trips concurrency cap -> 429
    const second = await makeAsk();
    assert.equal(second.status, 429);

    const concDenied = h.audit.events.find(
      (e) => e.action === "mcp.server.denied" && (e.detail as { reason?: string }).reason === "concurrency-limit",
    );
    assert.ok(concDenied, "mcp.server.denied with reason concurrency-limit must be emitted");
    assert.equal((concDenied.detail as { tool?: string }).tool, "agent_ask");

    // Finish first turn
    resolveTurn!();
    const first = await firstPromise;
    assert.equal(first.status, 200);
  } finally {
    await h.close();
  }
});
