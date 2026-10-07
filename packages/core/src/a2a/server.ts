// node:http adapter for the A2A handler. Loopback only (ADR-008: TLS-only exposure beyond loopback is a later slice):
// any other bind address is refused, the Host header must be one we listen on (DNS-rebinding guard), and the body cap
// is enforced while the body streams in, not after it is buffered.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { BodyTooLarge, createA2aHandler, type A2aHandler, type A2aHandlerOptions, type A2aHttpRequest } from "./handler.ts";

export function loopbackAddress(host: string): string {
  if (host === "localhost") return "127.0.0.1";
  const family = isIP(host);
  if ((family === 4 && host.startsWith("127.")) || (family === 6 && host === "::1")) return host;
  throw new Error(`the A2A server binds loopback only; refusing ${JSON.stringify(host)}`);
}

export interface A2aServerOptions extends Omit<A2aHandlerOptions, "advertisedBaseUrl"> {
  host?: string; port?: number;
  /** Overrides the card URL's base; default is the address actually bound. */
  advertisedBaseUrl?: string;
}
export interface A2aServer { listen(): Promise<{ host: string; port: number; url: string }>; close(): Promise<void>; readonly server: Server; readonly handler: A2aHandler | undefined }

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0; let done = false;
    req.on("data", (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > limit) { done = true; reject(new BodyTooLarge()); return; }
      chunks.push(c);
    });
    req.on("end", () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on("error", (e) => { if (!done) { done = true; reject(e); } });
    req.on("aborted", () => { if (!done) { done = true; reject(new Error("aborted")); } });
  });
}

export function createA2aServer(o: A2aServerOptions): A2aServer {
  const bindHost = loopbackAddress(o.host ?? "127.0.0.1");
  let allowedHosts = new Set<string>();
  let handler: A2aHandler | undefined;
  let base = o.advertisedBaseUrl;
  const send = (res: ServerResponse, status: number, headers: Record<string, string>, body: string): void => {
    if (res.headersSent) { res.end(); return; }
    const payload = Buffer.from(body, "utf8");
    res.writeHead(status, { ...headers, "Content-Length": payload.length });
    res.end(payload);
  };
  const server = createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 30_000, headersTimeout: 10_000 }, (req, res) => {
    void (async () => {
      try {
        const host = req.headers.host?.toLowerCase();
        const target = req.url ?? "";
        if (!handler || !host || !allowedHosts.has(host) || !target.startsWith("/")) { send(res, 421, { "Content-Type": "application/json" }, '{"error":"misdirected"}'); return; }
        const h: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(req.headers)) h[k] = Array.isArray(v) ? v.join(", ") : v;
        const areq: A2aHttpRequest = {
          method: req.method ?? "", path: target.split("?", 1)[0]!, headers: h,
          remote: (req.socket.remoteAddress ?? "unknown").replace(/^::ffff:/, ""), readBody: (limit) => readBody(req, limit),
        };
        const r = await handler.handle(areq);
        if (r.status === 413) req.resume();
        send(res, r.status, r.headers, r.body);
      } catch { send(res, 500, { "Content-Type": "application/json" }, '{"error":"internal"}'); }
    })();
  });
  server.maxConnections = 64;
  return {
    server,
    get handler() { return handler; },
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(o.port ?? 0, bindHost, () => {
          server.off("error", reject);
          const a = server.address(); if (!a || typeof a === "string") { reject(new Error("no address")); return; }
          const hostPart = bindHost.includes(":") ? `[${bindHost}]` : bindHost;
          allowedHosts = new Set([hostPart, "localhost", "127.0.0.1", "[::1]"].map((n) => `${n}:${a.port}`));
          const url = `http://${hostPart}:${a.port}`;
          base ??= url;
          const { host: _h, port: _p, advertisedBaseUrl: _b, ...rest } = o;
          handler = createA2aHandler({ ...rest, advertisedBaseUrl: base });
          resolve({ host: bindHost, port: a.port, url });
        });
      });
    },
    close() { return new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); },
  };
}
