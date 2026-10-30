// Hand-written ACP schema v1 client (owner 2026-10-29: no SDK). JSON-RPC over the shared line framing.
import type { Readable, Writable } from "node:stream";
import { LineReader, MAX_LINE_BYTES, encodeLine } from "../acp/framing.ts";
import { ACP_ERROR, ACP_MAX_OPEN_REQUESTS, ACP_MAX_UPDATE_BYTES, ACP_PROTOCOL_VERSION, ACP_REQUEST_TIMEOUT_MS, type JsonRpcId } from "../acp/protocol.ts";

const CLIENT_METHODS = new Set(["initialize", "session/new", "session/prompt", "session/cancel"]);
const AGENT_METHODS = new Set(["session/request_permission", "fs/read_text_file", "fs/write_text_file", "terminal/create", "terminal/output", "terminal/wait_for_exit", "terminal/kill", "terminal/release"]);

/** A refused ACP exchange. `reason` is the stable code tests and the delegation target match. */
export class AcpClientError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "AcpClientError";
    this.reason = reason;
  }
}

export interface AcpClientHandlers {
  readText(path: string): Promise<string>;
  writeText(path: string, content: string, params: Record<string, unknown>): Promise<void>;
  /** Returns a JSON-RPC result. A throw becomes an error response; the call is never executed without this handler. */
  permission(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  terminal(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  onUpdate(params: Record<string, unknown>): void;
}

export interface AcpClientOptions {
  input: Readable;
  output: Writable;
  handlers: AcpClientHandlers;
  log?: (event: string, fields?: Record<string, number | string>) => void;
  runTimeoutMs?: number;
  idleTimeoutMs?: number;
  signal?: AbortSignal;
}

type Pending = { method: string; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export class AcpClient {
  readonly #o: AcpClientOptions;
  readonly #pending = new Map<JsonRpcId, Pending>();
  #next = 1;
  #updates = 0;
  #deadline = 0;
  #agentRequests = 0;
  ignoredNotifications = 0;
  #closed = false;
  constructor(o: AcpClientOptions) {
    this.#o = o;
    const reader = new LineReader(MAX_LINE_BYTES);
    const handle = (items: ReturnType<LineReader["push"]>) => {
      for (const item of items) {
        if ("overflow" in item) { this.#failAll(new AcpClientError("line-too-long")); this.#o.log?.("line-too-long"); }
        else this.#message(item.line);
      }
    };
    o.input.on("data", (c: Buffer | string) => handle(reader.push(typeof c === "string" ? Buffer.from(c) : c)));
    o.input.on("end", () => { handle(reader.end()); this.close("closed"); });
    o.input.on("error", () => this.close("transport-error"));
    o.output.on("error", () => this.close("transport-error"));
    o.signal?.addEventListener("abort", () => this.close("aborted"), { once: true });
    if (o.signal?.aborted) this.close("aborted");
  }

  async initialize(): Promise<{ protocolVersion: number }> {
    const params = { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true }, clientInfo: { name: "plur1bus", title: "PLUR1BUS", version: "0.0.0" } };
    const result = await this.#request("initialize", params) as { protocolVersion?: unknown };
    if (!result || result.protocolVersion !== ACP_PROTOCOL_VERSION) throw new AcpClientError("protocol-version");
    return { protocolVersion: ACP_PROTOCOL_VERSION };
  }

  async newSession(cwd: string, mcpServers: readonly unknown[] = []): Promise<string> {
    const params = { cwd, mcpServers };
    const result = await this.#request("session/new", params) as { sessionId?: unknown };
    if (typeof result.sessionId !== "string" || !result.sessionId) throw new AcpClientError("session-id");
    return result.sessionId;
  }

  async prompt(sessionId: string, text: string): Promise<{ stopReason: string }> {
    this.#updates = 0;
    this.#deadline = Date.now() + (this.#o.runTimeoutMs ?? 600_000);
    const result = await this.#request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }) as { stopReason?: unknown };
    if (typeof result.stopReason !== "string") throw new AcpClientError("stop-reason");
    return { stopReason: result.stopReason };
  }

  /** End the run and ignore every late request or notification. */
  close(reason = "closed"): void { this.#failAll(new AcpClientError(reason)); }

  cancel(sessionId: string): void {
    this.#send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
  }

  #request(method: string, params: unknown): Promise<unknown> {
    if (!CLIENT_METHODS.has(method)) return Promise.reject(new AcpClientError("method"));
    if (this.#closed) return Promise.reject(new AcpClientError("closed"));
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new AcpClientError("request-timeout")); }, method === "session/prompt" ? Math.min(this.#o.idleTimeoutMs ?? 60_000, this.#deadline - Date.now()) : ACP_REQUEST_TIMEOUT_MS);
      this.#pending.set(id, { method, resolve, reject, timer });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  #send(message: unknown): void {
    try { this.#o.output.write(encodeLine(message)); } catch { this.#o.log?.("output-error"); }
  }

  #failAll(error: Error): void {
    this.#closed = true;
    for (const [id, pending] of this.#pending) { clearTimeout(pending.timer); this.#pending.delete(id); pending.reject(error); }
  }

  /** Rejects the in-flight client request of one method. A late reply for that id is ignored. */
  #failMethod(method: string, error: Error): void {
    for (const [id, pending] of this.#pending) {
      if (pending.method !== method) continue;
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      pending.reject(error);
    }
  }

  #message(line: string): void {
    if (this.#closed) return;
    let msg: unknown;
    try { msg = JSON.parse(line); } catch { this.#o.log?.("parse-error"); return; }
    if (!isObj(msg) || msg.jsonrpc !== "2.0") return;
    if (typeof msg.method === "string") {
      if ("id" in msg) void this.#agentRequest(msg.id, msg.method, msg.params);
      else this.#notification(msg.method, msg.params);
      return;
    }
    if (!("id" in msg) || (typeof msg.id !== "string" && typeof msg.id !== "number")) return;
    const pending = this.#pending.get(msg.id);
    if (!pending) { this.#o.log?.("unknown-response"); return; }
    clearTimeout(pending.timer);
    this.#pending.delete(msg.id);
    if ("error" in msg) pending.reject(new Error("agent-error"));
    else pending.resolve(msg.result);
  }

  #notification(method: string, params: unknown): void {
    if (method === "session/update") {
      if (!isObj(params) || !isObj(params.update)) { this.ignoredNotifications += 1; this.#o.log?.("notification-ignored"); return; }
      this.#updates += Buffer.byteLength(JSON.stringify(params));
      if (this.#updates > ACP_MAX_UPDATE_BYTES) {
        this.#o.log?.("update-limit", { count: this.#updates });
        this.#failMethod("session/prompt", new AcpClientError("update-limit"));
        return;
      }
      for (const pending of this.#pending.values()) if (pending.method === "session/prompt") {
        clearTimeout(pending.timer);
        pending.timer = setTimeout(() => this.#failMethod("session/prompt", new AcpClientError("request-timeout")),
          Math.max(0, Math.min(this.#o.idleTimeoutMs ?? 60_000, this.#deadline - Date.now())));
      }
      this.#o.handlers.onUpdate(params);
      return;
    }
    this.ignoredNotifications += 1;
    this.#o.log?.("notification-ignored");
  }

  async #agentRequest(id: unknown, method: string, params: unknown): Promise<void> {
    if (typeof id !== "string" && typeof id !== "number") return;
    if (!AGENT_METHODS.has(method) || !isObj(params)) {
      this.#send({ jsonrpc: "2.0", id, error: { code: ACP_ERROR.methodNotFound, message: "method not found" } });
      return;
    }
    if (this.#agentRequests >= ACP_MAX_OPEN_REQUESTS) {
      this.#send({ jsonrpc: "2.0", id, error: { code: ACP_ERROR.internal, message: "too many requests", data: { reason: "too-many-requests" } } });
      return;
    }
    this.#agentRequests += 1;
    try {
      const result = await this.#dispatch(method, { ...params, _requestId: String(id) });
      if (!this.#closed) this.#send({ jsonrpc: "2.0", id, result });
    } catch (e) {
      const reason = e instanceof Error ? e.message : "failed";
      if (!this.#closed) this.#send({ jsonrpc: "2.0", id, error: { code: ACP_ERROR.invalidParams, message: "refused", data: { reason: reason.slice(0, 80) } } });
    } finally { this.#agentRequests -= 1; }
  }

  async #dispatch(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (method === "fs/read_text_file") {
      if (typeof params.path !== "string") throw new Error("path");
      return { content: await this.#o.handlers.readText(params.path) };
    }
    if (method === "fs/write_text_file") {
      if (typeof params.path !== "string" || typeof params.content !== "string") throw new Error("path");
      await this.#o.handlers.writeText(params.path, params.content, params);
      return {};
    }
    if (method === "session/request_permission") return this.#o.handlers.permission(params);
    if (method.startsWith("terminal/")) return this.#o.handlers.terminal(method, params);
    throw new Error("method");
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
