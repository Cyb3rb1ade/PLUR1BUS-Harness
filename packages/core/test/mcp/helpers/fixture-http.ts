// A loopback-only Streamable HTTP host for the fixture server: one Server + transport per MCP session.
import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createFixtureServer, type FixtureState } from "./fixture-server.ts";

export interface FixtureHttp {
  url: string;
  states: FixtureState[];
  /** Headers of the most recent request, lower-cased. */
  lastHeaders: () => IncomingMessage["headers"];
  sessions: () => number;
  close(): Promise<void>;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw === "" ? undefined : JSON.parse(raw);
}

export async function startFixtureHttp(): Promise<FixtureHttp> {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const states: FixtureState[] = [];
  let last: IncomingMessage["headers"] = {};
  const http: HttpServer = createServer(async (req, res) => {
    last = req.headers;
    try {
      const sid = req.headers["mcp-session-id"] as string | undefined;
      const body = req.method === "POST" ? await readJson(req) : undefined;
      let transport = sid ? transports.get(sid) : undefined;
      if (!transport && !sid && req.method === "POST" && isInitializeRequest(body)) {
        const { server, state } = createFixtureServer();
        states.push(state);
        const t: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => { transports.set(id, t); },
        });
        t.onclose = () => { if (t.sessionId) transports.delete(t.sessionId); };
        await server.connect(t);
        transport = t;
      }
      if (!transport) { res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "no session" }, id: null })); return; }
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500).end(String(e));
    }
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const port = (http.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`, states, lastHeaders: () => last, sessions: () => transports.size,
    close: async () => { http.closeAllConnections(); await new Promise<void>((r) => http.close(() => r())); },
  };
}
