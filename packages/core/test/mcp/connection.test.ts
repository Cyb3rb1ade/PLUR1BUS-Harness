import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { McpConnection } from "../../src/mcp/connection.ts";
import { createRedactor } from "../../src/mcp/redact.ts";
import { wrapToolResult } from "../../src/mcp/provenance.ts";
import { systemClock } from "../../src/mcp/clock.ts";
import type { McpServerDefinition } from "../../src/mcp/types.ts";
import { startFixtureHttp, type FixtureHttp } from "./helpers/fixture-http.ts";
import { caller, capturingLogger, httpDef, stdioDef, waitDead } from "./helpers/util.ts";

async function open(def: McpServerDefinition, over: Partial<{ redactor: ReturnType<typeof createRedactor> }> = {}) {
  const logger = capturingLogger();
  const conn = await McpConnection.open({ def, clock: systemClock, logger, redactor: over.redactor ?? createRedactor(), hostEnv: {}, onToolsChanged: () => {}, onRemoteClose: () => {} });
  return { conn, logger };
}

let http: FixtureHttp;
const defs: Array<[string, () => McpServerDefinition]> = [["stdio", () => stdioDef()], ["streamable http", () => httpDef(http.url)]];

describe("mcp connection: a fixture tool is listed and called over both transports", { timeout: 60_000 }, async () => {
  http = await startFixtureHttp();
  after(async () => { await http.close(); });

  for (const [label, mk] of defs) {
    it(`${label}: lists tools, calls one, gets the provenance envelope`, async () => {
      const def = mk();
      const { conn } = await open(def);
      try {
        const tools = await conn.listTools();
        assert.ok(tools.some((t) => t.name === "echo" && (t.inputSchema as { type?: string }).type === "object"));
        const raw = await conn.callTool("echo", { text: "hello" });
        const res = wrapToolResult(raw, { server: def.name, tool: "echo", caller, trust: def.trust, redactor: createRedactor(), maxBytes: 4096 });
        assert.deepEqual(res.content, [{ type: "text", text: "echo:hello" }]);
        assert.equal(res.isError, false);
        assert.equal(res.provenance.origin.system, `mcp:${def.name}`);
        assert.equal(res.provenance.origin.principal, caller.principal);
        assert.equal(res.provenance.origin.trust, "untrusted");
        assert.equal(res.provenance.hops, 1);
        assert.deepEqual(res.provenance.transformedBy, []);
      } finally { await conn.close("graceful"); }
    });
    it(`${label}: a tool-reported error is a result, not an exception`, async () => {
      const { conn } = await open(mk());
      try {
        const raw = await conn.callTool("fail", {});
        assert.equal(raw.isError, true);
      } finally { await conn.close("graceful"); }
    });
    it(`${label}: reports a tool's MCP App as uiResourceUri`, async () => {
      const { conn } = await open(mk());
      try {
        const app = (await conn.listTools()).find((t) => t.name === "app");
        assert.equal(app?.uiResourceUri, "ui://fixture/app");
        assert.equal((await conn.listTools()).find((t) => t.name === "echo")?.uiResourceUri, undefined);
      } finally { await conn.close("graceful"); }
    });
  }

  it("stdio: a graceful close ends the child process", async () => {
    const { conn } = await open(stdioDef());
    const pid = conn.processId!;
    assert.ok(pid > 0);
    await conn.close("graceful");
    assert.ok(await waitDead(pid), "child still alive after close");
  });
  it("http: sends the declared headers", async () => {
    const { conn } = await open(httpDef(http.url, {}, { "X-Fixture-Auth": "abc-123456" }));
    try { await conn.listTools(); assert.equal(http.lastHeaders()["x-fixture-auth"], "abc-123456"); } finally { await conn.close("graceful"); }
  });
  it("http: fixture incarnations differ even when their numeric PID is identical", async () => {
    const second = await startFixtureHttp();
    const connections: McpConnection[] = [];
    try {
      const first = (await open(httpDef(http.url))).conn;
      connections.push(first);
      const next = (await open(httpDef(second.url))).conn;
      connections.push(next);
      const identity = async (conn: McpConnection) => {
        const result = await conn.callTool("pid", { includeInstance: true });
        assert.ok(Array.isArray(result.content));
        return JSON.parse((result.content[0] as { text: string }).text) as { pid: number; instanceId: string };
      };
      const before = await identity(first);
      assert.equal(before.pid, process.pid);
      assert.deepEqual(await identity(first), before, "one live fixture keeps its identity");
      const after = await identity(next);
      assert.equal(after.pid, before.pid, "both servers deliberately run in this same process");
      assert.match(before.instanceId, /^[0-9a-f-]{36}$/);
      assert.match(after.instanceId, /^[0-9a-f-]{36}$/);
      assert.notEqual(after.instanceId, before.instanceId);
    } finally {
      await Promise.all(connections.map(conn => conn.close("graceful")));
      await second.close();
    }
  });
  it("connect failure maps to connect-failed and leaves no child", async () => {
    const def = stdioDef({ transport: { type: "stdio", command: process.execPath, args: ["-e", "process.exit(3)"] } });
    await assert.rejects(open(def), (e: { code?: string }) => e.code === "connect-failed");
  });
});
