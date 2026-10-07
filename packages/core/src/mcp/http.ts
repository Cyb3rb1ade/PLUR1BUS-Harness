// A streaming FetchLike for the SDK. Every connection uses the IP returned by the existing egress service.
import http from "node:http";
import https from "node:https";
import { Readable, Transform } from "node:stream";
import { createEgress, type Egress } from "../egress/index.ts";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { MAX_FRAME_BYTES } from "./stdio.ts";

export interface McpHttpOptions { egress?: Pick<Egress, "decide">; maxFrameBytes?: number }

/** With no host port supplied, only literal localhost endpoints are eligible. Remote access fails closed. */
export function createMcpFetch(o: McpHttpOptions = {}): FetchLike {
  return async (raw, init = {}) => {
    const url = new URL(raw);
    if (url.username || url.password || url.hash) throw new Error("MCP URL credentials and fragments are forbidden");
    const egress = o.egress ?? createEgress({ config: () => ({ allowHosts: ["127.0.0.1", "[::1]", "localhost"], allowPorts: [Number(url.port || (url.protocol === "https:" ? 443 : 80))], allowLoopback: true }) });
    const pin = await egress.decide(url.toString());
    if (!pin.allowed) throw new Error(`MCP egress denied (${pin.reason})`);
    if (init.signal?.aborted) throw new Error("MCP HTTP aborted");
    const method = init.method ?? "GET";
    if (!["GET", "POST", "DELETE"].includes(method)) throw new Error("MCP HTTP method refused");
    if (init.body !== undefined && init.body !== null && typeof init.body !== "string" && !(init.body instanceof URLSearchParams)) throw new Error("MCP HTTP body must be text");
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => { headers[key] = value; });
    // Credentials go only to the chosen endpoint; redirects are returned to the caller for a fresh gated request.
    delete headers.host;
    const body = init.body == null ? undefined : init.body.toString();
    const max = o.maxFrameBytes ?? MAX_FRAME_BYTES;
    if (body !== undefined && Buffer.byteLength(body) > max) throw new Error("MCP HTTP body exceeds byte limit");
    return await new Promise<Response>((resolve, reject) => {
      const host = url.hostname.replace(/^\[|\]$/g, "");
      const request = (url.protocol === "https:" ? https : http).request({
        hostname: host, port: url.port || undefined, path: url.pathname + url.search, method, headers,
        agent: false, ...(init.signal ? { signal: init.signal } : {}),
        lookup: ((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
          if (options.all) callback(null, [{ address: pin.address, family: pin.family }]);
          else callback(null, pin.address, pin.family);
        }) as never,
      }, response => {
        const status = response.statusCode ?? 500;
        const h = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) for (const item of value) h.append(key, item);
          else if (value !== undefined) h.set(key, value);
        }
        if ([204, 205, 304].includes(status) || method === "DELETE" && status === 202) {
          response.resume(); resolve(new Response(null, { status, headers: h })); return;
        }
        const sse = h.get("content-type")?.includes("text/event-stream") ?? false;
        let frameBytes = 0;
        const bounded = new Transform({ transform(chunk: Buffer, _encoding, done) {
          if (sse) {
            // Each complete SSE event is bounded, including a data field split over multiple lines.
            for (const byte of chunk) {
              if (++frameBytes > max) { done(new Error("MCP HTTP frame exceeds byte limit")); return; }
              // Reset only at an empty line, not at an arbitrary data line.
              if (byte === 10 && previous === 10) frameBytes = 0;
              if (byte !== 13) previous = byte;
            }
          } else {
            frameBytes += chunk.length;
            if (frameBytes > max) { done(new Error("MCP HTTP body exceeds byte limit")); return; }
          }
          done(null, chunk);
        } });
        let previous = -1;
        response.on("error", () => bounded.destroy(new Error("MCP HTTP response interrupted")));
        bounded.on("error", () => response.destroy());
        bounded.on("close", () => { response.destroy(); request.destroy(); });
        response.pipe(bounded);
        resolve(new Response(Readable.toWeb(bounded) as ReadableStream<Uint8Array>, { status, headers: h }));
      });
      request.on("error", () => reject(new Error("MCP HTTP connection failed")));
      request.end(body);
    });
  };
}
