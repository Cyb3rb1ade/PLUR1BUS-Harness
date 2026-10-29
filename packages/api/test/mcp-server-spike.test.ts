/**
 * M6A-A0.2 spike tests: verifies the dual-era MCP server (2026-07-28 modern handler
 * and 2025-11-25 stateless McpServer + StreamableHTTPServerTransport) against both
 * the core ModernProtocol client (McpConnection) and the v1 SDK Client.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { systemClock } from "../../core/src/mcp/clock.ts";
import { validateDefinition } from "../../core/src/mcp/config.ts";
import { McpConnection } from "../../core/src/mcp/connection.ts";
import { createRedactor } from "../../core/src/mcp/redact.ts";
import type { McpLogger } from "../../core/src/mcp/types.ts";
import { createMcpSpikeServer } from "../src/mcp/server-spike.ts";

function noopLogger(): McpLogger {
  const fn = (): void => {};
  return { debug: fn, info: fn, warn: fn, error: fn };
}

describe("M6A-A0.2 dual-era MCP server spike", () => {
  it("serves modern 2026-07-28 and legacy 2025-11-25 clients on the same /mcp endpoint", async () => {
    const srv = await createMcpSpikeServer({
      token: "tok-mcp-spike",
      tools: [
        // Intentionally unsorted to verify deterministic sorting by name
        {
          name: "zeta.echo",
          description: "Echoes text with header extraction",
          inputSchema: {
            type: "object",
            required: ["text"],
            properties: {
              text: { type: "string", "x-mcp-header": "Text" },
              count: { type: "integer", "x-mcp-header": "Count" },
            },
          },
          handler: async (args) => ({
            echoed: `${String(args.text ?? "")}#${String(args.count ?? 1)}`,
          }),
        },
        {
          name: "alpha.status",
          description: "Returns status",
          inputSchema: {
            type: "object",
            properties: {},
          },
          handler: async () => ({ status: "ok" }),
        },
      ],
    });

    try {
      // 1. Modern client (McpConnection from packages/core/src/mcp/connection.ts)
      const def = validateDefinition(
        {
          name: "harness-spike",
          transport: {
            type: "http",
            url: `${srv.url}/mcp`,
            headers: { Authorization: "Bearer tok-mcp-spike" },
          },
          timeouts: { connectMs: 5000, listMs: 5000, callMs: 5000, closeGraceMs: 200 },
        },
        { allowedCommands: [], inlineCodeCommands: [] },
      );

      const modernConn = await McpConnection.open({
        def,
        clock: systemClock,
        logger: noopLogger(),
        redactor: createRedactor(),
        hostEnv: {},
        onToolsChanged: () => {},
        onRemoteClose: () => {},
      });
      try {
        assert.equal(modernConn.protocolVersion, "2026-07-28");
        assert.deepEqual(modernConn.serverInfo, { name: "plur1bus-harness", version: "0.1.0" });
        const modernTools = await modernConn.listTools();
        assert.deepEqual(
          modernTools.map((t) => t.name),
          ["alpha.status", "zeta.echo"],
        );
        assert.equal(modernConn.toolCacheTtlMs, 60_000);

        const modernCall = await modernConn.callTool("zeta.echo", {
          text: "hello modern",
          count: 3,
        });
        assert.equal(modernCall.isError ?? false, false);
        const contentArr = modernCall.content as Array<{ type: string; text: string }>;
        assert.deepEqual(JSON.parse(contentArr[0]!.text), { echoed: "hello modern#3" });

        await modernConn.ping();
      } finally {
        await modernConn.close("graceful");
      }

      // 2. Legacy v1 SDK client (Client + StreamableHTTPClientTransport)
      let observedSessionHeader: string | null = null;
      const sdkTransport = new StreamableHTTPClientTransport(new URL(`${srv.url}/mcp`), {
        requestInit: {
          headers: { Authorization: "Bearer tok-mcp-spike" },
        },
        fetch: async (input, init) => {
          const res = await fetch(input, init);
          if (res.headers.get("mcp-session-id")) {
            observedSessionHeader = res.headers.get("mcp-session-id");
          }
          return res;
        },
      });
      const sdkClient = new Client({ name: "sdk-v1-client", version: "1.0.0" });
      await sdkClient.connect(sdkTransport as unknown as Transport);
      try {
        assert.equal(observedSessionHeader, null);
        assert.equal(sdkTransport.sessionId, undefined);

        const listed = await sdkClient.listTools();
        assert.deepEqual(
          listed.tools.map((t) => t.name),
          ["alpha.status", "zeta.echo"],
        );

        const called = await sdkClient.callTool({
          name: "zeta.echo",
          arguments: { text: "hello legacy", count: 2 },
        });
        assert.equal(called.isError ?? false, false);
        const legacyContent = called.content as Array<{ type: string; text: string }>;
        assert.deepEqual(JSON.parse(legacyContent[0]!.text), { echoed: "hello legacy#2" });
      } finally {
        await sdkClient.close();
      }
    } finally {
      await srv.close();
    }
  });

  it("enforces stateless HTTP rules (405 GET/DELETE, 202 notification, -32600 batch, -32020 header mismatch, -32022 unknown version)", async () => {
    const srv = await createMcpSpikeServer({
      token: "tok-mcp-rules",
      tools: [
        {
          name: "echo",
          description: "Echo tool",
          inputSchema: {
            type: "object",
            required: ["text"],
            properties: {
              text: { type: "string", "x-mcp-header": "Text" },
            },
          },
          handler: async (args) => ({ text: args.text }),
        },
      ],
    });

    try {
      const authHeaders = {
        Authorization: "Bearer tok-mcp-rules",
        "Content-Type": "application/json",
      };

      // GET and DELETE -> 405 with Allow: POST
      for (const method of ["GET", "DELETE"] as const) {
        const res = await fetch(`${srv.url}/mcp`, {
          method,
          headers: { Authorization: "Bearer tok-mcp-rules" },
        });
        assert.equal(res.status, 405);
        assert.equal(res.headers.get("allow"), "POST");
        await res.text();
      }

      // Notification (no id) -> 202 with empty body
      const notifRes = await fetch(`${srv.url}/mcp`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      });
      assert.equal(notifRes.status, 202);
      assert.equal(await notifRes.text(), "");

      // Batch array -> -32600
      const batchRes = await fetch(`${srv.url}/mcp`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }]),
      });
      const batchBody = (await batchRes.json()) as { error?: { code: number } };
      assert.equal(batchBody.error?.code, -32600);

      // Unknown MCP-Protocol-Version -> -32022 with data.supported
      const verRes = await fetch(`${srv.url}/mcp`, {
        method: "POST",
        headers: {
          ...authHeaders,
          "MCP-Protocol-Version": "2099-01-01",
          "Mcp-Method": "server/discover",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "server/discover",
          params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2099-01-01" } },
        }),
      });
      const verBody = (await verRes.json()) as {
        error?: { code: number; data?: { supported?: string[] } };
      };
      assert.equal(verBody.error?.code, -32022);
      assert.ok(verBody.error?.data?.supported?.includes("2026-07-28"));
      assert.ok(verBody.error?.data?.supported?.includes("2025-11-25"));

      // Modern request with mismatched Mcp-Method header -> -32020
      const badMethodRes = await fetch(`${srv.url}/mcp`, {
        method: "POST",
        headers: {
          ...authHeaders,
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": "tools/list",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "server/discover",
          params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
        }),
      });
      const badMethodBody = (await badMethodRes.json()) as { error?: { code: number } };
      assert.equal(badMethodBody.error?.code, -32020);

      // Modern tools/call with mismatched Mcp-Param-Text header -> -32020
      const badParamRes = await fetch(`${srv.url}/mcp`, {
        method: "POST",
        headers: {
          ...authHeaders,
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": "tools/call",
          "Mcp-Name": "echo",
          "Mcp-Param-Text": "wrong",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: {
            name: "echo",
            arguments: { text: "right" },
            _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
          },
        }),
      });
      const badParamBody = (await badParamRes.json()) as { error?: { code: number } };
      assert.equal(badParamBody.error?.code, -32020);
    } finally {
      await srv.close();
    }
  });
});
