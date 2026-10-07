// The ACP (Agent Client Protocol, schema v1, ADR-008) agent side over a line-framed stream. It implements `initialize`,
// `session/new`, `session/prompt`, `session/cancel` and sends `session/update`; everything else is a JSON-RPC error.
//
// Hygiene (ADR-008 stdout rule): `output` carries JSON-RPC lines and nothing else. The log sink gets event names and
// small counts only: never prompt text, model output, tool arguments, error text from a provider or any credential.
import type { Readable, Writable } from "node:stream";
import path from "node:path";
import type { AcpBackend, AcpTurnUpdate } from "./backend.ts";
import { LineReader, MAX_LINE_BYTES, encodeLine } from "./framing.ts";

export const ACP_PROTOCOL_VERSION = 1;
/** `session.submit`'s text limit (rpc.schema.json): a longer prompt is refused here instead of by the core. */
export const MAX_PROMPT_CHARS = 200_000;

export type LogFields = Record<string, string | number | boolean>;
export interface AcpServerOptions {
  backend: AcpBackend;
  input: Readable;
  output: Writable;
  log?: (event: string, fields?: LogFields) => void;
  agentInfo?: { name: string; title: string; version: string };
  maxLineBytes?: number;
}

type Id = string | number | null;
const ERR = { parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internal: -32603, busy: -32000 } as const;

class AcpError extends Error {
  readonly code: number; readonly data?: Record<string, string | number>;
  constructor(code: number, message: string, data?: Record<string, string | number>) { super(message); this.code = code; if (data) this.data = data; }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const short = (s: string): string => (s.length > 64 ? `${s.slice(0, 64)}…` : s).replace(/[^\x20-\x7e]/g, "?");
/** Client-chosen strings are never logged, a method name included (it can carry anything): only the methods this server
 *  knows, else "other". */
const KNOWN_METHODS: ReadonlySet<string> = new Set(["initialize", "session/new", "session/prompt", "session/cancel"]);
const logName = (m: string): string => (KNOWN_METHODS.has(m) ? m : "other");

export class AcpServer {
  readonly #o: AcpServerOptions;
  readonly #sessions = new Set<string>();
  /** Sessions with a prompt in flight, and whether the client asked to cancel it. */
  readonly #running = new Map<string, { cancelRequested: boolean }>();
  readonly #pending = new Set<Promise<unknown>>();
  #initialized = false;
  #closed = false;
  constructor(o: AcpServerOptions) { this.#o = o; }

  /** Serves until the input ends, then cancels what is still running and waits for it. */
  run(): Promise<void> {
    const reader = new LineReader(this.#o.maxLineBytes ?? MAX_LINE_BYTES);
    return new Promise<void>((resolve) => {
      const handle = (items: ReturnType<LineReader["push"]>) => {
        for (const it of items) {
          if ("overflow" in it) { this.#o.log?.("line-too-long"); this.#send({ jsonrpc: "2.0", id: null, error: { code: ERR.invalidRequest, message: "line too long", data: { reason: "line-too-long" } } }); }
          else { const p = this.#message(it.line); this.#pending.add(p); void p.finally(() => this.#pending.delete(p)); }
        }
      };
      this.#o.input.on("data", (c: Buffer | string) => handle(reader.push(typeof c === "string" ? Buffer.from(c) : c)));
      this.#o.input.on("error", () => { this.#o.log?.("input-error"); });
      this.#o.input.on("end", () => {
        handle(reader.end());
        this.#closed = true;
        for (const [sid, st] of this.#running) { st.cancelRequested = true; void this.#o.backend.cancel(sid).catch(() => {}); }
        void (async () => { while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]); resolve(); })();
      });
    });
  }

  #send(m: unknown): void { try { this.#o.output.write(encodeLine(m)); } catch { this.#o.log?.("output-error"); } }
  #reply(id: Id, result: unknown): void { this.#send({ jsonrpc: "2.0", id, result }); }
  #fail(id: Id, e: unknown): void {
    if (e instanceof AcpError) { this.#send({ jsonrpc: "2.0", id, error: { code: e.code, message: e.message, ...(e.data ? { data: e.data } : {}) } }); return; }
    // An unexpected failure: the cause is logged by class only, the client gets a fixed message.
    this.#o.log?.("internal-error", { name: e instanceof Error ? e.name : "unknown" });
    this.#send({ jsonrpc: "2.0", id, error: { code: ERR.internal, message: "internal error" } });
  }

  async #message(line: string): Promise<void> {
    let msg: unknown;
    try { msg = JSON.parse(line); } catch { this.#o.log?.("parse-error"); this.#send({ jsonrpc: "2.0", id: null, error: { code: ERR.parse, message: "parse error" } }); return; }
    if (!isObj(msg) || msg.jsonrpc !== "2.0") { this.#fail(null, new AcpError(ERR.invalidRequest, "invalid request")); return; }
    const hasId = "id" in msg;
    const id = msg.id;
    if (hasId && !(typeof id === "string" || typeof id === "number" || id === null)) { this.#fail(null, new AcpError(ERR.invalidRequest, "invalid request id")); return; }
    if (typeof msg.method !== "string") {
      // A response from the client (the agent has sent no request in this version) or garbage: nothing to answer.
      if (!("result" in msg || "error" in msg)) this.#fail(hasId ? (id as Id) : null, new AcpError(ERR.invalidRequest, "invalid request"));
      return;
    }
    const method = msg.method;
    const params = msg.params;
    if (!hasId) { this.#notification(method, params); return; }
    this.#o.log?.("request", { method: logName(method) });
    try { this.#reply(id as Id, await this.#request(method, params, id as Id)); }
    catch (e) { this.#fail(id as Id, e); }
  }

  #notification(method: string, params: unknown): void {
    if (method === "session/cancel") {
      const sid = isObj(params) && typeof params.sessionId === "string" ? params.sessionId : null;
      const st = sid ? this.#running.get(sid) : undefined;
      this.#o.log?.("cancel", { running: st !== undefined });
      if (sid && st) { st.cancelRequested = true; void this.#o.backend.cancel(sid).catch(() => this.#o.log?.("cancel-failed")); }
      return;
    }
    // `$/cancel_request` and any other notification: ignored by JSON-RPC rules (no reply possible).
    this.#o.log?.("notification-ignored", { method: logName(method) });
  }

  async #request(method: string, params: unknown, _id: Id): Promise<unknown> {
    switch (method) {
      case "initialize": return this.#initialize(params);
      case "session/new": this.#needInit(); return this.#newSession(params);
      case "session/prompt": this.#needInit(); return this.#prompt(params);
      default: throw new AcpError(ERR.methodNotFound, "method not found");
    }
  }

  #needInit(): void {
    // RULING: a request other than `initialize` before the handshake is refused (fail closed); the spec does not say.
    if (!this.#initialized) throw new AcpError(ERR.invalidRequest, "initialize first", { reason: "not-initialized" });
  }

  #initialize(params: unknown): unknown {
    if (!isObj(params) || !Number.isInteger(params.protocolVersion) || (params.protocolVersion as number) < 1) throw new AcpError(ERR.invalidParams, "protocolVersion must be a positive integer");
    this.#initialized = true;
    const info = this.#o.agentInfo ?? { name: "plur1bus", title: "PLUR1BUS", version: "0.0.0" };
    return {
      // The latest version we support that is not above the client's: schema v1 only (ADR-008; v2 alpha excluded).
      protocolVersion: Math.min(params.protocolVersion as number, ACP_PROTOCOL_VERSION),
      agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: false }, mcpCapabilities: { http: false, sse: false } },
      agentInfo: info,
      authMethods: [],
    };
  }

  async #newSession(params: unknown): Promise<unknown> {
    if (!isObj(params) || typeof params.cwd !== "string" || !(path.posix.isAbsolute(params.cwd) || path.win32.isAbsolute(params.cwd))) throw new AcpError(ERR.invalidParams, "cwd must be an absolute path");
    if (params.mcpServers !== undefined && !Array.isArray(params.mcpServers)) throw new AcpError(ERR.invalidParams, "mcpServers must be an array");
    // RULING: `cwd` is validated and not used or stored (this adapter touches no file); client-supplied MCP servers are
    // accepted and not started (the harness has no MCP client for ACP sessions yet; ADR-014) and only their number is logged.
    this.#o.log?.("session-new", { mcpServers: (params.mcpServers as unknown[] | undefined)?.length ?? 0 });
    const { sessionId } = await this.#o.backend.createSession();
    this.#sessions.add(sessionId);
    return { sessionId };
  }

  async #prompt(params: unknown): Promise<unknown> {
    if (!isObj(params) || typeof params.sessionId !== "string" || !Array.isArray(params.prompt)) throw new AcpError(ERR.invalidParams, "sessionId and prompt are required");
    const sessionId = params.sessionId;
    if (!this.#sessions.has(sessionId)) throw new AcpError(ERR.invalidParams, "unknown session", { reason: "unknown-session" });
    const text = promptText(params.prompt);
    if (this.#closed) throw new AcpError(ERR.internal, "connection closing");
    if (this.#running.has(sessionId)) throw new AcpError(ERR.busy, "a prompt is already running for this session", { reason: "turn-in-progress" });
    const st = { cancelRequested: false };
    this.#running.set(sessionId, st);
    try {
      const out = await this.#o.backend.prompt({ sessionId, text }, (u) => this.#update(sessionId, u));
      this.#o.log?.("prompt-done", { state: out.state });
      if (out.state === "completed" && !st.cancelRequested) return { stopReason: "end_turn" };
      if (out.state === "cancelled" || st.cancelRequested) return { stopReason: "cancelled" };
      throw new AcpError(ERR.internal, "turn failed", { reason: "turn-failed" });
    } finally { this.#running.delete(sessionId); }
  }

  #update(sessionId: string, u: AcpTurnUpdate): void {
    let update: Record<string, unknown>;
    if (u.type === "text") update = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: u.text } };
    else if (u.type === "tool.call") update = { sessionUpdate: "tool_call", toolCallId: u.id, title: u.name, kind: "other", status: "in_progress", ...(u.args !== undefined ? { rawInput: u.args } : {}) };
    else update = { sessionUpdate: "tool_call_update", toolCallId: u.id, status: "completed", content: [{ type: "content", content: { type: "text", text: u.output } }] };
    this.#send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
  }
}

/** Text and resource links are handled; every other block type is refused by name (never dropped silently, ADR-008). */
function promptText(blocks: unknown[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (!isObj(b) || typeof b.type !== "string") throw new AcpError(ERR.invalidParams, "invalid content block");
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (b.type === "resource_link" && typeof b.uri === "string") parts.push(`[resource: ${typeof b.name === "string" ? b.name : ""} ${b.uri}]`.replace(/\s+\]/, "]"));
    else throw new AcpError(ERR.invalidParams, "unsupported content block", { reason: "unsupported-content-block", type: short(b.type) });
  }
  const text = parts.join("\n");
  if (text.trim().length === 0) throw new AcpError(ERR.invalidParams, "prompt is empty", { reason: "prompt-empty" });
  if (text.length > MAX_PROMPT_CHARS) throw new AcpError(ERR.invalidParams, "prompt too long", { reason: "prompt-too-long", max: MAX_PROMPT_CHARS });
  return text;
}
