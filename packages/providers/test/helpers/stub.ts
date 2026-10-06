// A local HTTP stub for the adapter tests: real sockets on 127.0.0.1, no network beyond loopback.
import { createServer } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";

export interface Recorded {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface Stub {
  baseUrl: string;
  requests: Recorded[];
  /** Sockets still open on the server side. */
  openSockets(): number;
  /** Resolves when `req`'s connection has been closed by the peer (client cancelled or aborted). */
  close(): Promise<void>;
}

export type Handler = (req: IncomingMessage, res: ServerResponse, rec: Recorded) => void | Promise<void>;

export async function startStub(handler: Handler): Promise<Stub> {
  const requests: Recorded[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => {
      const rec: Recorded = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(parts).toString("utf8") };
      requests.push(rec);
      Promise.resolve(handler(req, res, rec)).catch(() => res.destroy());
    });
  });
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    openSockets: () => sockets.size,
    close: () => new Promise<void>((ok) => {
      for (const s of sockets) s.destroy();
      server.close(() => ok());
    }),
  };
}

/** Keeps a handler pending until the client goes away (no timer, so nothing outlives the test). */
export const hold = (res: ServerResponse) => new Promise<void>((ok) => { if (res.destroyed) ok(); else res.on("close", () => ok()); });

export const sleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

/** Polls until `cond()` holds or `ms` elapse; returns the last value. */
export async function until(cond: () => boolean, ms = 2000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await sleep(10); }
  return cond();
}

export function sseHeaders(res: ServerResponse, status = 200): void {
  res.writeHead(status, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
}

/** Splits `bytes` into `sizes`-shaped pieces (cycled); `0`-size entries are skipped. */
export function split(bytes: Buffer, sizes: number[]): Buffer[] {
  const out: Buffer[] = [];
  let i = 0, k = 0;
  while (i < bytes.length) {
    const n = Math.max(1, sizes[k++ % sizes.length] ?? 1);
    out.push(bytes.subarray(i, i + n));
    i += n;
  }
  return out;
}

export async function writeAll(res: ServerResponse, pieces: Buffer[], gapMs = 0): Promise<void> {
  for (const p of pieces) {
    if (res.destroyed) return;
    await new Promise<void>((ok) => res.write(p, () => ok()));
    if (gapMs > 0) await sleep(gapMs);
  }
}

export const credentials = (value: string | undefined = "Bearer synthetic-secret-token-123") => ({ authorization: () => value });

export const basicRequest = { model: "synthetic-model-1", messages: [{ role: "user" as const, content: "hi" }] };
