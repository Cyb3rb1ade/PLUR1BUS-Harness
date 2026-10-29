import assert from "node:assert/strict";
import { createServer } from "node:http";
import { PassThrough } from "node:stream";
import test from "node:test";
import { runMcpMain } from "../../src/mcp/stdio-server.ts";

test("runMcpMain fails with exit code 2 if PLUR1BUS_MCP_TOKEN is missing", async () => {
  const orig = process.env.PLUR1BUS_MCP_TOKEN;
  delete process.env.PLUR1BUS_MCP_TOKEN;
  try {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();

    let errOutput = "";
    stderr.on("data", (c) => (errOutput += c.toString()));

    const code = await runMcpMain(["--home", "/tmp", "--agent", "bernd"], {
      stdin,
      stdout,
      stderr,
    });

    assert.equal(code, 2);
    assert.ok(errOutput.includes("PLUR1BUS_MCP_TOKEN"));
  } finally {
    if (orig !== undefined) process.env.PLUR1BUS_MCP_TOKEN = orig;
  }
});

test("runMcpMain serves stdio JSON-RPC in direct mode", async () => {
  process.env.PLUR1BUS_MCP_TOKEN = "test-token";
  try {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();

    const responses: any[] = [];
    stdout.on("data", (chunk) => {
      const lines = chunk.toString().trim().split("\n");
      for (const line of lines) {
        if (line) responses.push(JSON.parse(line));
      }
    });

    const runPromise = runMcpMain(["--home", "/tmp", "--agent", "bernd"], {
      stdin,
      stdout,
      stderr,
    });

    // 1. initialize
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(responses.length, 1);
    assert.equal(responses[0].id, 1);
    assert.equal(responses[0].result.serverInfo.name, "plur1bus-harness");

    // 2. ping
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping", params: {} }) + "\n");
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(responses.length, 2);
    assert.equal(responses[1].id, 2);
    assert.deepEqual(responses[1].result, {});

    // 3. tools/list
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }) + "\n");
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(responses.length, 3);
    assert.equal(responses[2].id, 3);
    assert.ok(Array.isArray(responses[2].result.tools));

    // 4. tools/call
    stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "agent_status" } }) + "\n",
    );
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(responses.length, 4);
    assert.equal(responses[3].id, 4);
    assert.equal(responses[3].result.isError, false);

    // End stdin -> process exits
    stdin.end();
    const exitCode = await runPromise;
    assert.equal(exitCode, 0);
  } finally {
    delete process.env.PLUR1BUS_MCP_TOKEN;
  }
});

test("runMcpMain bridges stdio to HTTP endpoint when apiUrl is configured", async () => {
  process.env.PLUR1BUS_MCP_TOKEN = "bridge-token-xyz";
  const receivedHeaders: Record<string, string | string[] | undefined>[] = [];
  const receivedBodies: string[] = [];

  const fakeApi = createServer(async (req, res) => {
    receivedHeaders.push(req.headers);
    let body = "";
    for await (const chunk of req) body += chunk;
    receivedBodies.push(body);

    const parsed = JSON.parse(body);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: parsed.id,
        result: { bridged: true, echoMethod: parsed.method },
      }),
    );
  });

  await new Promise<void>((resolve) => fakeApi.listen(0, "127.0.0.1", resolve));
  const addr = fakeApi.address() as { port: number };
  const apiUrl = `http://127.0.0.1:${addr.port}/mcp`;

  try {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();

    const responses: any[] = [];
    stdout.on("data", (chunk) => {
      const lines = chunk.toString().trim().split("\n");
      for (const line of lines) {
        if (line) responses.push(JSON.parse(line));
      }
    });

    const runPromise = runMcpMain(
      ["--home", "/tmp", "--agent", "karl"],
      { stdin, stdout, stderr },
      { apiUrl },
    );

    // Send tools/call via stdio
    stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 101,
        method: "tools/call",
        params: { name: "memory_recall", arguments: { query: "hello" } },
      }) + "\n",
    );

    await new Promise((r) => setTimeout(r, 50));

    assert.equal(receivedBodies.length, 1);
    assert.equal(receivedHeaders[0]!["authorization"], "Bearer bridge-token-xyz");
    assert.equal(receivedHeaders[0]!["mcp-name"], "memory_recall");
    assert.equal(receivedHeaders[0]!["mcp-method"], "tools/call");

    assert.equal(responses.length, 1);
    assert.equal(responses[0]!.id, 101);
    assert.equal((responses[0]!.result as Record<string, unknown>).bridged, true);

    stdin.end();
    const exitCode = await runPromise;
    assert.equal(exitCode, 0);
  } finally {
    fakeApi.close();
    delete process.env.PLUR1BUS_MCP_TOKEN;
  }
});
