import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { McpConnection } from "../../packages/core/src/mcp/connection.ts";
import { BoundedStdioTransport } from "../../packages/core/src/mcp/stdio.ts";
import { systemClock } from "../../packages/core/src/mcp/clock.ts";
import { createRedactor } from "../../packages/core/src/mcp/redact.ts";
import { legacyServer, modernHandler } from "../../packages/core/test/mcp/helpers/dual-fixture.ts";
import { capturingLogger, stdioDef } from "../../packages/core/test/mcp/helpers/util.ts";
import { exporterMain } from "./lib.mjs";

async function record(mode: "modern" | "legacy") {
  const outgoing = new PassThrough();
  const incoming = new PassThrough();
  const request: Buffer[] = [];
  const response: Buffer[] = [];
  outgoing.on("data", (chunk: Buffer) => request.push(chunk));
  incoming.on("data", (chunk: Buffer) => response.push(chunk));
  const child = new BoundedStdioTransport({ input: incoming, output: outgoing });
  const parent = new BoundedStdioTransport({ input: outgoing, output: incoming });
  const legacy = mode === "legacy" ? legacyServer() : undefined;
  if (legacy) await legacy.connect(child);
  else {
    child.onmessage = message => {
      const rpc = message as Record<string, unknown>;
      if (!("id" in rpc)) return;
      const reply = modernHandler(rpc);
      if (rpc.method === "server/discover") (reply.result as Record<string, unknown>).capabilities = { tools: {}, resources: {}, prompts: {} };
      void child.send(reply as never);
    };
    await child.start();
  }
  const conn = await McpConnection.open({
    def: stdioDef(), knownVersion: mode === "modern" ? "2026-07-28" : "2025-11-25",
    clock: systemClock, logger: capturingLogger(), redactor: createRedactor(), hostEnv: {},
    onToolsChanged: () => {}, onRemoteClose: () => {}, transportFactory: () => parent,
  });
  try {
    const tools = await conn.listTools();
    const result = await conn.callTool("echo", { text: "café" });
    return { mode, request: Buffer.concat(request).toString("base64"),
      response: Buffer.concat(response).toString("base64"), observed: { tools: tools.map(tool => tool.name), result } };
  } finally {
    await conn.close("graceful");
    await legacy?.close();
    await child.close();
  }
}

export async function recordMcpStdio() {
  return { stdio: { source: "packages/core/src/mcp/stdio.ts", cases: [await record("modern"), await record("legacy")] } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await exporterMain({ area: "mcp", build: recordMcpStdio });
}
