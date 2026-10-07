// Local stub servers for the web tool tests. Nothing here leaves loopback.
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Resolver } from "../../../src/tools/web/guard.ts";

export interface Stub {
  port: number;
  host: string;
  hits: Array<{ url: string; headers: http.IncomingHttpHeaders }>;
  close(): Promise<void>;
}

export async function startStub(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  host = "127.0.0.1",
  port = 0,
): Promise<Stub> {
  const hits: Stub["hits"] = [];
  const server = http.createServer((req, res) => {
    hits.push({ url: req.url ?? "", headers: req.headers });
    handler(req, res);
  });
  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return {
    port: (server.address() as AddressInfo).port,
    host,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

/** A resolver backed by a map; counts its calls and throws for unknown names like a real NXDOMAIN. */
export function stubResolver(map: Record<string, string[]>): Resolver & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (host: string) => {
    calls.push(host);
    const a = map[host];
    if (!a) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    return a.map((address) => ({ address, family: (address.includes(":") ? 6 : 4) as 4 | 6 }));
  }) as Resolver & { calls: string[] };
  fn.calls = calls;
  return fn;
}

export const never: Resolver = async () => {
  throw new Error("resolver must not be called");
};
