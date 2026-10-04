// A loopback-only fake HTTP endpoint for discovery tests (plan Task 3). Synthetic answers, never a real provider (R19).
import { createServer } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeRequest { method: string; url: string; headers: IncomingHttpHeaders }
export interface FakeReply { status?: number; headers?: Record<string, string>; json?: unknown; body?: Buffer; stall?: boolean }
export interface FakeEndpoint { origin: string; port: number; requests: { url: string; headers: IncomingHttpHeaders }[]; close(): Promise<void> }

export async function startFakeEndpoint(handler: (req: FakeRequest) => FakeReply): Promise<FakeEndpoint> {
  const requests: { url: string; headers: IncomingHttpHeaders }[] = [];
  const server = createServer((req, res) => {
    const r: FakeRequest = { method: req.method ?? "GET", url: req.url ?? "/", headers: req.headers };
    requests.push({ url: r.url, headers: r.headers });
    const reply = handler(r);
    if (reply.stall) return; // never answers; close() tears the socket down
    const headers: Record<string, string> = { ...reply.headers };
    let body: Buffer | undefined = reply.body;
    if (reply.json !== undefined) {
      body = Buffer.from(JSON.stringify(reply.json));
      if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) headers["Content-Type"] = "application/json";
    }
    res.writeHead(reply.status ?? 200, headers);
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`, port, requests,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
