import { createServer } from "node:http";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { runMcpMain } from "../../packages/core/src/mcp/stdio-server.ts";
import { exporterMain } from "./lib.mjs";

export async function recordBridge() {
  const token = "fixture-bridge-token";
  const old = process.env.PLUR1BUS_MCP_TOKEN;
  process.env.PLUR1BUS_MCP_TOKEN = token;
  const fixtures = [
    {
      input: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      status: 200,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }),
    },
    {
      input: { jsonrpc: "2.0", method: "notifications/initialized" },
      status: 202,
      body: "",
    },
  ];
  let replyIndex = 0;
  const server = createServer((request, reply) => {
    request.resume();
    request.once("end", () => {
      const fixture = fixtures[replyIndex++];
      reply.writeHead(fixture.status, { "content-type": "application/json" });
      reply.end(fixture.body);
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture listener unavailable");
    const apiUrl = `http://127.0.0.1:${address.port}/mcp`;
    const outputs = [];
    for (const fixture of fixtures) {
      const chunks: string[] = [];
      const exit = await runMcpMain([], {
        stdin: Readable.from([JSON.stringify(fixture.input) + "\n"]),
        stdout: new Writable({ write(chunk, _encoding, done) { chunks.push(chunk.toString()); done(); } }),
        stderr: new Writable({ write(_chunk, _encoding, done) { done(); } }),
      }, { apiUrl });
      if (exit !== 0) throw new Error("fixture bridge failed");
      const output = chunks.join("").trim();
      outputs.push({ ...fixture, result: output ? JSON.parse(output) : null });
    }
    if (replyIndex !== fixtures.length) throw new Error("incomplete fixture exchange");
    return { bridge: { source: "packages/core/src/mcp/stdio-server.ts", cases: outputs } };
  } finally {
    server.close();
    if (old === undefined) delete process.env.PLUR1BUS_MCP_TOKEN;
    else process.env.PLUR1BUS_MCP_TOKEN = old;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await exporterMain({ area: "mcp", build: recordBridge });
}
