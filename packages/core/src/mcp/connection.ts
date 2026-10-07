// Shared connection lifetime and features; the protocol adapters retain each era's exact wire semantics.
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { McpError, ErrorCode, CallToolResultSchema, ContentBlockSchema, ReadResourceResultSchema, GetPromptResultSchema, ListResourcesResultSchema, ListResourceTemplatesResultSchema, ListPromptsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/types.js";
import type { Egress } from "../egress/index.ts";
import type { Clock } from "./clock.ts";
import { buildChildEnv } from "./env.ts";
import { McpClientError } from "./errors.ts";
import type { Redactor } from "./redact.ts";
import { MAX_LIST_PAGES, type McpLogger, type McpServerDefinition, type McpToolDescriptor } from "./types.ts";
import { BoundedStdioTransport, MAX_FRAME_BYTES } from "./stdio.ts";
import { ModernHttpTransport } from "./modern-http.ts";
import { LegacyProtocol, ModernProtocol, type McpProtocol, type McpProtocolVersion, type ProtocolOptions } from "./protocol.ts";
import { createMcpFetch } from "./http.ts";
import { createAuthorizedFetch, type McpAuthProvider } from "./auth.ts";
import type { McpClientPorts } from "./ports.ts";
import { toolHeaderExtractor } from "./tool-headers.ts";

const SDK_TIMER_SLACK_MS = 5000;
const MAX_NAME = 128;
const MAX_DESCRIPTION = 8192;
const STDERR_LINE_MAX = 2000;
const STDERR_PARTIAL_MAX = 64 * 1024;
const STDERR_BURST = 20;
const STDERR_WINDOW_MS = 10_000;

export type McpConnectionState = "connecting" | "ready" | "degraded" | "failed";
export interface ConnectionDeps {
  def: McpServerDefinition; clock: Clock; logger: McpLogger; redactor: Redactor; hostEnv: NodeJS.ProcessEnv;
  onToolsChanged: () => void; onRemoteClose: () => void;
  onNotification?: (method: string, params: Record<string, unknown>) => void;
  onState?: (state: McpConnectionState) => void;
  ports?: McpClientPorts; egress?: Pick<Egress, "decide">; auth?: McpAuthProvider;
  /** Known era from the registry; absent means probe modern first. */
  knownVersion?: McpProtocolVersion;
  /** In-process pipe seam. A factory returns a fresh transport when fallback needs one. */
  transportFactory?: (modern: boolean) => Transport;
}
export interface RawToolResult { content?: unknown; structuredContent?: unknown; isError?: unknown }
export interface McpRequestOptions { signal?: AbortSignal; onProgress?: RequestOptions["onprogress"] }
export interface McpResource { uri: string; name: string; [key: string]: unknown }
export interface McpResourceTemplate { uriTemplate: string; name: string; [key: string]: unknown }
export interface McpPrompt { name: string; [key: string]: unknown }

class Deadline {
  readonly signal: AbortSignal;
  private fired = false;
  private readonly ac = new AbortController();
  private readonly handle: unknown;
  private readonly detach: () => void;
  private readonly clock: Clock;
  constructor(clock: Clock, ms: number, caller?: AbortSignal) {
    this.clock = clock;
    this.signal = this.ac.signal;
    this.handle = clock.setTimeout(() => { this.fired = true; this.ac.abort(new Error("deadline")); }, ms);
    const onAbort = () => this.ac.abort(caller?.reason);
    if (caller) {
      if (caller.aborted) this.ac.abort(caller.reason);
      else caller.addEventListener("abort", onAbort, { once: true });
    }
    this.detach = () => caller?.removeEventListener("abort", onAbort);
  }
  get timedOut(): boolean { return this.fired; }
  done(): void { this.clock.clearTimeout(this.handle); this.detach(); }
}


export class McpConnection {
  private client!: McpProtocol;
  private transport!: Transport;
  private closing: Promise<void> | null = null;
  private exited = false;
  private stopping = false;
  private stderrBuf = "";
  private stderrWindowStart = 0;
  private stderrInWindow = 0;
  stderrLines = 0;
  private pidValue: number | null = null;
  private readonly d: ConnectionDeps;
  private stateValue: McpConnectionState = "connecting";
  private readonly outputValidators = new Map<string, JsonSchemaValidator<unknown>>();
  private readonly tools = new Map<string, McpToolDescriptor>();
  toolCacheTtlMs: number | undefined;
  private subscription: AbortController | undefined;
  private subscriptionAck: { resolve(): void; reject(error: Error): void } | undefined;
  private subscriptionRetry: unknown = null;
  private subscriptionAttempts = 0;
  private readonly subscribedResources = new Set<string>();
  private constructor(d: ConnectionDeps) { this.d = d; this.state("connecting"); }
  private state(state: McpConnectionState): void { this.stateValue = state; this.d.onState?.(state); }
  get stateName(): McpConnectionState { return this.stateValue; }
  get protocolVersion(): McpProtocolVersion { return this.client.version; }
  get clientCapabilities() { return this.client.capabilities; }
  get serverCapabilities() { return this.client.serverCapabilities; }
  get serverInfo() { return this.client.serverInfo; }
  get processId(): number | null { return this.pidValue; }
  get isClosed(): boolean { return this.stopping || this.closing !== null || this.exited; }

  private prepare(modern: boolean): void {
    const d = this.d; const t = d.def.transport;
    const options: ProtocolOptions = { server: d.def.name, ports: d.ports ?? {}, portTimeoutMs: d.def.timeouts.callMs,
      onNotification: (method, params) => {
        if (method === "notifications/subscriptions/acknowledged") { this.subscriptionAck?.resolve(); this.subscriptionAttempts = 0; }
        if (method === "notifications/tools/list_changed") { this.tools.clear(); this.outputValidators.clear(); d.onToolsChanged(); } d.onNotification?.(method, params); },
      onClose: () => { this.exited = true; this.flushStderr(); if (!this.stopping) { this.state("degraded"); d.onRemoteClose(); } },
      onError: error => { this.state("degraded"); d.logger.debug("mcp.client.error", { server: d.def.name, message: d.redactor.redact(error.message) }); },
    };
    this.client = modern ? new ModernProtocol(options) : new LegacyProtocol(options);
    if (d.transportFactory) this.transport = d.transportFactory(modern);
    else if (t.type === "stdio") {
      const env = buildChildEnv(t, d.hostEnv); for (const secret of env.secrets) d.redactor.add(secret, true);
      if (env.missing.length) d.logger.warn("mcp.server.env-missing", { server: d.def.name, names: env.missing });
      const stdio = new BoundedStdioTransport(t, MAX_FRAME_BYTES, d.def.timeouts.closeGraceMs, d.hostEnv);
      this.transport = stdio; this.attachStderr(stdio);
      d.logger.debug("mcp.server.spawn", { server: d.def.name, command: t.command, argCount: t.args.length, envNames: env.names });
    } else {
      for (const [key, value] of Object.entries(t.headers)) {
        d.redactor.add(value, true);
        if (key.toLowerCase() === "authorization" && /^Bearer /i.test(value)) d.redactor.add(value.slice(7), true);
      }
      const fetch = createAuthorizedFetch(createMcpFetch(d.egress ? { egress: d.egress } : {}), t.url, d.auth, d.redactor);
      this.transport = modern ? new ModernHttpTransport(new URL(t.url), fetch, t.headers) as Transport :
        new StreamableHTTPClientTransport(new URL(t.url), { fetch, requestInit: { headers: t.headers }, reconnectionOptions: { initialReconnectionDelay: 100, maxReconnectionDelay: 5000, reconnectionDelayGrowFactor: 2, maxRetries: 5 } }) as Transport;
    }
  }
  static async open(d: ConnectionDeps, signal?: AbortSignal): Promise<McpConnection> {
    const conn = new McpConnection(d); const ms = d.def.timeouts.connectMs;
    const deadline = new Deadline(d.clock, ms, signal);
    try {
      const modern = !d.knownVersion || d.knownVersion === "2026-07-28";
      conn.prepare(modern);
      try { await conn.client.connect(conn.transport, { signal: deadline.signal, timeout: modern && d.def.transport.type === "stdio" ? Math.min(1000, ms) : ms + SDK_TIMER_SLACK_MS }); }
      catch (error) {
        const legacyVersions = error instanceof McpError && error.code === -32022 && Array.isArray((error.data as { supported?: unknown })?.supported) &&
          ((error.data as { supported: unknown[] }).supported).some(v => ["2025-11-25", "2025-06-18", "2025-03-26"].includes(String(v)));
        const modernError = !legacyVersions && error instanceof McpError && [-32020, -32021, -32022].includes(error.code);
        if (!modern || modernError || deadline.signal.aborted || !(error instanceof McpError) || ![-32601, -32600, -32602, -32000, -32022, ErrorCode.RequestTimeout].includes(error.code)) throw error;
        // A legacy endpoint rejected the era probe. Reuse pipes for an in-process server; a real stdio process
        // is restarted to avoid leaving a silent probe or unrelated state in the child's protocol.
        const old = conn.transport;
        old.onclose = () => {};
        delete old.onmessage; delete old.onerror;
        if (d.transportFactory) { conn.prepare(false); if (conn.transport !== old) await old.close(); else old.start = async () => {}; }
        else { await conn.client.close(); conn.prepare(false); }
        conn.exited = false;
        await conn.client.connect(conn.transport, { signal: deadline.signal, timeout: ms + SDK_TIMER_SLACK_MS });
      }
      conn.pidValue = conn.transport instanceof BoundedStdioTransport ? conn.transport.pid : null;
      if (conn.protocolVersion === "2026-07-28" && (conn.serverCapabilities.tools?.listChanged || conn.serverCapabilities.resources?.listChanged || conn.serverCapabilities.prompts?.listChanged)) await conn.listen(deadline.signal);
      conn.state("ready");
      d.logger.info("mcp.server.started", { server: d.def.name, scope: d.def.scope.kind, transport: d.def.transport.type, pid: conn.pidValue, protocolVersion: conn.protocolVersion });
      return conn;
    } catch (error) {
      conn.state("failed"); await conn.close("hard");
      if (deadline.timedOut) throw new McpClientError("connect-timeout", `${d.def.name}: no protocol answer within ${ms} ms`, { server: d.def.name });
      if (signal?.aborted) throw new McpClientError("aborted", `${d.def.name}: connect aborted`, { server: d.def.name });
      throw new McpClientError("connect-failed", d.redactor.redact(`${d.def.name}: ${(error as Error).message}`), { server: d.def.name });
    } finally { deadline.done(); }
  }
  private async rpc(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal, progress?: RequestOptions["onprogress"]): Promise<Record<string, unknown>> {
    return await this.request(method.endsWith("/list") ? this.d.def.timeouts.listMs : this.d.def.timeouts.callMs, signal, method,
      opts => this.client.request(method, params, { ...opts, ...(progress ? { onprogress: progress } : {}) }));
  }
  async ping(signal?: AbortSignal): Promise<void> {
    await this.rpc(this.protocolVersion === "2026-07-28" ? "server/discover" : "ping", {}, signal);
  }
  private async pages<T>(method: string, field: string, signal?: AbortSignal): Promise<T[]> {
    const out: T[] = []; const seen = new Set<string>();
    await this.request(this.d.def.timeouts.listMs, signal, method, async opts => {
      let cursor: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const result = await this.client.request(method, cursor ? { cursor } : {}, opts);
        if (!Array.isArray(result[field])) throw new Error("MCP list response invalid");
        if (field === "resources") ListResourcesResultSchema.parse(result);
        else if (field === "resourceTemplates") ListResourceTemplatesResultSchema.parse(result);
        else if (field === "prompts") ListPromptsResultSchema.parse(result);
        if (this.protocolVersion === "2026-07-28") {
          if (typeof result.ttlMs !== "number" || !Number.isFinite(result.ttlMs) || result.ttlMs < 0 || !["private", "public"].includes(String(result.cacheScope))) throw new Error("MCP cache metadata invalid");
          if (method === "tools/list") this.toolCacheTtlMs = Math.min(this.toolCacheTtlMs ?? Infinity, result.ttlMs);
        }
        if (out.length + result[field].length > 10000) throw new Error("MCP list item limit exceeded");
        out.push(...result[field] as T[]);
        if (result.nextCursor === undefined) return;
        if (typeof result.nextCursor !== "string" || !result.nextCursor || seen.has(result.nextCursor)) throw new Error("MCP pagination cursor invalid or repeated");
        cursor = result.nextCursor; seen.add(cursor);
      }
      this.d.logger.warn("mcp.server.list-truncated", { server: this.d.def.name, pages: MAX_LIST_PAGES });
    });
    return out;
  }
  async listTools(signal?: AbortSignal): Promise<McpToolDescriptor[]> {
    this.toolCacheTtlMs = undefined;
    const raw = await this.pages<Record<string, unknown>>("tools/list", "tools", signal);
    const out: McpToolDescriptor[] = []; const validators = new AjvJsonSchemaValidator();
    this.tools.clear(); this.outputValidators.clear();
    for (const item of raw) {
      if (typeof item.name !== "string" || !item.name || item.name.length > MAX_NAME || this.tools.has(item.name) || !item.inputSchema || typeof item.inputSchema !== "object") throw new McpClientError("protocol", "MCP tool descriptor invalid", { server: this.d.def.name });
      const tool = toDescriptor(item);
      if (this.transport instanceof ModernHttpTransport) {
        try { this.transport.setToolHeaders(tool.name, toolHeaderExtractor(tool.inputSchema)); }
        catch { this.d.logger.warn("mcp.tool.excluded", { server: this.d.def.name, reason: "invalid-header-schema" }); continue; }
      }
      if (tool.outputSchema) {
        // The schema walk also bounds composition depth and count, so compiling untrusted output schemas is finite.
        try { toolHeaderExtractor(tool.outputSchema); this.outputValidators.set(tool.name, validators.getValidator(tool.outputSchema)); }
        catch { throw new McpClientError("protocol", "MCP output schema unsupported or invalid", { server: this.d.def.name }); }
      }
      this.tools.set(tool.name, tool); out.push(tool);
    }
    return out;
  }
  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal, options: Omit<McpRequestOptions, "signal"> = {}): Promise<RawToolResult> {
    if (!this.tools.has(name)) await this.listTools(signal);
    const raw = await this.rpc("tools/call", { name, arguments: args }, signal, options.onProgress);
    if (this.protocolVersion !== "2026-07-28") CallToolResultSchema.parse(raw);
    else {
      if (!Array.isArray(raw.content) || raw.isError !== undefined && typeof raw.isError !== "boolean" || raw.content.some(block => !ContentBlockSchema.safeParse(block).success)) throw new McpClientError("protocol", "MCP tool result invalid", { server: this.d.def.name });
    }
    const validator = this.outputValidators.get(name);
    if (validator && raw.isError !== true && !validator(raw.structuredContent).valid) throw new McpClientError("protocol", "MCP tool structuredContent violates outputSchema", { server: this.d.def.name });
    return raw;
  }
  async listResources(signal?: AbortSignal): Promise<McpResource[]> { return await this.pages("resources/list", "resources", signal); }
  async listResourceTemplates(signal?: AbortSignal): Promise<McpResourceTemplate[]> { return await this.pages("resources/templates/list", "resourceTemplates", signal); }
  async readResource(uri: string, signal?: AbortSignal): Promise<{ contents: Array<Record<string, unknown>> }> {
    const result = await this.rpc("resources/read", { uri }, signal); return ReadResourceResultSchema.parse(result);
  }
  async listPrompts(signal?: AbortSignal): Promise<McpPrompt[]> { return await this.pages("prompts/list", "prompts", signal); }
  async getPrompt(name: string, args: Record<string, string> = {}, signal?: AbortSignal): Promise<{ messages: Array<{ role: string; content: Record<string, unknown> }> }> {
    return GetPromptResultSchema.parse(await this.rpc("prompts/get", { name, arguments: args }, signal));
  }
  async rootsChanged(): Promise<void> {
    if (!this.d.ports?.roots) throw new McpClientError("not-allowed", "MCP roots port unavailable");
    if (this.protocolVersion !== "2026-07-28") await this.client.notification("notifications/roots/list_changed");
    // Modern roots are fetched inline on the next MRTR input request; the old notification is removed.
  }
  async subscribeResource(uri: string, signal?: AbortSignal): Promise<void> {
    if (!this.serverCapabilities.resources?.subscribe) throw new McpClientError("not-allowed", "MCP resource subscription unavailable");
    if (this.protocolVersion === "2026-07-28") { this.subscribedResources.add(uri); await this.listen(signal); }
    else await this.rpc("resources/subscribe", { uri }, signal);
  }
  async unsubscribeResource(uri: string, signal?: AbortSignal): Promise<void> {
    if (this.protocolVersion === "2026-07-28") { this.subscribedResources.delete(uri); await this.listen(signal); }
    else await this.rpc("resources/unsubscribe", { uri }, signal);
  }
  /** Modern subscriptions are a long-lived request. Their termination never retries a tool mutation. */
  async listen(signal?: AbortSignal): Promise<void> {
    if (this.protocolVersion !== "2026-07-28") return;
    this.subscription?.abort();
    const subscription = new AbortController(); this.subscription = subscription;
    const onAbort = () => subscription.abort(); signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) subscription.abort();
    let timer: unknown;
    const ack = new Promise<void>((resolve, reject) => {
      this.subscriptionAck = { resolve, reject };
      timer = this.d.clock.setTimeout(() => { subscription.abort(); reject(new Error("MCP subscription acknowledgement timeout")); }, this.d.def.timeouts.listMs);
    });
    const request = this.client.request("subscriptions/listen", { notifications: {
      ...(this.serverCapabilities.tools?.listChanged ? { toolsListChanged: true } : {}),
      ...(this.serverCapabilities.resources?.listChanged ? { resourcesListChanged: true } : {}),
      ...(this.serverCapabilities.prompts?.listChanged ? { promptsListChanged: true } : {}),
      ...(this.subscribedResources.size ? { resourceSubscriptions: [...this.subscribedResources] } : {}),
    } }, { signal: subscription.signal });
    void request.catch(() => { if (this.subscription === subscription) this.subscriptionAck?.reject(new Error("MCP subscription failed")); })
      .finally(() => {
        signal?.removeEventListener("abort", onAbort);
        if (!subscription.signal.aborted && !this.isClosed && this.subscription === subscription) {
          this.state("degraded");
          if (this.subscriptionAttempts++ < 5) this.subscriptionRetry = this.d.clock.setTimeout(() => { void this.listen().catch(() => {}); }, Math.min(5000, 100 * 2 ** this.subscriptionAttempts));
          else this.state("failed");
        }
      });
    try { await ack; } finally { this.d.clock.clearTimeout(timer); if (this.subscription === subscription) this.subscriptionAck = undefined; }
  }
  private async request<T>(ms: number, signal: AbortSignal | undefined, what: string, fn: (options: { signal: AbortSignal; timeout: number }) => Promise<T>): Promise<T> {
    const name = this.d.def.name;
    if (this.isClosed) throw new McpClientError("closed", `${name}: connection is closed`, { server: name });
    const deadline = new Deadline(this.d.clock, ms, signal);
    try {
      // Race also bounds a port that ignores AbortSignal. No unhandled rejection escapes after the race.
      const operation = fn({ signal: deadline.signal, timeout: ms + SDK_TIMER_SLACK_MS });
      const aborted = new Promise<never>((_resolve, reject) => {
        const abort = () => reject(new Error("MCP request aborted"));
        if (deadline.signal.aborted) abort(); else deadline.signal.addEventListener("abort", abort, { once: true });
      });
      const result = await Promise.race([operation, aborted]); this.state("ready"); return result;
    } catch (error) {
      if (error instanceof StreamableHTTPError && error.code === 404) {
        this.state("degraded"); await this.close("hard"); this.d.onRemoteClose();
        throw new McpClientError("closed", `${name}: MCP session expired; next use initializes a new session`, { server: name });
      }
      if (deadline.timedOut) { this.state("degraded"); await this.close("hard"); this.d.onRemoteClose(); throw new McpClientError("call-timeout", `${name}: ${what} did not answer within ${ms} ms`, { server: name }); }
      if (signal?.aborted) { this.state("degraded"); await this.close("hard"); this.d.onRemoteClose(); throw new McpClientError("aborted", `${name}: ${what} aborted`, { server: name }); }
      const code = error instanceof McpError && error.code === ErrorCode.ConnectionClosed ? "closed" : error instanceof McpError ? "server-error" : "protocol";
      throw new McpClientError(code, this.d.redactor.redact(`${name}: ${what}: ${(error as Error).message}`), { server: name });
    } finally { deadline.done(); }
  }
  close(mode: "graceful" | "hard"): Promise<void> {
    if (this.closing) return this.closing; this.stopping = true; this.closing = this.doClose(mode); return this.closing;
  }
  private async doClose(mode: "graceful" | "hard"): Promise<void> {
    this.subscription?.abort(); this.subscriptionAck?.reject(new Error("MCP subscription closed"));
    if (this.subscriptionRetry !== null) this.d.clock.clearTimeout(this.subscriptionRetry);
    if (this.transport instanceof StreamableHTTPClientTransport && mode === "graceful") {
      let timeout: NodeJS.Timeout | undefined;
      try { await Promise.race([this.transport.terminateSession(), new Promise<void>(r => { timeout = setTimeout(r, this.d.def.timeouts.closeGraceMs); })]); } catch { /* session gone */ } finally { clearTimeout(timeout); }
    }
    try { await this.client.close(); } catch { /* transport already closed */ }
    this.exited = true; this.flushStderr(); this.d.logger.info("mcp.server.stopped", { server: this.d.def.name, mode });
  }
  private attachStderr(t: BoundedStdioTransport): void {
    const s = t.stderr;
    if (!s) return;
    s.on("data", (chunk: Buffer | string) => {
      this.stderrBuf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let i: number;
      while ((i = this.stderrBuf.indexOf("\n")) >= 0) { this.emitLine(this.stderrBuf.slice(0, i)); this.stderrBuf = this.stderrBuf.slice(i + 1); }
      if (this.stderrBuf.length > STDERR_PARTIAL_MAX) { this.emitLine(this.stderrBuf); this.stderrBuf = ""; }
    });
  }

  private flushStderr(): void {
    if (this.stderrBuf.length) { this.emitLine(this.stderrBuf); this.stderrBuf = ""; }
  }

  /** ADR-014 §7: split into lines first, then redact, then cap, then rate-limit; nothing is logged raw. */
  private emitLine(raw: string): void {
    this.stderrLines++;
    const now = this.d.clock.now();
    if (now - this.stderrWindowStart >= STDERR_WINDOW_MS) { this.stderrWindowStart = now; this.stderrInWindow = 0; }
    if (++this.stderrInWindow > STDERR_BURST) return; // counted, not logged
    const line = this.d.redactor.redact(raw.replace(/\r$/, ""));
    this.d.logger.debug("mcp.server.stderr", { server: this.d.def.name, line: line.length > STDERR_LINE_MAX ? `${line.slice(0, STDERR_LINE_MAX)}…` : line });
  }
}

function toDescriptor(t: Record<string, unknown>): McpToolDescriptor {
  const meta = (t._meta ?? {}) as Record<string, unknown>;
  const ui = (meta.ui as { resourceUri?: unknown } | undefined)?.resourceUri ?? meta["ui/resourceUri"];
  const cap = (s: unknown, n: number) => (typeof s === "string" ? (s.length > n ? s.slice(0, n) : s) : undefined);
  const description = cap(t.description, MAX_DESCRIPTION);
  const title = cap(t.title, MAX_NAME);
  return {
    name: String(t.name).slice(0, MAX_NAME),
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
    inputSchema: (t.inputSchema ?? { type: "object" }) as Record<string, unknown>,
    ...(t.outputSchema ? { outputSchema: t.outputSchema as Record<string, unknown> } : {}),
    ...(t.annotations ? { annotations: t.annotations as Record<string, unknown> } : {}),
    ...(typeof ui === "string" && ui.startsWith("ui://") ? { uiResourceUri: ui } : {}),
  };
}
