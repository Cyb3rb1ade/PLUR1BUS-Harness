import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  encodeMcpHeaderValue,
  McpServerCore,
  MCP_DEFAULT_TOOL_TTL_MS,
  MCP_MAX_BODY_BYTES,
  MCP_SERVER_INFO,
  type McpToolDef,
  SUPPORTED_MCP_SERVER_VERSIONS,
} from "../src/mcp/index.ts";

describe("M6A-A2.1: MCP Server Core (transport-neutral)", () => {
  const tools: McpToolDef[] = [
    {
      name: "zeta.calc",
      description: "Calculates sum",
      inputSchema: {
        type: "object",
        required: ["a", "b"],
        properties: {
          a: { type: "integer", "x-mcp-header": "Number-A" },
          b: { type: "integer", "x-mcp-header": "Number-B" },
        },
      },
      handler: async (args) => ({ sum: Number(args.a) + Number(args.b) }),
    },
    {
      name: "alpha.echo",
      description: "Echoes message",
      inputSchema: {
        type: "object",
        required: ["msg"],
        properties: {
          msg: { type: "string" },
        },
      },
      handler: async (args) => ({ echoed: String(args.msg) }),
    },
  ];

  async function createTestServer() {
    const core = new McpServerCore({ tools, ttlMs: 30_000 });
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/mcp") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
        return;
      }
      await core.handleRequest({ req, res });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as AddressInfo;
    return {
      core,
      url: `http://127.0.0.1:${addr.port}/mcp`,
      close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
    };
  }

  describe("Modern 2026-07-28 Era", () => {
    it("returns deterministic tool ordering, resultType, ttlMs, and cacheScope", async () => {
      const srv = await createTestServer();
      try {
        // tools/list
        const res = await fetch(srv.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Mcp-Protocol-Version": "2026-07-28",
            "Mcp-Method": "tools/list",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/list",
            params: {
              _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
            },
          }),
        });
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.jsonrpc, "2.0");
        assert.equal(data.id, 1);
        assert.equal(data.result.resultType, "complete");
        assert.equal(data.result.ttlMs, 30_000);
        assert.equal(data.result.cacheScope, "private");
        // Verify deterministic sorting: alpha.echo comes before zeta.calc
        assert.equal(data.result.tools[0].name, "alpha.echo");
        assert.equal(data.result.tools[1].name, "zeta.calc");
      } finally {
        await srv.close();
      }
    });

    it("server/discover validates _meta and returns capabilities and serverInfo", async () => {
      const srv = await createTestServer();
      try {
        const res = await fetch(srv.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Mcp-Protocol-Version": "2026-07-28",
            "Mcp-Method": "server/discover",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "server/discover",
            params: {
              _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
            },
          }),
        });
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.result.resultType, "complete");
        assert.deepEqual(data.result.supportedVersions, ["2026-07-28", "2025-11-25"]);
        assert.deepEqual(data.result._meta["io.modelcontextprotocol/serverInfo"], MCP_SERVER_INFO);
      } finally {
        await srv.close();
      }
    });

    it("returns -32020 on missing or mismatched mandatory headers and _meta", async () => {
      const srv = await createTestServer();
      try {
        // Missing Mcp-Method header
        const res1 = await fetch(srv.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Mcp-Protocol-Version": "2026-07-28",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 3,
            method: "tools/list",
            params: {
              _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
            },
          }),
        });
        const d1 = await res1.json();
        assert.equal(d1.error.code, -32020);

        // Mismatched _meta version
        const res2 = await fetch(srv.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Mcp-Protocol-Version": "2026-07-28",
            "Mcp-Method": "tools/list",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 4,
            method: "tools/list",
            params: {
              _meta: { "io.modelcontextprotocol/protocolVersion": "2025-11-25" },
            },
          }),
        });
        const d2 = await res2.json();
        assert.equal(d2.error.code, -32020);

        // Missing Mcp-Name on tools/call
        const res3 = await fetch(srv.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Mcp-Protocol-Version": "2026-07-28",
            "Mcp-Method": "tools/call",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 5,
            method: "tools/call",
            params: {
              name: "alpha.echo",
              arguments: { msg: "hello" },
              _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
            },
          }),
        });
        const d3 = await res3.json();
        assert.equal(d3.error.code, -32020);
      } finally {
        await srv.close();
      }
    });

    it("returns -32022 on unsupported protocol version", async () => {
      const srv = await createTestServer();
      try {
        const res = await fetch(srv.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Mcp-Protocol-Version": "2099-01-01",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 6,
            method: "server/discover",
          }),
        });
        const data = await res.json();
        assert.equal(data.error.code, -32022);
        assert.ok(Array.isArray(data.error.data?.supported));
      } finally {
        await srv.close();
      }
    });

    it("executes tools/call with Mcp-Param-* header validation", async () => {
      const srv = await createTestServer();
      try {
        // Valid tool call with matching Mcp-Param headers
        const res = await fetch(srv.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Mcp-Protocol-Version": "2026-07-28",
            "Mcp-Method": "tools/call",
            "Mcp-Name": encodeMcpHeaderValue("zeta.calc"),
            "Mcp-Param-Number-A": "10",
            "Mcp-Param-Number-B": "25",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 7,
            method: "tools/call",
            params: {
              name: "zeta.calc",
              arguments: { a: 10, b: 25 },
              _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
            },
          }),
        });
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.result.resultType, "complete");
        assert.equal(data.result.isError, false);
        assert.deepEqual(JSON.parse(data.result.content[0].text), { sum: 35 });

        // Tool call with parameter header mismatch -> -32020
        const badRes = await fetch(srv.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Mcp-Protocol-Version": "2026-07-28",
            "Mcp-Method": "tools/call",
            "Mcp-Name": encodeMcpHeaderValue("zeta.calc"),
            "Mcp-Param-Number-A": "10",
            "Mcp-Param-Number-B": "999", // wrong!
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 8,
            method: "tools/call",
            params: {
              name: "zeta.calc",
              arguments: { a: 10, b: 25 },
              _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
            },
          }),
        });
        const badData = await badRes.json();
        assert.equal(badData.error.code, -32020);
      } finally {
        await srv.close();
      }
    });

    it("enforces HTTP 405 on GET and DELETE, 202 on notifications, and -32600 on batch", async () => {
      const srv = await createTestServer();
      try {
        for (const m of ["GET", "DELETE"]) {
          const res = await fetch(srv.url, { method: m });
          assert.equal(res.status, 405);
          assert.equal(res.headers.get("allow"), "POST");
        }

        // Notification (no id) -> 202
        const notifRes = await fetch(srv.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        });
        assert.equal(notifRes.status, 202);

        // Batch -> -32600
        const batchRes = await fetch(srv.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]),
        });
        const batchData = await batchRes.json();
        assert.equal(batchData.error.code, -32600);
      } finally {
        await srv.close();
      }
    });
  });

  describe("Legacy 2025-11-25 Era (v1 McpServer)", () => {
    it("connects via standard v1 SDK Client with StreamableHTTPClientTransport", async () => {
      const srv = await createTestServer();
      const client = new Client({ name: "legacy-v1-tester", version: "1.0.0" }, { capabilities: {} });
      const transport = new StreamableHTTPClientTransport(new URL(srv.url));
      try {
        await client.connect(transport as any);
        const list = await client.listTools();
        assert.equal(list.tools.length, 2);
        assert.equal(list.tools[0]!.name, "alpha.echo");
        assert.equal(list.tools[1]!.name, "zeta.calc");

        const callRes = await client.callTool({
          name: "alpha.echo",
          arguments: { msg: "ping-v1" },
        });
        assert.equal(callRes.isError, false);
        assert.deepEqual(JSON.parse(((callRes as any).content[0] as any).text), { echoed: "ping-v1" });
      } finally {
        await client.close();
        await srv.close();
      }
    });
  });
});
