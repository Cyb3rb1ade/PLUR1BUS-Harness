/** Synthetic D122 fm boundary: Unix HTTP only, a 0755 socket inside a 0700 directory, and JSON/SSE responses. */
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingHttpHeaders, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Captured synthetic request, including the bytes the production adapter actually wrote. */
export interface FakeFmRequest {
  method: string | undefined;
  path: string | undefined;
  headers: IncomingHttpHeaders;
  body: string;
}

/** Boundary variants; no mode invokes a real executable or a model. */
export interface FakeFmOptions {
  mode?: "text" | "tools" | "schema" | "overflow" | "stream-overflow" | "hang" | "hang-headers";
  /** Measured text stream:false is JSON; tools/schema JSON shapes are synthetic (AF0 measured them only as SSE).
   * always-sse is a synthetic tolerance case; the native tool/schema JSON shape remains open (L7). */
  format?: "native" | "always-sse";
  health?: unknown;
  models?: unknown;
  usage?: boolean;
  missingDone?: boolean;
  missingFinish?: boolean;
  handler?: (request: FakeFmRequest, response: ServerResponse) => void | Promise<void>;
}

/** Owned test server; close() tears down every connection and removes only its own temporary tree. */
export interface FakeFmServe {
  directory: string;
  socket: { id: "apple-fm"; path: string };
  requests: FakeFmRequest[];
  connections(): number;
  waitForRequests(count: number): Promise<void>;
  waitForDisconnect(): Promise<void>;
  disconnect(): void;
  close(): Promise<void>;
}

const READY = {
  status: "fm serve is running",
  models: [{ name: "system", available: true }, { name: "pcc", available: false, reason: "synthetic cloud refusal" }],
};
const MODELS = { object: "list", data: [{ id: "system", owned_by: "Apple" }, { id: "pcc", owned_by: "Apple" }] };
const TRANSCRIPT_OVERFLOW = {
  error: {
    message: "The session's transcript exceeded the model's context size.", type: "server_error", code: "500",
  },
};

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function delta(response: ServerResponse, value: object, finish: string | null = null): void {
  response.write(`data: ${JSON.stringify({
    id: "synthetic-fm", model: "system", choices: [{ index: 0, delta: value, finish_reason: finish }],
  })}\n\n`);
}

function jsonRequested(request: FakeFmRequest, options: FakeFmOptions): boolean {
  if (options.format === "always-sse") return false;
  let body: unknown;
  try {
    body = JSON.parse(request.body);
  } catch {
    return false;
  }
  return typeof body === "object" && body !== null && "stream" in body && body.stream === false;
}

function jsonCompletion(response: ServerResponse, options: FakeFmOptions): void {
  if (options.mode === "hang") {
    response.writeHead(200, { "content-type": "application/json" });
    response.write("{\"synthetic\":\"pending");
    return;
  }
  const message = options.mode === "tools" ? {
    role: "assistant", content: null,
    tool_calls: [{
      id: "weather-1", type: "function", function: { name: "weather", arguments: "{\"city\":\"Bern\"}" },
    }],
  } : { role: "assistant", content: options.mode === "schema" ? "{\"category\":\"reminder\"}" : "Hallo" };
  json(response, 200, {
    id: "synthetic-fm", model: "system", object: "chat.completion",
    choices: [{ index: 0, message, finish_reason: options.mode === "tools" ? "tool_calls" : "stop" }],
    ...(options.usage === false ? {} : { usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } }),
  });
}

function completion(request: FakeFmRequest, response: ServerResponse, options: FakeFmOptions): void {
  if (options.mode === "overflow") {
    json(response, 500, TRANSCRIPT_OVERFLOW);
    return;
  }
  if (options.mode === "hang-headers") return;
  if (options.mode !== "stream-overflow" && jsonRequested(request, options)) {
    jsonCompletion(response, options);
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
  if (options.mode === "stream-overflow") {
    // AF0's review follow-up: role chunk, transcript error, clean EOF without finish, usage or DONE.
    delta(response, { role: "assistant" });
    response.end(`data: ${JSON.stringify(TRANSCRIPT_OVERFLOW)}\n\n`);
    return;
  }
  if (options.mode === "tools") {
    delta(response, { tool_calls: [{
      index: 0, id: "weather-1", type: "function", function: { name: "weather", arguments: "{\"city\":" },
    }] });
    delta(response, { tool_calls: [{ index: 0, function: { arguments: "\"Bern\"}" } }] });
  } else {
    delta(response, {
      role: "assistant", content: options.mode === "schema" ? "{\"category\":\"reminder\"}" : "Hallo",
    });
  }
  if (options.mode === "hang") return;
  if (!options.missingFinish) delta(response, {}, options.mode === "tools" ? "tool_calls" : "stop");
  if (options.usage !== false) {
    response.write(`data: ${JSON.stringify({
      choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
    })}\n\n`);
  }
  response.end(options.missingDone ? "" : "data: [DONE]\n\n");
}

/** Start a fake fm boundary on a real Unix socket; options stay mutable for deterministic failure transitions. */
export async function startFakeFmServe(options: FakeFmOptions = {}): Promise<FakeFmServe> {
  // macOS's default per-user TMPDIR can already consume sun_path; this is a test fixture, not a production layout.
  const directory = await mkdtemp(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "p1fm-"));
  await chmod(directory, 0o700);
  const path = join(directory, "fm.sock");
  const sockets = new Set<Socket>();
  const requests: FakeFmRequest[] = [];
  const requestWaiters: { count: number; resolve: () => void }[] = [];
  const disconnectWaiters: (() => void)[] = [];
  const server = createServer((request, response) => {
    const parts: Buffer[] = [];
    request.on("data", (part: Buffer) => parts.push(part));
    request.on("end", () => {
      const recorded = {
        method: request.method, path: request.url, headers: request.headers,
        body: Buffer.concat(parts).toString("utf8"),
      };
      requests.push(recorded);
      for (const waiter of requestWaiters.splice(0)) {
        if (requests.length >= waiter.count) waiter.resolve();
        else requestWaiters.push(waiter);
      }
      if (options.handler) {
        Promise.resolve(options.handler(recorded, response)).catch(() => response.destroy());
      } else if (request.url === "/health") {
        json(response, 200, options.health ?? READY);
      } else if (request.url === "/v1/models") {
        json(response, 200, options.models ?? MODELS);
      } else if (request.url === "/v1/chat/completions") {
        completion(recorded, response, options);
      } else {
        json(response, 404, { error: { message: "synthetic unknown path" } });
      }
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
      if (sockets.size === 0) for (const resolve of disconnectWaiters.splice(0)) resolve();
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    await chmod(path, 0o755);
  } catch (error) {
    server.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const disconnect = () => {
    for (const socket of sockets) socket.destroy();
  };
  return {
    directory, socket: { id: "apple-fm", path }, requests, connections: () => sockets.size,
    waitForRequests: (count) => requests.length >= count ? Promise.resolve()
      : new Promise<void>((resolve) => requestWaiters.push({ count, resolve })),
    waitForDisconnect: () => sockets.size === 0 ? Promise.resolve()
      : new Promise<void>((resolve) => disconnectWaiters.push(resolve)),
    disconnect,
    async close() {
      disconnect();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}
