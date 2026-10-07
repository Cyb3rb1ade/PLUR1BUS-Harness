// The MCP server registry (ADR-014 §1, §2): servers per scope, started lazily, stopped when idle, with the tool-schema
// cache kept across the stop. Not wired into a turn loop yet (2c/D106); callers pass the agent and principal in.
import type { Clock } from "./clock.ts";
import { systemClock } from "./clock.ts";
import { validateDefinition } from "./config.ts";
import { McpConnection } from "./connection.ts";
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
}

interface Entry {
  def: McpServerDefinition;
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

  constructor(o: RegistryOptions) {
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
      def, key, redactor: createRedactor(secrets), cache: new SchemaCache(), conn: null, starting: null, startAbort: new AbortController(), inFlight: 0,
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
    if (!o.refresh && e.cache.fresh) return e.cache.get();
    return await this.use(e, o.signal, async (conn) => this.refreshCache(e, conn, o.signal));
  }

  async callTool(name: string, tool: string, args: Record<string, unknown>, caller: McpCaller, signal?: AbortSignal): Promise<McpToolResult> {
    const e = this.resolve(name, caller.agentId);
    return await this.use(e, signal, async (conn) => {
      if (!e.cache.fresh) await this.refreshCache(e, conn, signal);
      if (!e.cache.has(tool)) {
        await this.refreshCache(e, conn, signal); // the cache may predate the server's current tool set
        if (!e.cache.has(tool)) throw new McpClientError("unknown-tool", `${name} has no tool named ${tool}`, { server: name });
      }
      const raw = await conn.callTool(tool, args, signal);
      return wrapToolResult(raw, { server: name, tool, caller, trust: e.def.trust, redactor: e.redactor, maxBytes: this.policy.maxResultBytes });
    });
  }

  /** Stops every server. No server outlives the registry. */
  async shutdown(): Promise<void> {
    this.down = true;
    const all = [...this.entries.values()];
    for (const e of all) { e.startAbort.abort(); this.clearIdle(e); }
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
      return await fn(conn);
    } catch (err) {
      const ce = err instanceof McpClientError ? err : new McpClientError("protocol", e.redactor.redact(String((err as Error)?.message ?? err)), { server: e.def.name, cause: err });
      e.lastError = { code: ce.code, message: ce.message, at: this.clock.now() };
      throw ce;
    } finally {
      e.inFlight--;
      e.lastActivityAt = this.clock.now();
      if (e.conn && e.inFlight === 0) this.armIdle(e);
    }
  }

  private ensure(e: Entry): Promise<McpConnection> {
    if (e.conn && !e.conn.isClosed) return Promise.resolve(e.conn);
    if (e.starting) return e.starting;
    e.conn = null;
    const starting = McpConnection.open({
      def: e.def, clock: this.clock, logger: this.logger, redactor: e.redactor, hostEnv: this.hostEnv,
      onToolsChanged: () => { e.cache.markStale(); },
      onRemoteClose: () => { this.onRemoteClose(e); },
    }, e.startAbort.signal).then((c) => {
      e.starts++;
      e.conn = c;
      return c;
    });
    e.starting = starting;
    starting.then(() => { e.starting = null; }, () => { e.starting = null; });
    return starting;
  }

  private async refreshCache(e: Entry, conn: McpConnection, signal?: AbortSignal): Promise<readonly McpToolDescriptor[]> {
    const tools = await conn.listTools(signal);
    e.cache.set(tools, this.clock.now());
    return e.cache.get();
  }

  private onRemoteClose(e: Entry): void {
    if (e.conn) { e.stderrLines += e.conn.stderrLines; }
    e.conn = null;
    e.lastError = { code: "closed", message: `${e.def.name}: the server closed the connection`, at: this.clock.now() };
    this.clearIdle(e);
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
      name: e.def.name, scope: e.def.scope, transport: e.def.transport.type, trust: e.def.trust, state, starts: e.starts,
      pid: state === "running" ? e.conn!.processId : null, lastActivityAt: e.lastActivityAt, idleStopsAt: e.idleAt, inFlight: e.inFlight, lastError: e.lastError,
      cache: e.cache.summary(), stderrLines: e.stderrLines + (e.conn?.stderrLines ?? 0),
    };
  }
}

export interface McpCallerScope { agentId?: string }

function visibleTo(e: Entry, agentId: string): boolean {
  return e.def.scope.kind === "installation" || e.def.scope.agentId === agentId;
}
