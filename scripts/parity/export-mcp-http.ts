import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { McpConnection } from "../../packages/core/src/mcp/connection.ts";
import { createMcpFetch } from "../../packages/core/src/mcp/http.ts";
import { systemClock } from "../../packages/core/src/mcp/clock.ts";
import { createRedactor } from "../../packages/core/src/mcp/redact.ts";
import { modernHandler } from "../../packages/core/test/mcp/helpers/dual-fixture.ts";
import { capturingLogger, httpDef } from "../../packages/core/test/mcp/helpers/util.ts";
import { exporterMain } from "./lib.mjs";

const selected = ["accept", "content-type", "mcp-method", "mcp-name", "mcp-protocol-version", "mcp-session-id", "last-event-id", "mcp-param-text"] as const;
type Message = Record<string, unknown>;
type Reply = { status: number; mime?: string; session?: string; bytes?: string };
type Answer = (method: string, headers: IncomingHttpHeaders, message: Message | undefined) => Reply;

async function listener(answer: Answer) {
  const exchanges: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    const message = raw.length ? JSON.parse(raw.toString()) as Message : undefined;
    const reply = answer(request.method!, request.headers, message);
    const headers = { ...(reply.mime ? { "content-type": reply.mime } : {}), ...(reply.session ? { "mcp-session-id": reply.session } : {}) };
    exchanges.push({
      request: {
        method: request.method, path: request.url,
        headers: Object.fromEntries(selected.filter(key => request.headers[key] !== undefined).map(key => [key, request.headers[key]])),
        bodyBase64: raw.toString("base64"),
      },
      response: { status: reply.status, headers, chunksBase64: reply.bytes ? [Buffer.from(reply.bytes).toString("base64")] : [] },
    });
    response.writeHead(reply.status, headers).end(reply.bytes);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  return { url, exchanges, close: async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}

const json = (reply: unknown, session?: string): Reply => ({ status: 200, mime: "application/json", bytes: JSON.stringify(reply), session });
const sse = (reply: unknown, id: string): Reply => ({
  status: 200, mime: "text/event-stream",
  bytes: `: fixture\r\nid: ${id}\r\nevent: message\r\ndata: ${JSON.stringify(reply)}\r\n\r\n`,
});

async function modern() {
  const fixture = await listener((_method, _headers, message) => {
    if (!message) throw new Error("missing modern fixture request");
    const reply = modernHandler(message);
    if (message.method === "server/discover") {
      (reply.result as Message).capabilities = { tools: {}, resources: {}, prompts: {} };
    }
    return message.method === "tools/call" ? sse(reply, "complete") : json(reply);
  });
  try {
    const conn = await McpConnection.open({
      def: httpDef(fixture.url),
      clock: systemClock, logger: capturingLogger(), redactor: createRedactor(),
      hostEnv: {}, onToolsChanged: () => {}, onRemoteClose: () => {},
    });
    try {
      const tools = await conn.listTools();
      const result = await conn.callTool("echo", { text: "café" });
      const resource = await conn.readResource("test://one");
      const prompt = await conn.getPrompt("greet");
      return { name: "modern", transport: "http", exchanges: fixture.exchanges,
        observed: { version: conn.protocolVersion, server: conn.serverInfo, tools: tools.map(tool => tool.name), result, resource, prompt } };
    } finally { await conn.close("graceful"); }
  } finally { await fixture.close(); }
}

async function legacy() {
  const version = "2025-11-25";
  const session = "fixture-session";
  const fixture = await listener((method, _headers, message) => {
    const response = (result: unknown) => ({ jsonrpc: "2.0", id: message?.id, result });
    if (method === "DELETE") return { status: 204 };
    if (method === "GET") return sse({ jsonrpc: "2.0", id: 1, result: { tools: [] } }, "result");
    if (message?.method === "initialize") return json(response({ protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: "fixture-legacy", version: "1" } }), session);
    if (message?.method === "notifications/initialized") return { status: 202 };
    return { status: 200, mime: "text/event-stream", bytes: "id: primed\nretry: 1\ndata:\n\n" };
  });
  try {
    const fetch = createMcpFetch();
    const endpoint = new URL(fixture.url);
    const base = { "accept": "application/json, text/event-stream" };
    const post = (body: Message, sessionHeaders = {}) => fetch(endpoint, {
      method: "POST", headers: { ...base, ...sessionHeaders, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const ready = await post({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: version, capabilities: {}, clientInfo: { name: "plur1bus-harness", version: "0.1.0" } } });
    const observed = { ready: await ready.json(), session: ready.headers.get("mcp-session-id") };
    const headers = { "mcp-protocol-version": version, "mcp-session-id": observed.session! };
    const initialized = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, headers);
    await initialized.text();
    const list = await post({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, headers);
    const resume = await fetch(endpoint, { method: "GET", headers: { ...base, ...headers, "last-event-id": "primed" } });
    const first = await list.text();
    const final = await resume.text();
    const deleted = await fetch(endpoint, { method: "DELETE", headers: { ...base, ...headers } });
    return { name: "legacy", transport: "http", exchanges: fixture.exchanges, observed: { ...observed, initialized: initialized.status, first, final, deleted: deleted.status } };
  } finally { await fixture.close(); }
}

export async function recordMcpHttp() {
  return { http: { source: "packages/core/src/mcp", cases: [await modern(), await legacy()] } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await exporterMain({ area: "mcp", build: recordMcpHttp });
}
