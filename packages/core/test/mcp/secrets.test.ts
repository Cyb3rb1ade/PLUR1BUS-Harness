// ADR-014 §7: server stderr, results, errors and log fields never carry a declared secret; the child inherits nothing
// beyond what the definition declares.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { McpRegistry } from "../../src/mcp/registry.ts";
import { startFixtureHttp } from "./helpers/fixture-http.ts";
import { caller, capturingLogger, NODE, stdioDef } from "./helpers/util.ts";

const MARK = `marker-${process.pid}-7f3a9c`;
const HOST_MARK = `hostmarker-${process.pid}-c41d2e`;
const UNRELATED = `unrelated-${process.pid}-0b8e55`;

const text = (r: { content: Array<Record<string, unknown>> }) => String(r.content[0]!.text);
const until = async (fn: () => boolean, ms = 5000) => { const end = Date.now() + ms; while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 10)); return fn(); };

describe("mcp secrets stay out of logs, results and errors", { timeout: 60_000 }, () => {
  it("redacts a declared secret from stderr, the tool result and every log line (marker test)", async () => {
    const logger = capturingLogger();
    const reg = new McpRegistry({ logger, hostEnv: { FROM_HOST: HOST_MARK, ["P1B_NOT_DECLARED"]: UNRELATED }, policy: { allowedCommands: [NODE] } });
    process.env.P1B_NOT_DECLARED = UNRELATED; // the harness's own environment: must not reach the child
    try {
      const d = stdioDef({}, { MCP_TEST_SECRET: MARK, LOG_LEVEL: "visible-value" });
      reg.register({ name: d.name, transport: { ...d.transport, fromHost: ["FROM_HOST"] }, timeouts: d.timeouts });

      for (const [name, marker] of [["MCP_TEST_SECRET", MARK], ["FROM_HOST", HOST_MARK]] as const) {
        const r = await reg.callTool("fixture", "leak_env", { name }, caller);
        assert.ok(!JSON.stringify(r).includes(marker), `${name} leaked into the tool result`);
        assert.ok(r.provenance.transformedBy.includes("redact"), "the envelope says the result was redacted");
        assert.match(text(r), /value=\[REDACTED\]/);
      }
      // The server wrote the marker to stderr; wait for the captured (and redacted) line to be logged.
      assert.ok(await until(() => logger.lines.filter((l) => l.msg === "mcp.server.stderr" && String(l.fields?.line).includes("leaking")).length >= 2), "stderr was captured");
      const all = logger.text();
      for (const m of [MARK, HOST_MARK]) assert.ok(!all.includes(m), "a secret reached the log");
      assert.ok(all.includes("[REDACTED]"));
      // Env is logged by name, never by value.
      const spawn = logger.lines.find((l) => l.msg === "mcp.server.spawn");
      assert.deepEqual(spawn?.fields?.envNames, ["FROM_HOST", "LOG_LEVEL", "MCP_TEST_SECRET"]);
      assert.ok(!all.includes("visible-value"), "even a non-secret env value is not logged");

      // Nothing undeclared is inherited.
      const u = await reg.callTool("fixture", "leak_env", { name: "P1B_NOT_DECLARED" }, caller);
      assert.equal(text(u), "value=");
    } finally { delete process.env.P1B_NOT_DECLARED; await reg.shutdown(); }
  });

  it("a server that prints a secret and dies at start-up leaks it neither in the error nor in the log", async () => {
    const logger = capturingLogger();
    const reg = new McpRegistry({ logger, hostEnv: {}, policy: { allowedCommands: [NODE] } });
    try {
      reg.register({ name: "dies", transport: { type: "stdio", command: NODE, args: ["-e", "console.error('boot token ' + process.env.MCP_TEST_SECRET); process.exit(2)"], env: { MCP_TEST_SECRET: MARK } }, timeouts: { connectMs: 10_000, closeGraceMs: 300 } });
      await assert.rejects(reg.listTools("dies", caller), (e: Error) => { assert.ok(!e.message.includes(MARK), e.message); return true; });
      assert.ok(await until(() => logger.lines.some((l) => l.msg === "mcp.server.stderr")), "the stderr line was captured");
      assert.ok(!logger.text().includes(MARK), "the secret reached the log");
      assert.ok(!JSON.stringify(reg.status("dies", caller.agentId)).includes(MARK), "the secret reached the status");
    } finally { await reg.shutdown(); }
  });

  it("an http header secret never reaches the log or the status", async () => {
    const http = await startFixtureHttp();
    const logger = capturingLogger();
    const reg = new McpRegistry({ logger, hostEnv: {}, policy: { allowedCommands: [NODE] } });
    try {
      reg.register({ name: "remote", transport: { type: "http", url: http.url, headers: { Authorization: `Bearer ${MARK}` } } });
      await reg.callTool("remote", "echo", { text: "x" }, caller);
      assert.equal(http.lastHeaders().authorization, `Bearer ${MARK}`, "the header is sent");
      assert.ok(!logger.text().includes(MARK) && !JSON.stringify(reg.status("remote", caller.agentId)).includes(MARK));
    } finally { await reg.shutdown(); await http.close(); }
  });

  it("caps and rate-limits stderr so a chatty server cannot flood the log", async () => {
    const logger = capturingLogger();
    const reg = new McpRegistry({ logger, hostEnv: {}, policy: { allowedCommands: [NODE] } });
    try {
      reg.register({ name: "chatty", transport: { type: "stdio", command: NODE, args: ["-e", "for(let i=0;i<500;i++)console.error('x'.repeat(5000));setInterval(()=>{},1000)"] }, timeouts: { connectMs: 1000, closeGraceMs: 300 } });
      await assert.rejects(reg.listTools("chatty", caller)); // never answers initialize; the burst is already in
      const lines = logger.lines.filter((l) => l.msg === "mcp.server.stderr");
      assert.ok(lines.length <= 20, `${lines.length} stderr lines logged`);
      assert.ok(lines.every((l) => String(l.fields?.line).length <= 2001));
    } finally { await reg.shutdown(); }
  });
});
