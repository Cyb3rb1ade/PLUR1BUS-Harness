import { request, type IncomingHttpHeaders } from "node:http";
import { FakeClock } from "../src/clock.ts";
import type { CoreRpc } from "../src/core-rpc.ts";
import { createApiServer, type ApiLimits, type ApiServer } from "../src/server.ts";
import type { RateClasses } from "../src/rate-limit.ts";
import type { SessionLimits } from "../src/session.ts";

export const OWNER_TOKEN = "0123456789abcdef".repeat(4);

export interface FakeCore extends CoreRpc { calls: Array<{ method: string; params?: object }>; impl: (method: string, params?: object) => Promise<unknown> }
export function fakeCore(): FakeCore {
  const core: FakeCore = {
    calls: [],
    impl: async (method) => {
      if (method === "agent.list") return { agents: [{ agentId: "main", open: true, activity: { state: "idle", since: 1 } }] };
      if (method === "core.status") return { process: "ready", contract: "7.18.4", rpc: "1.5.0", instanceId: "i", pid: 1, uptimeMs: 1234, engine: { ready: true, degraded: null }, agents: [] };
      throw new Error(`unexpected ${method}`);
    },
    call: ((method: string, params?: object) => { core.calls.push({ method, ...(params ? { params } : {}) }); return core.impl(method, params); }) as CoreRpc["call"],
  };
  return core;
}

export interface Harness {
  api: ApiServer; url: string; port: number; clock: FakeClock; core: FakeCore; logs: string[]; close(): Promise<void>;
}

export async function start(o: { limits?: Partial<ApiLimits>; rateClasses?: RateClasses; sessionLimits?: SessionLimits; core?: FakeCore } = {}): Promise<Harness> {
  const clock = new FakeClock(); const core = o.core ?? fakeCore(); const logs: string[] = [];
  const sink = (level: string) => (msg: string, fields?: Record<string, unknown>) => { logs.push(JSON.stringify({ level, msg, ...fields })); };
  const api = createApiServer({
    core, ownerToken: OWNER_TOKEN, clock, logger: { debug: sink("debug"), info: sink("info"), warn: sink("warn"), error: sink("error") },
    ...(o.limits ? { limits: o.limits } : {}), ...(o.rateClasses ? { rateClasses: o.rateClasses } : {}), ...(o.sessionLimits ? { sessionLimits: o.sessionLimits } : {}),
  });
  const { url, port } = await api.listen();
  return { api, url, port, clock, core, logs, close: () => api.close() };
}

export interface Res { status: number; headers: IncomingHttpHeaders; text: string; json: any }

/** One request over a plain socket; the `Host` header is the server's own unless a test overrides it. */
export function raw(h: Harness, o: { method?: string; path: string; headers?: Record<string, string>; body?: string | Buffer }): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: h.port, method: o.method ?? "GET", path: o.path, headers: o.headers ?? {}, agent: false, timeout: 5000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { const text = Buffer.concat(chunks).toString("utf8"); let json: any; try { json = JSON.parse(text); } catch { json = undefined; } resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json }); });
    });
    req.on("timeout", () => req.destroy(new Error("test client timeout")));
    req.on("error", reject);
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}

const jsonHeaders = (extra: Record<string, string> = {}) => ({ "content-type": "application/json", ...extra });

export async function login(h: Harness, token = OWNER_TOKEN): Promise<{ cookie: string; res: Res }> {
  const res = await raw(h, { method: "POST", path: "/api/v1/session", headers: jsonHeaders(), body: JSON.stringify({ token }) });
  const set = res.headers["set-cookie"]?.[0] ?? "";
  return { cookie: set.split(";", 1)[0]!, res };
}

export async function csrfToken(h: Harness, cookie: string): Promise<string> {
  const r = await raw(h, { path: "/api/v1/csrf", headers: { cookie } });
  return r.json.token as string;
}
export { jsonHeaders };
