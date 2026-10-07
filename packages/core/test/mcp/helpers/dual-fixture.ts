// In-process stdio pipes and a loopback HTTP endpoint share this wire-level fixture, independent of the SDK client.
import { PassThrough } from "node:stream";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema, ListResourceTemplatesRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema, SubscribeRequestSchema, UnsubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { BoundedStdioTransport } from "../../../src/mcp/stdio.ts";

export const tool = { name: "echo", inputSchema: { type: "object", properties: { text: { type: "string", "x-mcp-header": "Text" } } }, outputSchema: { type: "object", required: ["answer"], properties: { answer: { type: "string" } } } };
export function legacyServer() {
  const server = new Server({ name: "conformance", version: "1" }, { capabilities: { tools: { listChanged: true }, resources: { subscribe: true, listChanged: true }, prompts: { listChanged: true } } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [tool] }));
  server.setRequestHandler(CallToolRequestSchema, async req => ({ content: [{ type: "text", text: "ok" }], structuredContent: { answer: req.params.arguments?.text ?? "ok" } }));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ uri: "test://one", name: "one" }] }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [{ uriTemplate: "test://{id}", name: "template" }] }));
  server.setRequestHandler(ReadResourceRequestSchema, async () => ({ contents: [{ uri: "test://one", text: "resource" }] }));
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [{ name: "greet" }] }));
  server.setRequestHandler(GetPromptRequestSchema, async () => ({ messages: [{ role: "user", content: { type: "text", text: "hello" } }] }));
  server.setRequestHandler(SubscribeRequestSchema, async () => ({}));
  server.setRequestHandler(UnsubscribeRequestSchema, async () => ({}));
  return server;
}
export async function pipedLegacy() {
  const a = new PassThrough(); const b = new PassThrough();
  const client = new BoundedStdioTransport({ input: a, output: b });
  const transport = new BoundedStdioTransport({ input: b, output: a });
  const server = legacyServer(); await server.connect(transport);
  return { client, server, close: () => server.close() };
}
export function modernHandler(message: Record<string, unknown>): Record<string, unknown> {
  const method = message.method as string; const params = (message.params ?? {}) as Record<string, unknown>;
  const meta = params._meta as Record<string, unknown>;
  if (meta?.["io.modelcontextprotocol/protocolVersion"] !== "2026-07-28") return { jsonrpc: "2.0", id: message.id, error: { code: -32022, message: "unsupported", data: { supported: ["2026-07-28"], requested: "unknown" } } };
  const cache = { ttlMs: 0, cacheScope: "private" };
  let result: Record<string, unknown>;
  switch (method) {
    case "server/discover": result = { ...cache, supportedVersions: ["2026-07-28"], capabilities: { tools: { listChanged: true }, resources: { subscribe: true }, prompts: {} }, _meta: { "io.modelcontextprotocol/serverInfo": { name: "conformance", version: "1" } } }; break;
    case "tools/list": result = { ...cache, tools: [tool] }; break;
    case "tools/call": result = { content: [{ type: "text", text: "ok" }], structuredContent: { answer: (params.arguments as { text?: unknown })?.text ?? "ok" } }; break;
    case "resources/list": result = { ...cache, resources: [{ uri: "test://one", name: "one" }] }; break;
    case "resources/templates/list": result = { ...cache, resourceTemplates: [{ uriTemplate: "test://{id}", name: "template" }] }; break;
    case "resources/read": result = { ...cache, contents: [{ uri: "test://one", text: "resource" }] }; break;
    case "prompts/list": result = { ...cache, prompts: [{ name: "greet" }] }; break;
    case "prompts/get": result = { messages: [{ role: "user", content: { type: "text", text: "hello" } }] }; break;
    default: return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown method" } };
  }
  return { jsonrpc: "2.0", id: message.id, result: { resultType: "complete", ...result } };
}
export async function pipedModern(handler: (message: Record<string, unknown>) => Record<string, unknown> | undefined = modernHandler) {
  const a = new PassThrough(); const b = new PassThrough();
  const client = new BoundedStdioTransport({ input: a, output: b });
  const transport = new BoundedStdioTransport({ input: b, output: a });
  const requests: Record<string, unknown>[] = [];
  transport.onmessage = message => { const m = message as unknown as Record<string, unknown>; requests.push(m);
    if (m.method === "subscriptions/listen") { void transport.send({ jsonrpc: "2.0", method: "notifications/subscriptions/acknowledged", params: { notifications: (m.params as Record<string, unknown>).notifications, _meta: { "io.modelcontextprotocol/subscriptionId": m.id } } }); return; }
    if ("id" in m) { const response = handler(m); if (response) void transport.send(response as never); } };
  await transport.start();
  return { client, transport, requests, close: () => transport.close() };
}
export async function httpModern(handler = modernHandler) {
  const requests: Array<{ method: string; headers: Record<string, unknown>; body: Record<string, unknown> }> = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += String(chunk);
    const message = JSON.parse(body) as Record<string, unknown>;
    requests.push({ method: req.method!, headers: req.headers, body: message });
    if (message.method === "subscriptions/listen") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/subscriptions/acknowledged", params: { notifications: (message.params as Record<string, unknown>).notifications, _meta: { "io.modelcontextprotocol/subscriptionId": message.id } } })}\n\n`);
      return;
    }
    const result = handler(message);
    res.writeHead(200, { "content-type": req.url === "/json" ? "application/json" : "text/event-stream" });
    res.end(req.url === "/json" ? JSON.stringify(result) : `: keepalive\r\nevent: message\r\ndata: ${JSON.stringify(result)}\r\n\r\n`);
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, requests, close: async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); } };
}
