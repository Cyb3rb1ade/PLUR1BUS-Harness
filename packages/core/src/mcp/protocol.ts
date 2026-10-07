import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ResultSchema, ToolListChangedNotificationSchema, ResourceListChangedNotificationSchema, ResourceUpdatedNotificationSchema, PromptListChangedNotificationSchema,
  ListRootsRequestSchema, CreateMessageRequestSchema, ElicitRequestSchema, McpError, ErrorCode, type JSONRPCMessage,
  type ServerCapabilities, type ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { dispatchPort, portCapabilities, type McpClientPorts } from "./ports.ts";
import { ModernHttpTransport } from "./modern-http.ts";

export const SUPPORTED_MCP_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"] as const;
export type McpProtocolVersion = typeof SUPPORTED_MCP_VERSIONS[number];
export const MCP_CLIENT_INFO = { name: "plur1bus-harness", version: "0.1.0" };
export interface ProtocolOptions {
  server: string;
  ports: McpClientPorts;
  portTimeoutMs?: number;
  onNotification(method: string, params: Record<string, unknown>): void;
  onClose(): void;
  onError(error: Error): void;
}
export interface McpProtocol {
  readonly capabilities: ClientCapabilities;
  readonly serverCapabilities: ServerCapabilities;
  readonly serverInfo: { name: string; version: string } | null;
  readonly version: McpProtocolVersion;
  connect(transport: Transport, options: RequestOptions): Promise<void>;
  request(method: string, params: Record<string, unknown>, options: RequestOptions): Promise<Record<string, unknown>>;
  notification(method: string, params?: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

export class LegacyProtocol implements McpProtocol {
  readonly capabilities: ClientCapabilities;
  readonly client: Client;
  version: McpProtocolVersion = "2025-11-25";
  private readonly o: ProtocolOptions;
  constructor(o: ProtocolOptions) {
    this.o = o; this.capabilities = portCapabilities(o.ports);
    this.client = new Client(MCP_CLIENT_INFO, { capabilities: this.capabilities });
    this.client.onclose = o.onClose; this.client.onerror = o.onError;
    for (const schema of [ToolListChangedNotificationSchema, ResourceListChangedNotificationSchema, ResourceUpdatedNotificationSchema, PromptListChangedNotificationSchema]) {
      this.client.setNotificationHandler(schema, n => o.onNotification(n.method, (n.params ?? {}) as Record<string, unknown>));
    }
    for (const schema of [ListRootsRequestSchema, CreateMessageRequestSchema, ElicitRequestSchema]) {
      const method = schema.shape.method.value;
      // A disabled feature uses the SDK's method-not-found response; do not register or advertise it.
      if (method === "roots/list" && !o.ports.roots || method === "sampling/createMessage" && !o.ports.sampling || method === "elicitation/create" && !o.ports.elicitation) continue;
      this.client.setRequestHandler(schema, (request, extra) => dispatchPort(method, request.params, o.ports, { server: o.server, signal: extra.signal, ...(o.portTimeoutMs ? { timeoutMs: o.portTimeoutMs } : {}) }));
    }
  }
  get serverCapabilities(): ServerCapabilities { return this.client.getServerCapabilities() ?? {}; }
  get serverInfo(): { name: string; version: string } | null { const info = this.client.getServerVersion(); return info ? { name: info.name, version: info.version } : null; }
  async connect(transport: Transport, options: RequestOptions): Promise<void> {
    const setVersion = transport.setProtocolVersion?.bind(transport);
    transport.setProtocolVersion = version => { if (!SUPPORTED_MCP_VERSIONS.includes(version as McpProtocolVersion) || version === "2026-07-28") throw new Error("MCP unsupported legacy version"); this.version = version as McpProtocolVersion; setVersion?.(version); };
    await this.client.connect(transport, options);
    // stdio has no version header hook in the SDK; observe the initialization response as well.
  }
  async request(method: string, params: Record<string, unknown>, options: RequestOptions): Promise<Record<string, unknown>> {
    const capability = method.split("/")[0];
    if (["tools", "resources", "prompts"].includes(capability!) && !(capability! in this.serverCapabilities)) throw new McpError(ErrorCode.MethodNotFound, "MCP server capability unavailable");
    return await this.client.request({ method, params }, ResultSchema, options);
  }
  async notification(method: string, params?: Record<string, unknown>): Promise<void> { await this.client.notification({ method, ...(params ? { params } : {}) }); }
  async close(): Promise<void> { await this.client.close(); }
}

interface Pending { method: string; requested?: Record<string, unknown>; acknowledged?: Record<string, unknown>; lastProgress?: number; resolve(result: Record<string, unknown>): void; reject(error: unknown): void; detach(): void; progress?: RequestOptions["onprogress"] }
/** The pinned official SDK has no modern client. This small peer implements only the modern core protocol. */
export class ModernProtocol implements McpProtocol {
  readonly capabilities: ClientCapabilities;
  readonly version = "2026-07-28";
  serverCapabilities: ServerCapabilities = {};
  serverInfo: { name: string; version: string } | null = null;
  private readonly o: ProtocolOptions;
  private transport: Transport | undefined;
  private readonly pending = new Map<string | number, Pending>();
  private id = 0;
  constructor(o: ProtocolOptions) { this.o = o; this.capabilities = portCapabilities(o.ports, true); }
  async connect(transport: Transport, options: RequestOptions): Promise<void> {
    this.transport = transport;
    transport.onclose = () => { this.rejectAll(); this.o.onClose(); };
    transport.onerror = this.o.onError;
    transport.onmessage = message => this.receive(message);
    await transport.start();
    const discovered = await this.request("server/discover", {}, options);
    if (!Array.isArray(discovered.supportedVersions) || !discovered.supportedVersions.includes(this.version)) throw new McpError(-32022, "MCP modern version unsupported", { supported: discovered.supportedVersions });
    if (!discovered.capabilities || typeof discovered.capabilities !== "object") throw new Error("MCP discovery capabilities missing");
    this.serverCapabilities = discovered.capabilities as ServerCapabilities;
    const info = (discovered._meta as Record<string, unknown> | undefined)?.["io.modelcontextprotocol/serverInfo"] as { name?: unknown; version?: unknown } | undefined;
    if (typeof info?.name === "string" && typeof info.version === "string") this.serverInfo = { name: info.name, version: info.version };
  }
  async request(method: string, params: Record<string, unknown>, options: RequestOptions): Promise<Record<string, unknown>> {
    const capability = method.split("/")[0];
    if (["tools", "resources", "prompts"].includes(capability!) && !(capability! in this.serverCapabilities)) throw new McpError(ErrorCode.MethodNotFound, "MCP server capability unavailable");
    let next = params;
    // Each MRTR retry gets a fresh request ID. A single outer deadline includes all input ports and retries.
    for (let round = 0; round < 8; round++) {
      const result = await this.once(method, next, options);
      if (result.resultType === "complete") return result;
      if (result.resultType !== "input_required") throw new Error("MCP modern resultType missing or invalid");
      if (!["tools/call", "resources/read", "prompts/get"].includes(method)) throw new Error("MCP MRTR result not permitted for this method");
      const inputs = result.inputRequests;
      if (inputs !== undefined && (!inputs || typeof inputs !== "object" || Array.isArray(inputs))) throw new Error("MCP MRTR input map invalid");
      const entries = Object.entries(inputs ?? {});
      if (entries.length > 32 || !entries.length && typeof result.requestState !== "string") throw new Error("MCP MRTR input limit or state invalid");
      const responses: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [key, value] of entries) {
        const input = value as { method?: unknown; params?: unknown };
        if (typeof input?.method !== "string") throw new Error("MCP MRTR input request invalid");
        responses[key] = await dispatchPort(input.method, input.params, this.o.ports, { server: this.o.server, signal: options.signal ?? new AbortController().signal, ...(this.o.portTimeoutMs ? { timeoutMs: this.o.portTimeoutMs } : {}) });
      }
      next = { ...params, ...(entries.length ? { inputResponses: responses } : {}), ...(typeof result.requestState === "string" ? { requestState: result.requestState } : {}) };
    }
    throw new Error("MCP MRTR round limit exceeded");
  }
  private once(method: string, params: Record<string, unknown>, options: RequestOptions): Promise<Record<string, unknown>> {
    if (!this.transport || options.signal?.aborted) return Promise.reject(new McpError(ErrorCode.ConnectionClosed, "MCP request closed or aborted"));
    const id = ++this.id;
    const meta = { ...((params._meta ?? {}) as Record<string, unknown>), "io.modelcontextprotocol/protocolVersion": this.version,
      "io.modelcontextprotocol/clientCapabilities": this.capabilities, "io.modelcontextprotocol/clientInfo": MCP_CLIENT_INFO,
      ...(options.onprogress ? { progressToken: id } : {}) };
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const pending = this.pending.get(id); if (!pending) return;
        this.pending.delete(id); pending.detach();
        if (this.transport instanceof ModernHttpTransport) this.transport.cancel(id);
        else void this.notification("notifications/cancelled", { requestId: id, reason: "Client cancelled" }).catch(() => {});
        reject(new McpError(ErrorCode.RequestTimeout, "MCP request cancelled"));
      };
      const timer = options.timeout ? setTimeout(onAbort, options.timeout) : undefined;
      const detach = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", onAbort); };
      this.pending.set(id, { method, ...(method === "subscriptions/listen" ? { requested: params.notifications as Record<string, unknown> } : {}), resolve, reject, detach, ...(options.onprogress ? { progress: options.onprogress } : {}) });
      options.signal?.addEventListener("abort", onAbort, { once: true });
      void this.transport!.send({ jsonrpc: "2.0", id, method, params: { ...params, _meta: meta } }).catch(error => {
        const p = this.pending.get(id); if (!p) return; this.pending.delete(id); p.detach(); p.reject(error);
      });
    });
  }
  private receive(message: JSONRPCMessage): void {
    if ("method" in message) {
      if ("id" in message) { this.o.onError(new Error("Modern server initiated an independent request")); void this.close(); return; }
      const params = (message.params ?? {}) as Record<string, unknown>;
      if (message.method === "notifications/progress") {
        const p = this.pending.get(params.progressToken as number | string);
        if (p && typeof params.progress === "number" && Number.isFinite(params.progress) && params.progress >= (p.lastProgress ?? 0) &&
          (params.total === undefined || typeof params.total === "number" && Number.isFinite(params.total) && params.total >= params.progress)) {
          p.lastProgress = params.progress;
          try { p.progress?.(params as never); } catch { this.o.onError(new Error("MCP progress callback failed")); }
        }
      } else if (message.method === "notifications/cancelled") {
        const p = this.pending.get(params.requestId as number | string);
        if (p?.method === "subscriptions/listen") { this.pending.delete(params.requestId as number | string); p.detach(); p.reject(new McpError(ErrorCode.ConnectionClosed, "MCP server cancelled subscription")); }
      } else {
        const sid = (params._meta as Record<string, unknown> | undefined)?.["io.modelcontextprotocol/subscriptionId"];
        const subscription = typeof sid === "string" || typeof sid === "number" ? this.pending.get(sid) : undefined;
        if (message.method === "notifications/subscriptions/acknowledged") {
          if (!subscription || subscription.method !== "subscriptions/listen" || !params.notifications || typeof params.notifications !== "object") return;
          const filter = params.notifications as Record<string, unknown>;
          for (const [key, value] of Object.entries(filter)) {
            const requested = subscription.requested?.[key];
            if (key === "resourceSubscriptions" ? !Array.isArray(value) || !Array.isArray(requested) || value.some(uri => !requested.includes(uri)) : value !== true || requested !== true) return;
          }
          subscription.acknowledged = filter;
        } else if (["notifications/tools/list_changed", "notifications/prompts/list_changed", "notifications/resources/list_changed", "notifications/resources/updated"].includes(message.method)) {
          const filter = subscription?.acknowledged;
          const key = { "notifications/tools/list_changed": "toolsListChanged", "notifications/prompts/list_changed": "promptsListChanged", "notifications/resources/list_changed": "resourcesListChanged" }[message.method];
          if (!filter || key && filter[key] !== true) return;
          if (message.method === "notifications/resources/updated" && (!Array.isArray(filter.resourceSubscriptions) || typeof params.uri !== "string" ||
            !filter.resourceSubscriptions.some(uri => typeof uri === "string" && (params.uri === uri || String(params.uri).startsWith(uri + "/"))))) return;
        } else return; // Logging and unnegotiated extensions are not host callbacks.
        try { this.o.onNotification(message.method, params); } catch { this.o.onError(new Error("MCP notification callback failed")); }
      }
      return;
    }
    const p = message.id == null ? undefined : this.pending.get(message.id);
    if (!p) return;
    this.pending.delete(message.id!); p.detach();
    if ("error" in message) p.reject(new McpError(message.error.code, "MCP server rejected request", message.error.data));
    else p.resolve(message.result);
  }
  async notification(method: string, params?: Record<string, unknown>): Promise<void> {
    if (this.transport instanceof ModernHttpTransport) throw new Error("Modern HTTP does not send notifications");
    await this.transport?.send({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
  }
  async close(): Promise<void> { this.rejectAll(); await this.transport?.close(); }
  private rejectAll(): void { for (const p of this.pending.values()) { p.detach(); p.reject(new McpError(ErrorCode.ConnectionClosed, "MCP connection closed")); } this.pending.clear(); }
}
