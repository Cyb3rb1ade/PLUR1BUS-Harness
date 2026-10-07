// The MCP server registry (ADR-014 §1, §2): servers per scope, started lazily, stopped when idle, with the tool-schema
// cache kept across the stop. Not wired into a turn loop yet (2c/D106); callers pass the agent and principal in.
import type { Clock } from "./clock.ts";
import { systemClock } from "./clock.ts";
import { validateDefinition } from "./config.ts";
import { McpConnection, type McpConnectionState, type McpResource, type McpPrompt, type McpResourceTemplate } from "./connection.ts";
import type { McpProtocolVersion } from "./protocol.ts";
import type { McpClientPorts } from "./ports.ts";
import { SecretBearerAuthProvider, type McpAuthProvider } from "./auth.ts";
import type { Egress } from "../egress/index.ts";
import type { SecretStore } from "../secrets/index.ts";
import { McpClientError } from "./errors.ts";
import { wrapToolResult } from "./provenance.ts";
import { createRedactor, isSensitiveName, type Redactor } from "./redact.ts";
import { SchemaCache } from "./schema-cache.ts";
import {
  DEFAULT_IDLE_MS, DEFAULT_MAX_RESULT_BYTES, type McpCaller, type McpLogger, type McpPolicy, type McpServerDefinition, type McpServerStatus, type McpToolDescriptor, type McpToolResult,
} from "./types.ts";

export interface RegistryOptions {
  policy?: Partial<McpPolicy>;
  clock?: Clock;
  logger: McpLogger;
  /** The environment `fromHost` variables are copied from. Defaults to the process environment. */
  hostEnv?: NodeJS.ProcessEnv;
  ports?: (server: McpServerDefinition) => McpClientPorts;
  auth?: (server: McpServerDefinition) => McpAuthProvider | undefined;
  secrets?: Pick<SecretStore, "lease" | "revokeLease">;
  egress?: Pick<Egress, "decide">;
  onEvent?: (event: { server: string; state?: McpConnectionState; method?: string; params?: Record<string, unknown> }) => void;
}

interface Entry {
  def: McpServerDefinition;
  protocolVersion: McpProtocolVersion | null;
  connectionState: McpConnectionState | null;
  reconnectTimer: unknown;
  reconnectAttempts: number;
  expiresAt: number | null;
  key: string;
  redactor: Redactor;
  cache: SchemaCache;
  conn: McpConnection | null;
  starting: Promise<McpConnection> | null;
  startAbort: AbortController;
  inFlight: number;
  idleTimer: unknown;
  idleAt: number | null;
  lastActivityAt: number | null;
  starts: number;
  stderrLines: number;
  lastError: { code: string; message: string; at: number } | null;
}

const keyOf = (def: McpServerDefinition): string => (def.scope.kind === "agent" ? `agent:${def.scope.agentId}:${def.name}` : `installation::${def.name}`);

function raceAbort<T>(p: Promise<T>, signal: AbortSignal | undefined, server: string): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new McpClientError("aborted", `${server}: aborted`, { server }));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new McpClientError("aborted", `${server}: aborted`, { server }));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then((v) => { signal.removeEventListener("abort", onAbort); resolve(v); }, (e) => { signal.removeEventListener("abort", onAbort); reject(e); });
  });
}

export class McpRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly clock: Clock;
  private readonly logger: McpLogger;
  private readonly hostEnv: NodeJS.ProcessEnv;
  private readonly policy: McpPolicy;
  private down = false;
  private readonly options: RegistryOptions;

  constructor(o: RegistryOptions) {
    this.options = o;
    this.clock = o.clock ?? systemClock;
    this.logger = o.logger;
    this.hostEnv = o.hostEnv ?? process.env;
    // RULING: the command allowlist defaults to empty, so no stdio server can start until it is configured.
    this.policy = { allowedCommands: o.policy?.allowedCommands ?? [], idleTimeoutMs: o.policy?.idleTimeoutMs ?? DEFAULT_IDLE_MS, maxResultBytes: o.policy?.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES };
  }

  /** Validates and registers a server. Starts nothing (ADR-014 §2). */
  register(raw: unknown): McpServerDefinition {
    if (this.down) throw new McpClientError("closed", "the MCP registry is shut down");
    const def = validateDefinition(raw, this.policy);
    const key = keyOf(def);
    if (this.entries.has(key)) throw new McpClientError("invalid-config", `a server named ${def.name} is already registered in this scope`, { server: def.name });
    // A name must mean one thing to an agent: an agent-scoped server may not reuse an installation name, and vice versa.
    for (const e of this.entries.values()) {
      if (e.def.name !== def.name) continue;
      if ((e.def.scope.kind === "installation") !== (def.scope.kind === "installation")) {
        throw new McpClientError("invalid-config", `the name ${def.name} is already used in another scope`, { server: def.name });
      }
    }
    const secrets: string[] = [];
    if (def.transport.type === "http") secrets.push(...Object.values(def.transport.headers));
    else for (const [k, v] of Object.entries(def.transport.env)) if (isSensitiveName(k)) secrets.push(v);
    this.entries.set(key, {
      def, key, protocolVersion: null, connectionState: null, reconnectTimer: null, reconnectAttempts: 0, expiresAt: null, redactor: createRedactor(secrets), cache: new SchemaCache(), conn: null, starting: null, startAbort: new AbortController(), inFlight: 0,
      idleTimer: null, idleAt: null, lastActivityAt: null, starts: 0, stderrLines: 0, lastError: null,
    });
    this.logger.info("mcp.server.registered", { server: def.name, scope: def.scope.kind, transport: def.transport.type, trust: def.trust });
    return def;
  }

  async unregister(name: string, scope: McpCallerScope): Promise<boolean> {
    const e = this.entries.get(scope.agentId === undefined ? `installation::${name}` : `agent:${scope.agentId}:${name}`);
    if (!e) return false;
    this.entries.delete(e.key);
    e.startAbort.abort();
    this.clearReconnect(e);
    this.clearIdle(e);
    await this.stop(e, "graceful");
    return true;
  }

  /** Servers visible to an agent: every installation server plus that agent's own. Never starts anything. */
  list(agentId: string): McpServerStatus[] {
    return [...this.entries.values()].filter((e) => visibleTo(e, agentId)).map((e) => this.statusOf(e)).sort((a, b) => a.name.localeCompare(b.name));
  }

  status(name: string, agentId: string): McpServerStatus {
    return this.statusOf(this.resolve(name, agentId));
  }

  /** Tool descriptors. Answered from the cache while it is fresh, even with the server stopped (D17). */
  async listTools(name: string, caller: McpCaller, o: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<readonly McpToolDescriptor[]> {
    const e = this.resolve(name, caller.agentId);
    if (!o.refresh && e.cache.fresh && (e.expiresAt === null || this.clock.now() < e.expiresAt)) return e.cache.get();
    return await this.use(e, o.signal, async (conn) => this.refreshCache(e, conn, o.signal));
  }

  async callTool(name: string, tool: string, args: Record<string, unknown>, caller: McpCaller, signal?: AbortSignal): Promise<McpToolResult> {
    const e = this.resolve(name, caller.agentId);
    return await this.use(e, signal, async (conn) => {
      if (!e.cache.fresh || e.expiresAt !== null && this.clock.now() >= e.expiresAt) await this.refreshCache(e, conn, signal);
      if (!e.cache.has(tool)) {
        await this.refreshCache(e, conn, signal); // the cache may predate the server's current tool set
        if (!e.cache.has(tool)) throw new McpClientError("unknown-tool", `${name} has no tool named ${tool}`, { server: name });
      }
      const raw = await conn.callTool(tool, args, signal);
      return wrapToolResult(raw, { server: name, tool, caller, trust: e.def.trust, redactor: e.redactor, maxBytes: this.policy.maxResultBytes });
    });
  }

  async listResources(name: string, caller: McpCaller, signal?: AbortSignal): Promise<McpResource[]> {
    const e = this.resolve(name, caller.agentId); return await this.use(e, signal, async c => this.safeData(e, await c.listResources(signal)));
  }
  async listResourceTemplates(name: string, caller: McpCaller, signal?: AbortSignal): Promise<McpResourceTemplate[]> {
    const e = this.resolve(name, caller.agentId); return await this.use(e, signal, async c => this.safeData(e, await c.listResourceTemplates(signal)));
  }
  async readResource(name: string, uri: string, caller: McpCaller, signal?: AbortSignal) {
    const e = this.resolve(name, caller.agentId); return await this.use(e, signal, async c => this.safeData(e, await c.readResource(uri, signal)));
  }
  async listPrompts(name: string, caller: McpCaller, signal?: AbortSignal): Promise<McpPrompt[]> {
    const e = this.resolve(name, caller.agentId); return await this.use(e, signal, async c => this.safeData(e, await c.listPrompts(signal)));
  }
  async getPrompt(name: string, prompt: string, args: Record<string, string>, caller: McpCaller, signal?: AbortSignal) {
    const e = this.resolve(name, caller.agentId); return await this.use(e, signal, async c => this.safeData(e, await c.getPrompt(prompt, args, signal)));
  }
  async subscribeResource(name: string, uri: string, caller: McpCaller, signal?: AbortSignal): Promise<void> {
    const e = this.resolve(name, caller.agentId); await this.use(e, signal, c => c.subscribeResource(uri, signal));
  }
  async unsubscribeResource(name: string, uri: string, caller: McpCaller, signal?: AbortSignal): Promise<void> {
    const e = this.resolve(name, caller.agentId); await this.use(e, signal, c => c.unsubscribeResource(uri, signal));
  }
  async rootsChanged(name: string, caller: McpCaller): Promise<void> {
    const e = this.resolve(name, caller.agentId); await this.use(e, undefined, c => c.rootsChanged());
  }
  /** Scope visibility applies before connecting. A failed server does not hide healthy servers. */
  async aggregate(caller: McpCaller, signal?: AbortSignal) {
    const servers = [...this.entries.values()].filter(e => visibleTo(e, caller.agentId)).sort((a, b) => a.def.name.localeCompare(b.def.name));
    const tools: Array<McpToolDescriptor & { server: string; localName: string }> = [];
    const resources: Array<McpResource & { server: string }> = [];
    const prompts: Array<McpPrompt & { server: string; localName: string }> = [];
    const errors: Array<{ server: string; feature: string; code: string }> = [];
    await Promise.all(servers.map(async e => {
      const features = await Promise.allSettled([
        this.listTools(e.def.name, caller, { ...(signal ? { signal } : {}) }),
        this.listResources(e.def.name, caller, signal), this.listPrompts(e.def.name, caller, signal),
      ]);
      const [t, r, p] = features;
      if (t?.status === "fulfilled") tools.push(...t.value.map(tool => ({ ...tool, server: e.def.name, localName: tool.name, name: `${e.def.name}::${tool.name}` })));
      if (r?.status === "fulfilled") resources.push(...r.value.map(resource => ({ ...resource, server: e.def.name })));
      if (p?.status === "fulfilled") prompts.push(...p.value.map(prompt => ({ ...prompt, server: e.def.name, localName: prompt.name, name: `${e.def.name}::${prompt.name}` })));
      features.forEach((result, index) => { if (result.status === "rejected") errors.push({ server: e.def.name, feature: ["tools", "resources", "prompts"][index]!, code: result.reason instanceof McpClientError ? result.reason.code : "protocol" }); });
    }));
    tools.sort((a, b) => a.name.localeCompare(b.name)); resources.sort((a, b) => a.server.localeCompare(b.server) || a.uri.localeCompare(b.uri)); prompts.sort((a, b) => a.name.localeCompare(b.name));
    return { tools, resources, prompts, errors };
  }
  private safeData<T>(e: Entry, value: T): T {
    const raw = JSON.stringify(value);
    if (Buffer.byteLength(raw) > this.policy.maxResultBytes) throw new McpClientError("protocol", "MCP result exceeds byte limit", { server: e.def.name });
    // Walk strings, rather than replacing JSON bytes: tokens containing quotes cannot corrupt serialization.
    const walk = (v: unknown): unknown => typeof v === "string" ? e.redactor.redact(v) : Array.isArray(v) ? v.map(walk) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [e.redactor.redact(k), walk(x)])) : v;
    return walk(value) as T;
  }

  /** Stops every server. No server outlives the registry. */
  async shutdown(): Promise<void> {
    this.down = true;
    const all = [...this.entries.values()];
    for (const e of all) { e.startAbort.abort(); this.clearReconnect(e); this.clearIdle(e); }
    await Promise.all(all.map((e) => this.stop(e, "graceful")));
  }

  // ---- internals ----

  private resolve(name: string, agentId: string): Entry {
    const e = this.entries.get(`agent:${agentId}:${name}`) ?? this.entries.get(`installation::${name}`);
    // Not `forbidden`: another agent's server must not be distinguishable from one that does not exist.
    if (!e) throw new McpClientError("not-registered", `no MCP server named ${name}`, { server: name });
    return e;
  }

  /** Runs `fn` with a live connection, holding off the idle timer for the duration. */
  private async use<T>(e: Entry, signal: AbortSignal | undefined, fn: (c: McpConnection) => Promise<T>): Promise<T> {
    if (this.down) throw new McpClientError("closed", "the MCP registry is shut down", { server: e.def.name });
    if (signal?.aborted) throw new McpClientError("aborted", `${e.def.name}: aborted before it started`, { server: e.def.name });
    e.inFlight++;
    this.clearIdle(e);
    try {
      const conn = await raceAbort(this.ensure(e), signal, e.def.name);
      const result = await fn(conn); e.reconnectAttempts = 0; return result;
    } catch (err) {
      const ce = err instanceof McpClientError ? err : new McpClientError("protocol", e.redactor.redact(String((err as Error)?.message ?? err)), { server: e.def.name });
      e.lastError = { code: ce.code, message: ce.message, at: this.clock.now() };
      throw ce;
    } finally {
      e.inFlight--;
      e.lastActivityAt = this.clock.now();
      if (e.conn && e.inFlight === 0) this.armIdle(e);
    }
  }

  private ensure(e: Entry): Promise<McpConnection> {
    this.clearReconnect(e);
    if (e.conn && !e.conn.isClosed) return Promise.resolve(e.conn);
    if (e.starting) return e.starting;
    e.conn = null;
    const starting = McpConnection.open({
      def: e.def, clock: this.clock, logger: this.logger, redactor: e.redactor, hostEnv: this.hostEnv,
      ...(e.protocolVersion ? { knownVersion: e.protocolVersion } : {}),
      ...(this.options.ports ? { ports: this.options.ports(e.def) } : {}),
      ...(this.options.egress ? { egress: this.options.egress } : {}),
      ...this.authFor(e),
      onState: state => { e.connectionState = state; this.emit({ server: e.def.name, state }); },
      onNotification: (method, params) => this.emit({ server: e.def.name, method, params: this.safeData(e, params) }),
      onToolsChanged: () => { e.cache.markStale(); },
      onRemoteClose: () => { this.onRemoteClose(e); },
    }, e.startAbort.signal).then((c) => {
      e.starts++;
      e.conn = c; e.protocolVersion = c.protocolVersion;
      return c;
    });
    e.starting = starting;
    starting.then(() => { e.starting = null; }, () => { e.starting = null; });
    return starting;
  }

  private async refreshCache(e: Entry, conn: McpConnection, signal?: AbortSignal): Promise<readonly McpToolDescriptor[]> {
    const tools = await conn.listTools(signal);
    e.cache.set(this.safeData(e, tools), this.clock.now());
    e.expiresAt = conn.toolCacheTtlMs === undefined ? null : this.clock.now() + conn.toolCacheTtlMs;
    return e.cache.get();
  }

  private onRemoteClose(e: Entry): void {
    if (e.conn) { e.stderrLines += e.conn.stderrLines; }
    e.conn = null; e.cache.markStale(); e.connectionState = "degraded";
    e.lastError = { code: "closed", message: `${e.def.name}: the server closed the connection`, at: this.clock.now() };
    this.clearIdle(e); this.scheduleReconnect(e);
  }

  private emit(event: Parameters<NonNullable<RegistryOptions["onEvent"]>>[0]): void {
    try { this.options.onEvent?.(event); } catch { this.logger.warn("mcp.observer.failed", { server: event.server }); }
  }

  private authFor(e: Entry): { auth?: McpAuthProvider } {
    const provider = this.options.auth?.(e.def) ?? (e.def.authSecret && this.options.secrets ? new SecretBearerAuthProvider(this.options.secrets, e.def.authSecret) : undefined);
    if (e.def.authSecret && !provider) throw new McpClientError("not-allowed", "MCP authSecret requires a secrets port", { server: e.def.name });
    return provider ? { auth: provider } : {};
  }
  private clearReconnect(e: Entry): void {
    if (e.reconnectTimer !== null) this.clock.clearTimeout(e.reconnectTimer); e.reconnectTimer = null;
  }
  private scheduleReconnect(e: Entry): void {
    const policy = e.def.reconnect ?? (e.def.transport.type === "http" ? { maxAttempts: 5, initialDelayMs: 100, maxDelayMs: 5000 } : { maxAttempts: 0, initialDelayMs: 100, maxDelayMs: 5000 });
    if (this.down || e.startAbort.signal.aborted || !policy.maxAttempts) return;
    if (e.reconnectAttempts >= policy.maxAttempts) { e.connectionState = "failed"; this.emit({ server: e.def.name, state: "failed" }); return; }
    const delay = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** e.reconnectAttempts++);
    e.reconnectTimer = this.clock.setTimeout(() => {
      e.reconnectTimer = null;
      void this.ensure(e).then(() => { if (!e.inFlight) this.armIdle(e); }, () => this.scheduleReconnect(e));
    }, delay);
  }

  private armIdle(e: Entry): void {
    this.clearIdle(e);
    e.idleAt = this.clock.now() + this.policy.idleTimeoutMs;
    e.idleTimer = this.clock.setTimeout(() => { void this.onIdle(e); }, this.policy.idleTimeoutMs);
  }

  private clearIdle(e: Entry): void {
    if (e.idleTimer !== null) { this.clock.clearTimeout(e.idleTimer); e.idleTimer = null; }
    e.idleAt = null;
  }

  private async onIdle(e: Entry): Promise<void> {
    e.idleTimer = null; e.idleAt = null;
    if (e.inFlight > 0 || !e.conn) return;
    this.logger.info("mcp.server.idle-stop", { server: e.def.name, idleMs: this.policy.idleTimeoutMs });
    await this.stop(e, "graceful"); // the schema cache stays: listTools is still answered without a process
  }

  private async stop(e: Entry, mode: "graceful" | "hard"): Promise<void> {
    const starting = e.starting;
    const conn = e.conn;
    e.conn = null;
    if (conn) { e.stderrLines += conn.stderrLines; await conn.close(mode); }
    else if (starting) { try { await (await starting).close(mode); } catch { /* the start failed or was aborted: already cleaned up */ } }
  }

  private statusOf(e: Entry): McpServerStatus {
    const state = e.conn && !e.conn.isClosed ? "running" : e.starting ? "starting" : "stopped";
    return {
      protocolVersion: e.protocolVersion, connectionState: e.connectionState, name: e.def.name, scope: e.def.scope, transport: e.def.transport.type, trust: e.def.trust, state, starts: e.starts,
      pid: state === "running" ? e.conn!.processId : null, lastActivityAt: e.lastActivityAt, idleStopsAt: e.idleAt, inFlight: e.inFlight, lastError: e.lastError,
      cache: e.cache.summary(), stderrLines: e.stderrLines + (e.conn?.stderrLines ?? 0),
    };
  }
}

export interface McpCallerScope { agentId?: string }

function visibleTo(e: Entry, agentId: string): boolean {
  return e.def.scope.kind === "installation" || e.def.scope.agentId === agentId;
}
