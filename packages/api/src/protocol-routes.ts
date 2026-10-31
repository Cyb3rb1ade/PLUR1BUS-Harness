import type { ServerResponse } from "node:http";
import { ApiError } from "./errors.ts";
import type { TokenAudience } from "./ports.ts";

export const DEFAULT_PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";
export const DEFAULT_PROTOCOL_HEARTBEAT_MS = 15_000;

export interface ProtocolRouteOptions {
  /** Required token binding audience ("mcp" | "a2a"). Omit on public discovery routes. */
  readonly audience?: TokenAudience | undefined;
  /** Path parameter name holding the target agentId (e.g. "agent" for `/a2a/{agent}`). */
  readonly agentParam?: string | undefined;
  /** Maximum request body size in bytes for this route. */
  readonly maxBodyBytes?: number | undefined;
  /** Request body read deadline in ms. */
  readonly bodyTimeoutMs?: number | undefined;
  /** Handler execution deadline in ms. */
  readonly handlerTimeoutMs?: number | undefined;
  /** Protected resource metadata path (RFC 9728) advertised in 401 `WWW-Authenticate: Bearer resource_metadata="..."`. */
  readonly resourceMetadataPath?: string | undefined;
}

/** Builds the RFC 9728 `WWW-Authenticate` header value for a 401 response on a protected protocol route. */
export function wwwAuthenticateBearer(
  origin: string,
  resourceMetadataPath = DEFAULT_PROTECTED_RESOURCE_METADATA_PATH,
  error?: { code: string; description?: string },
): string {
  const base = origin.replace(/\/+$/, "");
  const path = resourceMetadataPath.startsWith("/") ? resourceMetadataPath : `/${resourceMetadataPath}`;
  const parts = [`resource_metadata="${base}${path}"`];
  if (error?.code) {
    parts.push(`error="${error.code.replace(/"/g, "")}"`);
    if (error.description) parts.push(`error_description="${error.description.replace(/"/g, "")}"`);
  }
  return `Bearer ${parts.join(", ")}`;
}

/** Creates a 401 `ApiError` carrying `WWW-Authenticate: Bearer resource_metadata="..."`. */
export function protocolUnauthenticatedError(
  reason: string,
  origin: string,
  resourceMetadataPath = DEFAULT_PROTECTED_RESOURCE_METADATA_PATH,
): ApiError {
  return new ApiError(401, "E_UNAUTHORIZED", "authentication required", {
    reason,
    headers: { "WWW-Authenticate": wwwAuthenticateBearer(origin, resourceMetadataPath) },
  });
}

export interface ProtocolSseWriterOptions {
  readonly res: ServerResponse;
  readonly headers?: Record<string, string> | undefined;
  readonly heartbeatMs?: number | undefined;
  readonly onClose?: (() => void) | undefined;
}

export interface ProtocolSseEvent {
  readonly id?: string | undefined;
  readonly event?: string | undefined;
  readonly data: string | Record<string, unknown>;
  readonly retryMs?: number | undefined;
}

const sanitizeSseLine = (v: string): string => v.replace(/[\r\n]+/g, " ");

/** Server-Sent Events writer with socket backpressure (`drain`), periodic `: heartbeat` comments and abort-on-close. */
export class ProtocolSseWriter {
  readonly #res: ServerResponse;
  readonly #abort = new AbortController();
  readonly #onClose: (() => void) | undefined;
  #heartbeat: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(opts: ProtocolSseWriterOptions) {
    this.#res = opts.res;
    this.#onClose = opts.onClose;
    if (!this.#res.headersSent) {
      this.#res.writeHead(200, {
        ...(opts.headers ?? {}),
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      this.#res.flushHeaders?.();
    }
    const handleClose = (): void => {
      if (this.#closed) return;
      this.#closed = true;
      if (this.#heartbeat) {
        clearInterval(this.#heartbeat);
        this.#heartbeat = undefined;
      }
      this.#abort.abort();
      this.#onClose?.();
    };
    this.#res.once("close", handleClose);
    this.#res.once("error", handleClose);
    this.#res.socket?.once("close", handleClose);

    const intervalMs = opts.heartbeatMs ?? DEFAULT_PROTOCOL_HEARTBEAT_MS;
    if (intervalMs > 0) {
      this.#heartbeat = setInterval(() => {
        void this.writeComment("heartbeat");
      }, intervalMs);
      this.#heartbeat.unref?.();
    }
  }

  get closed(): boolean {
    return this.#closed || this.#res.writableEnded || this.#res.destroyed;
  }

  get signal(): AbortSignal {
    return this.#abort.signal;
  }

  async writeComment(comment: string): Promise<boolean> {
    return this.#writeRaw(`: ${sanitizeSseLine(comment)}\n\n`);
  }

  async writeEvent(event: ProtocolSseEvent): Promise<boolean> {
    const lines: string[] = [];
    if (event.id !== undefined) lines.push(`id: ${sanitizeSseLine(event.id)}`);
    if (event.event !== undefined) lines.push(`event: ${sanitizeSseLine(event.event)}`);
    if (event.retryMs !== undefined && Number.isInteger(event.retryMs) && event.retryMs >= 0) {
      lines.push(`retry: ${event.retryMs}`);
    }
    const rawData = typeof event.data === "string" ? event.data : JSON.stringify(event.data);
    for (const part of rawData.split(/\r?\n/)) {
      lines.push(`data: ${part}`);
    }
    return this.#writeRaw(`${lines.join("\n")}\n\n`);
  }

  async #writeRaw(frame: string): Promise<boolean> {
    if (this.closed) return false;
    let ok: boolean;
    try {
      ok = this.#res.write(frame);
    } catch {
      this.close();
      return false;
    }
    if (ok) return true;
    return new Promise<boolean>((resolve) => {
      const onDrain = (): void => {
        cleanup();
        resolve(!this.closed);
      };
      const onAbort = (): void => {
        cleanup();
        resolve(false);
      };
      const cleanup = (): void => {
        this.#res.off("drain", onDrain);
        this.#abort.signal.removeEventListener("abort", onAbort);
      };
      if (this.closed) {
        resolve(false);
        return;
      }
      this.#res.once("drain", onDrain);
      this.#abort.signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  close(): void {
    if (!this.#closed) {
      this.#closed = true;
      if (this.#heartbeat) {
        clearInterval(this.#heartbeat);
        this.#heartbeat = undefined;
      }
      this.#abort.abort();
      this.#onClose?.();
    }
    if (!this.#res.writableEnded && !this.#res.destroyed) {
      try {
        this.#res.end();
      } catch {
        /* ignore socket error on close */
      }
    }
  }
}
