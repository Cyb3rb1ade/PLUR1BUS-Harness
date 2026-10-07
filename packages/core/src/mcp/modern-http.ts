import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessageSchema, McpError, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { MAX_FRAME_BYTES } from "./stdio.ts";

export const encodeMcpHeader = (value: string): string => /^[\x20-\x7e]*$/.test(value) && value.trim() === value && !(value.startsWith("=?base64?") && value.endsWith("?="))
  ? value : `=?base64?${Buffer.from(value).toString("base64")}?=`;

/** Modern HTTP has request-scoped streams only: no session, GET, DELETE, or SSE replay. */
export class ModernHttpTransport {
  onclose?: Transport["onclose"];
  onerror?: Transport["onerror"];
  onmessage?: Transport["onmessage"];
  private readonly url: URL;
  private readonly fetch: FetchLike;
  private readonly headers: Record<string, string>;
  private readonly pending = new Map<string | number, AbortController>();
  private closed = false;
  private readonly toolHeaders = new Map<string, (args: Record<string, unknown>) => Record<string, string>>();
  constructor(url: URL, fetch: FetchLike, headers: Record<string, string>) { this.url = url; this.fetch = fetch; this.headers = headers; }
  async start(): Promise<void> { if (this.closed) throw new Error("MCP HTTP closed"); }
  setToolHeaders(name: string, extract: (args: Record<string, unknown>) => Record<string, string>): void { this.toolHeaders.set(name, extract); }
  cancel(id: string | number): void { this.pending.get(id)?.abort(); }
  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed || !("method" in message) || !("id" in message)) throw new Error("Modern HTTP requires a request");
    const controller = new AbortController(); this.pending.set(message.id, controller);
    const params = (message.params ?? {}) as Record<string, unknown>;
    const meta = params._meta as Record<string, unknown>;
    const headers = new Headers(this.headers);
    headers.set("content-type", "application/json"); headers.set("accept", "application/json, text/event-stream");
    headers.set("MCP-Protocol-Version", String(meta?.["io.modelcontextprotocol/protocolVersion"]));
    headers.set("Mcp-Method", message.method);
    if (["tools/call", "prompts/get", "resources/read"].includes(message.method)) headers.set("Mcp-Name", encodeMcpHeader(String(params.name ?? params.uri)));
    if (message.method === "tools/call") for (const [key, value] of Object.entries(this.toolHeaders.get(String(params.name))?.((params.arguments ?? {}) as Record<string, unknown>) ?? {})) headers.set(key, value);
    try {
      const response = await this.fetch(this.url, { method: "POST", headers, body: JSON.stringify(message), signal: controller.signal });
      if (!response.ok) {
        let error: unknown;
        try { error = await response.json(); } catch { /* legacy server may return no body */ }
        const parsed = JSONRPCMessageSchema.safeParse(error);
        if (parsed.success && "error" in parsed.data) {
          if (parsed.data.id === null) throw new McpError(parsed.data.error.code, "MCP endpoint rejected probe", parsed.data.error.data);
          this.onmessage?.(parsed.data); return;
        }
        if ([400, 404, 405].includes(response.status)) throw new McpError(-32601, "Legacy MCP endpoint");
        throw new Error(`MCP HTTP refused (${response.status})`);
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) { this.deliver(await response.json(), message.id); return; }
      if (!contentType.includes("text/event-stream") || !response.body) throw new Error("MCP HTTP response content type refused");
      const reader = response.body.getReader(); const decoder = new TextDecoder("utf-8", { fatal: true });
      let buffer = ""; let data: string[] = []; let eventBytes = 0; let final = false;
      try {
        while (!final) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) throw new Error("MCP SSE line exceeds byte limit");
          let end: number;
          while ((end = buffer.search(/[\r\n]/)) >= 0) {
            // A CR at the end of a chunk may be the first half of CRLF.
            if (buffer[end] === "\r" && end === buffer.length - 1) break;
            const line = buffer.slice(0, end); const delimiter = buffer.slice(end, end + 2) === "\r\n" ? 2 : 1;
            buffer = buffer.slice(end + delimiter);
            if (line === "") {
              if (data.length) {
                const parsed = JSON.parse(data.join("\n"));
                final = this.deliver(parsed, message.id);
              }
              data = []; eventBytes = 0;
              if (final) break;
            } else if (line.startsWith("data:")) {
              const value = line.slice(5).replace(/^ /, "");
              eventBytes += Buffer.byteLength(value);
              if (eventBytes > MAX_FRAME_BYTES) throw new Error("MCP SSE event exceeds byte limit");
              data.push(value);
            }
          }
        }
        if (!final && !controller.signal.aborted) throw new Error("MCP response stream ended before a result");
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    } finally { this.pending.delete(message.id); }
  }
  private deliver(raw: unknown, id: number | string): boolean {
    const message = JSONRPCMessageSchema.parse(raw);
    if ("method" in message && "id" in message) throw new Error("Modern MCP server sent an independent request");
    if ("id" in message && message.id !== id) throw new Error("MCP HTTP response id mismatch");
    this.onmessage?.(message);
    return "id" in message;
  }
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true;
    for (const c of this.pending.values()) c.abort(); this.pending.clear(); this.onclose?.();
  }
}
