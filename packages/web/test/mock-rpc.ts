// Mock JSON-RPC (`/rpc`) and SSE (`/events`) for the web UI tests. Both hang off MockHarnessServer (`server.rpc`,
// `server.events`); neither exists on the real backend yet (origin/main serves only /api/v1/{session,csrf,health,whoami,
// agents}), so they follow the contract of docs/rpc.md and src/api/routes.ts. Both are OFF until a test turns them on
// (`enable()`; `handle()` and `push()` enable implicitly), which is also what the real backend looks like today: 404.
//
// ---- /rpc ---------------------------------------------------------------------------------------------------------
//   const { rpc: mockRpc } = server;
//   mockRpc.enable();                                                    // else /rpc answers 404
//   mockRpc.handle("dreams.status", (params, ctx) => ({ enabled: true }));   // success
//   mockRpc.handle("dreams.run", () => { throw rpcError("E_CONFLICT", "busy", "turn-running"); }, { write: true });
//   mockRpc.scenario("dreams.status", "empty");        // "success" | "empty" | "error" | "forbidden" | "unavailable"
//   mockRpc.scenario("dreams.status", "error", { code: "E_INTERNAL", message: "boom", reason: "x" });
//   mockRpc.setDelay("dreams.status", 200);            // ms, for loading states
//   mockRpc.calls                                      // [{ method, params, csrf }] in arrival order
// Rules: session cookie required (401 E_UNAUTHORIZED reason no-session); a method registered with `write: true`
// (default) additionally needs a fresh one-time X-CSRF-Token (403 E_DENIED reason csrf, same rule as the /api/v1 mock;
// `server.rejectCsrf = n` refuses the next n tokens). `{ write: false }` skips the check. Unregistered methods answer
// -32601. `empty` is the `{ empty }` handle option (default null). JSON-RPC errors travel in HTTP 200.
//
// ---- /events ------------------------------------------------------------------------------------------------------
//   const { events: mockEvents } = server;
//   mockEvents.enable();                               // else /events answers 404
//   mockEvents.push({ event: "session.event", data: { n: 1 } });     // data: string | JSON-able; id auto-numbered
//   mockEvents.push({ event: "models.changed", data: "a\nb", id: "x-9" });   // multi-line data -> several data: lines
//   mockEvents.pushRaw(["event: te", "st\ndata: 1\n\n"]);          // raw chunks, each flushed on its own
//   mockEvents.comment("keep-alive");                  // ": keep-alive"
//   mockEvents.dropConnections();                      // kill every open stream (the client should reconnect)
//   await mockEvents.waitForConnections(2);           // resolves once the 2nd connection has been opened
//   mockEvents.connections                             // [{ lastEventId }] one entry per accepted connection
//   mockEvents.refuse(401)                             // next connections answer this HTTP status (null = stop refusing)
// Rules: session cookie required (401). `Last-Event-ID` replays the pushed events whose id comes later in the history.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { MockHarnessServer } from "./mock-server.ts";

export type MockErrorCode =
  | "E_UNAUTHORIZED" | "E_RPC_VERSION" | "E_NOT_AVAILABLE" | "E_CORE_UNAVAILABLE" | "E_INVALID_PARAMS" | "E_AGENT_UNKNOWN" | "E_CONFIG_INVALID"
  | "E_MODULE_UNKNOWN" | "E_INTERNAL" | "E_LOCKED" | "E_NOT_FOUND" | "E_DENIED" | "E_APPROVAL_REQUIRED" | "E_CONFLICT" | "E_STORAGE"
  | "E_MEDIA_CAPABILITY" | "E_MEDIA_LICENSE" | "E_MEDIA_PRIVACY" | "E_MEDIA_UNAVAILABLE" | "E_MEDIA_DIMENSION" | "E_MEDIA_UNSUPPORTED_KIND";

/** Throw this from a handler to answer a JSON-RPC error (`error.data.error` = code, optional reason). */
export class MockRpcError extends Error {
  readonly code: MockErrorCode; readonly reason: string | undefined; readonly numeric: number;
  constructor(code: MockErrorCode, message: string, reason?: string, numeric = -32000) {
    super(message); this.name = "MockRpcError"; this.code = code; this.reason = reason; this.numeric = numeric;
  }
}
export function rpcError(code: MockErrorCode, message: string = code, reason?: string): MockRpcError { return new MockRpcError(code, message, reason); }

export type MockRpcCtx = { csrf: string | null; sessionId: string };
export type MockRpcHandler = (params: unknown, ctx: MockRpcCtx) => unknown | Promise<unknown>;
export type MockScenario = "success" | "empty" | "error" | "forbidden" | "unavailable";
export type MockRpcCall = { method: string; params: unknown; csrf: string | null };
type Entry = { fn: MockRpcHandler; write: boolean; empty: unknown; scenario: MockScenario; failure: { code: MockErrorCode; message: string; reason?: string } | null; delayMs: number };

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
function httpError(res: ServerResponse, status: number, error: string, reason: string): void {
  sendJson(res, status, { schema: "error/1", error, message: reason, reason });
}

export class MockRpc {
  readonly calls: MockRpcCall[] = [];
  #enabled = false;
  readonly #methods = new Map<string, Entry>();
  readonly #server: MockHarnessServer;
  constructor(server: MockHarnessServer) { this.#server = server; }

  enable(on = true): void { this.#enabled = on; }

  handle(method: string, fn: MockRpcHandler, opts: { write?: boolean; empty?: unknown } = {}): void {
    this.#enabled = true;
    this.#methods.set(method, { fn, write: opts.write ?? true, empty: opts.empty ?? null, scenario: "success", failure: null, delayMs: 0 });
  }

  scenario(method: string, scenario: MockScenario, failure?: { code: MockErrorCode; message?: string; reason?: string }): void {
    const e = this.#methods.get(method);
    if (!e) throw new Error(`mock-rpc: no handler for ${method}; call handle() first`);
    e.scenario = scenario;
    e.failure = failure ? { code: failure.code, message: failure.message ?? failure.code, ...(failure.reason ? { reason: failure.reason } : {}) } : null;
  }

  setDelay(method: string, ms: number): void {
    const e = this.#methods.get(method);
    if (!e) throw new Error(`mock-rpc: no handler for ${method}; call handle() first`);
    e.delayMs = ms;
  }

  async serve(req: IncomingMessage, res: ServerResponse, path: string, body: string): Promise<boolean> {
    if (path !== "/rpc") return false;
    if (!this.#enabled) { httpError(res, 404, "E_NOT_FOUND", "route"); return true; }
    if (req.method !== "POST") { res.setHeader("allow", "POST"); httpError(res, 405, "E_INVALID_PARAMS", "method-not-allowed"); return true; }
    const s = this.#server.sessionOf(req);
    if (!s) { httpError(res, 401, "E_UNAUTHORIZED", "no-session"); return true; }
    let msg: { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
    try { msg = JSON.parse(body) as typeof msg; } catch { sendJson(res, 200, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); return true; }
    const id = typeof msg.id === "string" || typeof msg.id === "number" ? msg.id : null;
    const fail = (numeric: number, message: string, code?: MockErrorCode, reason?: string): true => {
      sendJson(res, 200, { jsonrpc: "2.0", id, error: { code: numeric, message, ...(code ? { data: { error: code, ...(reason ? { reason } : {}) } } : {}) } });
      return true;
    };
    if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return fail(-32600, "invalid request");
    const csrfHeader = req.headers["x-csrf-token"];
    const csrf = typeof csrfHeader === "string" ? csrfHeader : null;
    this.calls.push({ method: msg.method, params: msg.params, csrf });
    const e = this.#methods.get(msg.method);
    if (!e) return fail(-32601, "method not found");
    if (e.write) {
      const ok = csrf !== null && s.csrf.delete(csrf) && this.#server.rejectCsrf === 0;
      if (this.#server.rejectCsrf > 0) this.#server.rejectCsrf -= 1;
      if (!ok) { httpError(res, 403, "E_DENIED", "csrf"); return true; }
    }
    if (e.delayMs > 0) await new Promise<void>((r) => setTimeout(r, e.delayMs));
    switch (e.scenario) {
      case "empty": sendJson(res, 200, { jsonrpc: "2.0", id, result: e.empty }); return true;
      case "forbidden": return fail(-32000, "denied", "E_DENIED", "no-permission");
      case "unavailable": return fail(-32000, "not available", "E_NOT_AVAILABLE", "mock-unavailable");
      case "error": return fail(-32000, e.failure?.message ?? "failure", e.failure?.code ?? "E_INTERNAL", e.failure?.reason);
      case "success": break;
    }
    try {
      const result = await e.fn(msg.params, { csrf, sessionId: s.id });
      sendJson(res, 200, { jsonrpc: "2.0", id, result: result === undefined ? null : result });
    } catch (err) {
      if (err instanceof MockRpcError) return fail(err.numeric, err.message, err.code, err.reason);
      return fail(-32603, "internal error", "E_INTERNAL");
    }
    return true;
  }
}

export type MockSseEvent = { event?: string; data: unknown; id?: string };

export class MockEvents {
  /** One entry per accepted connection, with the Last-Event-ID header it sent (null when absent). */
  readonly connections: { lastEventId: string | null }[] = [];
  readonly history: { id: string; text: string }[] = [];
  #enabled = false;
  #status: number | null = null;
  #seq = 0;
  readonly #open = new Set<ServerResponse>();
  readonly #waiters: { n: number; resolve: () => void }[] = [];
  readonly #server: MockHarnessServer;
  constructor(server: MockHarnessServer) { this.#server = server; }

  enable(on = true): void { this.#enabled = on; }
  refuse(status: number | null): void { this.#status = status; }
  get openCount(): number { return this.#open.size; }

  push(e: MockSseEvent): string {
    this.#enabled = true;
    const id = e.id ?? String(++this.#seq);
    const data = typeof e.data === "string" ? e.data : JSON.stringify(e.data);
    const text = `${e.event ? `event: ${e.event}\n` : ""}id: ${id}\n${data.split("\n").map((l) => `data: ${l}`).join("\n")}\n\n`;
    this.history.push({ id, text });
    for (const r of this.#open) r.write(text);
    return id;
  }

  /** Raw bytes to every open stream, one write per chunk (a chunk boundary can fall anywhere, even inside a field). */
  async pushRaw(chunks: string[]): Promise<void> {
    for (const c of chunks) {
      for (const r of this.#open) r.write(c);
      await new Promise<void>((r) => setTimeout(r, 15));
    }
  }

  comment(text: string): void { for (const r of this.#open) r.write(`: ${text}\n\n`); }

  dropConnections(): void { for (const r of [...this.#open]) { this.#open.delete(r); r.destroy(); } }

  waitForConnections(n: number): Promise<void> {
    if (this.connections.length >= n) return Promise.resolve();
    return new Promise<void>((resolve) => { this.#waiters.push({ n, resolve }); });
  }

  serve(req: IncomingMessage, res: ServerResponse, path: string): boolean {
    if (path !== "/events") return false;
    if (!this.#enabled) { httpError(res, 404, "E_NOT_FOUND", "route"); return true; }
    if (!this.#server.sessionOf(req)) { httpError(res, 401, "E_UNAUTHORIZED", "no-session"); return true; }
    if (this.#status !== null) { httpError(res, this.#status, this.#status === 401 ? "E_UNAUTHORIZED" : this.#status === 403 ? "E_DENIED" : this.#status === 404 ? "E_NOT_FOUND" : "E_CORE_UNAVAILABLE", "mock-refused"); return true; }
    const last = req.headers["last-event-id"];
    const lastEventId = typeof last === "string" ? last : null;
    this.connections.push({ lastEventId });
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
    res.write(": connected\n\n");
    if (lastEventId !== null) {
      const at = this.history.findIndex((h) => h.id === lastEventId);
      if (at >= 0) for (const h of this.history.slice(at + 1)) res.write(h.text);
    }
    this.#open.add(res);
    res.on("close", () => { this.#open.delete(res); });
    for (const w of [...this.#waiters]) if (this.connections.length >= w.n) { this.#waiters.splice(this.#waiters.indexOf(w), 1); w.resolve(); }
    return true;
  }
}
