// One connection to one MCP server (ADR-014 §2, §5, §6, §7). The SDK does the wire; this class owns what the SDK
// leaves to the host: deadlines on an injectable clock, stderr capture with redaction, and reaping the child on
// every path (graceful, timeout, abort, crash) so no server outlives its connection.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError, ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Clock } from "./clock.ts";
import { buildChildEnv } from "./env.ts";
import { McpClientError } from "./errors.ts";
import type { Redactor } from "./redact.ts";
import { MAX_LIST_PAGES, type McpLogger, type McpServerDefinition, type McpToolDescriptor } from "./types.ts";

// RULING: the client declares NO optional capability: no sampling, roots or elicitation, and logging is never used
// (ADR-014 §5). Passing an explicit empty object makes that visible and testable in the handshake.
const CLIENT_INFO = { name: "plur1bus-harness", version: "0.1.0" };
const CLIENT_CAPABILITIES = {};

/** The SDK has its own request timer on real time; ours (on the injected clock) always fires first. */
const SDK_TIMER_SLACK_MS = 5_000;
const MAX_NAME = 128;
const MAX_DESCRIPTION = 8192;
const STDERR_LINE_MAX = 2000;
const STDERR_PARTIAL_MAX = 64 * 1024;
const STDERR_BURST = 20;
const STDERR_WINDOW_MS = 10_000;

export interface ConnectionDeps {
  def: McpServerDefinition;
  clock: Clock;
  logger: McpLogger;
  redactor: Redactor;
  hostEnv: NodeJS.ProcessEnv;
  /** `notifications/tools/list_changed` arrived: the cached schema is stale. */
  onToolsChanged: () => void;
  /** The connection ended without us asking (the process exited, the transport closed). */
  onRemoteClose: () => void;
}

export interface RawToolResult { content?: unknown; structuredContent?: unknown; isError?: unknown }

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

const sleepReal = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms).unref(); });

function signalPid(pid: number, sig: NodeJS.Signals): void {
  try { process.kill(pid, sig); } catch { /* already gone */ }
}

export class McpConnection {
  private readonly client: Client;
  private readonly transport: StdioClientTransport | StreamableHTTPClientTransport;
  private closing: Promise<void> | null = null;
  private exited = false;
  private exitWaiters: Array<() => void> = [];
  private stderrBuf = "";
  private stderrWindowStart = 0;
  private stderrInWindow = 0;
  stderrLines = 0;
  private pidValue: number | null = null;

  private readonly d: ConnectionDeps;

  private constructor(d: ConnectionDeps) {
    this.d = d;
    const t = d.def.transport;
    this.client = new Client(CLIENT_INFO, { capabilities: CLIENT_CAPABILITIES });
    if (t.type === "stdio") {
      const ce = buildChildEnv(t, d.hostEnv);
      for (const s of ce.secrets) d.redactor.add(s);
      if (ce.missing.length) d.logger.warn("mcp.server.env-missing", { server: d.def.name, names: ce.missing });
      this.transport = new StdioClientTransport({ command: t.command, args: t.args, env: ce.env, ...(t.cwd ? { cwd: t.cwd } : {}), stderr: "pipe" });
      this.d.logger.debug("mcp.server.spawn", { server: d.def.name, command: t.command, argCount: t.args.length, envNames: ce.names });
      this.attachStderr(this.transport);
    } else {
      for (const v of Object.values(t.headers)) d.redactor.add(v);
      this.transport = new StreamableHTTPClientTransport(new URL(t.url), { requestInit: { headers: t.headers } });
    }
    this.client.onclose = () => {
      this.exited = true;
      this.flushStderr();
      for (const w of this.exitWaiters.splice(0)) w();
      if (!this.closing) { this.d.logger.warn("mcp.server.closed", { server: d.def.name }); this.d.onRemoteClose(); }
    };
    this.client.onerror = (e) => this.d.logger.debug("mcp.client.error", { server: d.def.name, message: this.d.redactor.redact(e.message) });
    this.client.setNotificationHandler(ToolListChangedNotificationSchema, () => { this.d.onToolsChanged(); });
  }

  /** Spawns (or opens) and runs `initialize` within the connect deadline. Cleans up fully on any failure. */
  static async open(d: ConnectionDeps, signal?: AbortSignal): Promise<McpConnection> {
    const conn = new McpConnection(d);
    const ms = d.def.timeouts.connectMs;
    const dl = new Deadline(d.clock, ms, signal);
    try {
      // exactOptionalPropertyTypes: the SDK's transports declare optional members the strict `Transport` interface does not.
      await conn.client.connect(conn.transport as Transport, { signal: dl.signal, timeout: ms + SDK_TIMER_SLACK_MS });
      conn.pidValue = conn.transport instanceof StdioClientTransport ? conn.transport.pid : null;
      d.logger.info("mcp.server.started", { server: d.def.name, scope: d.def.scope.kind, transport: d.def.transport.type, pid: conn.pidValue });
      return conn;
    } catch (e) {
      await conn.close("hard");
      if (dl.timedOut) throw new McpClientError("connect-timeout", `${d.def.name}: no initialize answer within ${ms} ms`, { server: d.def.name });
      if (signal?.aborted) throw new McpClientError("aborted", `${d.def.name}: connect aborted`, { server: d.def.name });
      throw new McpClientError("connect-failed", d.redactor.redact(`${d.def.name}: ${(e as Error).message}`), { server: d.def.name, cause: e });
    } finally { dl.done(); }
  }

  get processId(): number | null { return this.pidValue; }
  get isClosed(): boolean { return this.closing !== null || this.exited; }
  get serverInfo(): { name: string; version: string } | null { const v = this.client.getServerVersion(); return v ? { name: v.name, version: v.version } : null; }

  async listTools(signal?: AbortSignal): Promise<McpToolDescriptor[]> {
    const out: McpToolDescriptor[] = [];
    await this.request(this.d.def.timeouts.listMs, signal, "tools/list", async (opts) => {
      let cursor: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const r = await this.client.listTools(cursor ? { cursor } : {}, opts);
        for (const t of r.tools) out.push(toDescriptor(t as unknown as Record<string, unknown>));
        cursor = r.nextCursor;
        if (!cursor) return;
      }
      // RULING: a server that pages without end is cut off at MAX_LIST_PAGES, not followed.
      this.d.logger.warn("mcp.server.list-truncated", { server: this.d.def.name, pages: MAX_LIST_PAGES });
    });
    return out;
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<RawToolResult> {
    return await this.request(this.d.def.timeouts.callMs, signal, `tools/call ${name}`, (opts) => this.client.callTool({ name, arguments: args }, undefined, opts) as Promise<RawToolResult>);
  }

  private async request<T>(ms: number, signal: AbortSignal | undefined, what: string, fn: (o: { signal: AbortSignal; timeout: number }) => Promise<T>): Promise<T> {
    const name = this.d.def.name;
    if (this.isClosed) throw new McpClientError("closed", `${name}: connection is closed`, { server: name });
    const dl = new Deadline(this.d.clock, ms, signal);
    try {
      return await fn({ signal: dl.signal, timeout: ms + SDK_TIMER_SLACK_MS });
    } catch (e) {
      // ADR-014 §6: a timeout or abort tears the connection down, so a wedged server costs one failed call.
      if (dl.timedOut) { await this.close("hard"); throw new McpClientError("call-timeout", `${name}: ${what} did not answer within ${ms} ms`, { server: name }); }
      if (signal?.aborted) { await this.close("hard"); throw new McpClientError("aborted", `${name}: ${what} aborted`, { server: name }); }
      throw this.mapError(e, what);
    } finally { dl.done(); }
  }

  private mapError(e: unknown, what: string): McpClientError {
    const name = this.d.def.name;
    const msg = this.d.redactor.redact(`${name}: ${what}: ${(e as Error).message}`);
    if (e instanceof McpError) {
      if (e.code === ErrorCode.RequestTimeout) { void this.close("hard"); return new McpClientError("call-timeout", msg, { server: name, cause: e }); }
      if (e.code === ErrorCode.ConnectionClosed) return new McpClientError("closed", msg, { server: name, cause: e });
      if (e.code === ErrorCode.MethodNotFound || e.code === ErrorCode.InvalidParams || e.code === ErrorCode.InternalError || e.code === ErrorCode.InvalidRequest) return new McpClientError("server-error", msg, { server: name, cause: e });
      return new McpClientError("protocol", msg, { server: name, cause: e });
    }
    return this.isClosed ? new McpClientError("closed", msg, { server: name, cause: e }) : new McpClientError("protocol", msg, { server: name, cause: e });
  }

  /** `graceful`: end stdin and let the server exit; `hard`: SIGTERM at once. Either way SIGKILL follows if the child
   *  ignores both, and the call returns only after the child has exited (or the bounded wait is over). */
  close(mode: "graceful" | "hard"): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.doClose(mode);
    return this.closing;
  }

  private async doClose(mode: "graceful" | "hard"): Promise<void> {
    const grace = this.d.def.timeouts.closeGraceMs;
    const t = this.transport;
    if (t instanceof StdioClientTransport) {
      const pid = t.pid ?? this.pidValue;
      const timers: NodeJS.Timeout[] = [];
      if (pid !== null) {
        if (mode === "hard") signalPid(pid, "SIGTERM");
        else timers.push(setTimeout(() => { if (!this.exited) signalPid(pid, "SIGTERM"); }, grace));
        timers.push(setTimeout(() => { if (!this.exited) signalPid(pid, "SIGKILL"); }, mode === "hard" ? grace : grace * 2));
      }
      try { await Promise.race([this.client.close(), sleepReal(grace * 3 + 1000)]); } catch { /* closing anyway */ }
      if (!this.exited) await Promise.race([new Promise<void>((r) => this.exitWaiters.push(r)), sleepReal(grace * 3 + 1000)]);
      for (const x of timers) clearTimeout(x);
      if (!this.exited && pid !== null) signalPid(pid, "SIGKILL"); // last resort: never leave the child behind
    } else {
      if (mode === "graceful") { try { await Promise.race([t.terminateSession(), sleepReal(grace)]); } catch { /* session already gone */ } }
      try { await Promise.race([this.client.close(), sleepReal(grace)]); } catch { /* closing anyway */ }
      this.exited = true;
    }
    this.flushStderr();
    this.d.logger.info("mcp.server.stopped", { server: this.d.def.name, mode });
  }

  private attachStderr(t: StdioClientTransport): void {
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
