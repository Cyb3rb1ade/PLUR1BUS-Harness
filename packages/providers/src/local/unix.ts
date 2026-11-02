/** D122 AF1: bounded HTTP on one managed Unix socket. Filesystem trust belongs to the injected core guard. */
import { request as httpRequest } from "node:http";
import type { ClientRequest, IncomingMessage } from "node:http";
import { isAbsolute } from "node:path";
import { Readable } from "node:stream";
import { protocolError, ProviderError } from "../errors.ts";

/** A layout-resolved descriptor supplied by composition, never a path read from a provider profile. */
export interface ManagedUnixSocket {
  readonly id: "apple-fm";
  readonly path: string;
}

/** Content-free refusals suitable for AF2's transport counters. */
export type UnixRefusalReason = "platform" | "socket-untrusted" | "socket-path-too-long";

/** The core checks ownership, socket type and the private parent without following symlinks (D122 §3.3). */
export interface UnixSocketGuard {
  verify(socket: ManagedUnixSocket):
    | { ok: true }
    | { ok: false; reason: UnixRefusalReason }
    | Promise<{ ok: true } | { ok: false; reason: UnixRefusalReason }>;
}

/** Host ports; the core guard is consulted before every connection, without caching trust. */
export interface UnixFetchOptions {
  guard: UnixSocketGuard;
  platform?: NodeJS.Platform;
}

/** Synthetic origin: it is never resolved or sent to a TCP connector. */
export const APPLE_FM_BASE_URL = "http://apple-fm.invalid/v1";
const ORIGIN = "http://apple-fm.invalid";
const MAX_SOCKET_BYTES = 103;
const CONNECT_TIMEOUT_MS = 2000;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_HEADER_BYTES = 16 * 1024;
const HEALTH_BODY_BYTES = 64 * 1024;
const MODEL_BODY_BYTES = 1024 * 1024;
const CHAT_BODY_BYTES = 16 * 1024 * 1024;
const METHODS = new Map([
  ["/health", "GET"], ["/v1/models", "GET"], ["/v1/chat/completions", "POST"],
]);
const ALLOWED_HEADERS = new Set(["accept", "content-type"]);

function unavailable(reason: UnixRefusalReason | "unavailable"): ProviderError {
  const hint = reason === "socket-path-too-long" ? "; use a shorter PLUR1BUS_HOME" : "";
  return new ProviderError("network", `managed Unix provider is unavailable (${reason})${hint}`, {
    code: reason, retryable: false,
  });
}

function aborted(): ProviderError {
  return new ProviderError("aborted", "managed Unix request was cancelled", { retryable: false });
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw aborted();
}

/** Race even a port or request body that ignores cancellation; every listener is removed on settlement. */
async function interruptible<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  checkAbort(signal);
  let onAbort!: () => void;
  const interruption = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(aborted());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, interruption]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function descriptor(socket: ManagedUnixSocket): ManagedUnixSocket {
  if (typeof socket !== "object" || socket === null || socket.id !== "apple-fm"
    || typeof socket.path !== "string" || !isAbsolute(socket.path) || socket.path.includes("\0")) {
    throw new TypeError("managed Unix socket needs the apple-fm id and an absolute layout path");
  }
  // Capture both values before an async guard can yield; later caller mutation cannot redirect a connection.
  return Object.freeze({ id: "apple-fm", path: socket.path });
}

function checkedRequest(input: RequestInfo | URL, init: RequestInit | undefined): Request {
  let request: Request;
  try {
    request = new Request(input, init);
  } catch {
    // Request/Headers constructors can echo rejected URL credentials or header values in their native errors.
    throw new TypeError("managed Unix request is malformed");
  }
  const url = new URL(request.url);
  if (url.origin !== ORIGIN || url.username || url.password || url.search || url.hash || !METHODS.has(url.pathname)) {
    throw new TypeError("managed Unix request must use the fixed apple-fm origin and endpoint");
  }
  if (request.method !== METHODS.get(url.pathname)) {
    throw new TypeError("managed Unix endpoint does not allow this HTTP method");
  }
  request.headers.forEach((_value, name) => {
    if (!ALLOWED_HEADERS.has(name)) throw new TypeError(`header "${name}" is not allowed on a managed Unix request`);
  });
  return request;
}

async function requestBody(request: Request): Promise<Buffer | undefined> {
  if (!request.body) return undefined;
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await interruptible(reader.read(), request.signal);
      checkAbort(request.signal);
      if (done) return Buffer.concat(parts, size);
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        throw new ProviderError("invalid_request", "managed Unix request body exceeds one MiB", { retryable: false });
      }
      parts.push(value);
    }
  } finally {
    // Do not await a caller-owned stream's cancellation hook: it too may ignore the abort.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function bodyLimit(path: string): number {
  if (path === "/health") return HEALTH_BODY_BYTES;
  return path === "/v1/models" ? MODEL_BODY_BYTES : CHAT_BODY_BYTES;
}

function responseBody(incoming: IncomingMessage, request: ClientRequest, maxBytes: number): ReadableStream<Uint8Array> {
  const reader = (Readable.toWeb(incoming) as ReadableStream<Uint8Array>).getReader();
  let received = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        received += value.byteLength;
        if (received > maxBytes) throw protocolError("managed Unix response body exceeds its byte limit");
        controller.enqueue(value);
      } catch (error) {
        controller.error(error instanceof ProviderError ? error : unavailable("unavailable"));
        request.destroy();
        void reader.cancel().catch(() => undefined);
      }
    },
    async cancel() {
      request.destroy();
      await reader.cancel().catch(() => undefined);
    },
  }, { highWaterMark: 0 });
}

function fromUnixResponse(incoming: IncomingMessage, request: ClientRequest, maxBytes: number): Response {
  const status = incoming.statusCode ?? 500;
  if (status < 200 || status > 599) throw protocolError("managed Unix response has an invalid HTTP status");
  const headers = new Headers();
  for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
    headers.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
  }
  if (Number(headers.get("content-length")) > maxBytes) {
    throw protocolError("managed Unix response body exceeds its byte limit");
  }
  const bodyless = status === 204 || status === 205 || status === 304;
  if (bodyless) incoming.resume();
  return new Response(bodyless ? null : responseBody(incoming, request, maxBytes), { status, headers });
}

function connect(socket: ManagedUnixSocket, request: Request, body: Buffer | undefined): Promise<Response> {
  const path = new URL(request.url).pathname;
  return new Promise<Response>((resolve, reject) => {
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      headers[name] = value;
    });
    headers["host"] = "apple-fm.invalid";
    if (body !== undefined) headers["content-length"] = String(body.byteLength);
    const connection = httpRequest({
      socketPath: socket.path, path, method: request.method, headers,
      agent: false, maxHeaderSize: MAX_HEADER_BYTES, signal: request.signal,
    });
    const timer = setTimeout(() => connection.destroy(unavailable("unavailable")), CONNECT_TIMEOUT_MS);
    const connected = () => clearTimeout(timer);
    connection.once("socket", (stream) => {
      if (stream.connecting) stream.once("connect", connected);
      else connected();
    });
    connection.once("error", () => reject(request.signal.aborted ? aborted() : unavailable("unavailable")));
    connection.once("close", connected);
    connection.once("upgrade", (_response, stream) => {
      stream.destroy();
      reject(protocolError("managed Unix responses cannot upgrade protocols"));
    });
    connection.once("response", (incoming) => {
      incoming.once("error", () => reject(unavailable("unavailable")));
      try {
        resolve(fromUnixResponse(incoming, connection, bodyLimit(path)));
      } catch (error) {
        incoming.destroy();
        reject(error instanceof ProviderError ? error : protocolError("managed Unix response headers are malformed"));
      }
    });
    connection.end(body);
  });
}

/**
 * A fetch-compatible boundary for one managed socket. Only GET health/models and POST chat are accepted; no DNS,
 * TCP, proxy, redirect or auth is possible. Abort and body cancellation close the connection; callers bound idle/total.
 * Invalid request surfaces throw TypeError; platform/trust failures are non-retryable ProviderError network refusals.
 */
export function createUnixFetch(socket: ManagedUnixSocket, options: UnixFetchOptions): typeof fetch {
  const managed = descriptor(socket);
  if (!options?.guard || typeof options.guard.verify !== "function") {
    throw new TypeError("managed Unix socket needs a guard");
  }
  async function verify(signal: AbortSignal): Promise<void> {
    try {
      const result = await interruptible(Promise.resolve().then(() => options.guard.verify(managed)), signal);
      checkAbort(signal);
      if (result?.ok !== true) throw unavailable(result?.reason ?? "socket-untrusted");
    } catch (error) {
      if (signal.aborted) throw aborted();
      if (error instanceof ProviderError) {
        for (const reason of ["platform", "socket-path-too-long"] as const) {
          if (error.code === reason) throw unavailable(reason);
        }
      }
      throw unavailable("socket-untrusted");
    }
  }

  return async (input, init) => {
    const request = checkedRequest(input, init);
    checkAbort(request.signal);
    if ((options.platform ?? process.platform) === "win32") throw unavailable("platform");
    if (Buffer.byteLength(managed.path, "utf8") > MAX_SOCKET_BYTES) throw unavailable("socket-path-too-long");
    const body = await requestBody(request);
    checkAbort(request.signal);
    await verify(request.signal);
    checkAbort(request.signal);
    return connect(managed, request, body);
  };
}
