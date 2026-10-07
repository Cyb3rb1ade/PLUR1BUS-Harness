import { request, type IncomingHttpHeaders } from "node:http";
import { FakeClock } from "../src/clock.ts";
import type { CoreRpc } from "../src/core-rpc.ts";
import type { LockoutPolicy } from "../src/login.ts";
import { MemoryUserDirectory } from "../src/memory-stores.ts";
import { hashPassword } from "../src/password.ts";
import { memoryAuditSink, type MemoryAuditSink } from "../src/rbac-bridge.ts";
import { createApiServer, type ApiLimits, type ApiServer, type ApiServerOptions } from "../src/server.ts";
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
  api: ApiServer; url: string; port: number; clock: FakeClock; core: FakeCore; logs: string[]; audit: MemoryAuditSink; users: MemoryUserDirectory; close(): Promise<void>;
}

export interface StartOptions {
  limits?: Partial<ApiLimits>; rateClasses?: RateClasses; sessionLimits?: SessionLimits; core?: FakeCore;
  users?: MemoryUserDirectory; lockout?: Partial<LockoutPolicy>; extraRoutes?: ApiServerOptions["extraRoutes"]; webRoot?: string;
}

export async function start(o: StartOptions = {}): Promise<Harness> {
  const clock = new FakeClock(); const core = o.core ?? fakeCore(); const logs: string[] = [];
  const audit = memoryAuditSink(); const users = o.users ?? new MemoryUserDirectory();
  const sink = (level: string) => (msg: string, fields?: Record<string, unknown>) => { logs.push(JSON.stringify({ level, msg, ...fields })); };
  const api = createApiServer({
    core, ownerToken: OWNER_TOKEN, clock, users, audit, logger: { debug: sink("debug"), info: sink("info"), warn: sink("warn"), error: sink("error") },
    ...(o.limits ? { limits: o.limits } : {}), ...(o.rateClasses ? { rateClasses: o.rateClasses } : {}), ...(o.sessionLimits ? { sessionLimits: o.sessionLimits } : {}),
    ...(o.lockout ? { lockout: o.lockout } : {}), ...(o.extraRoutes ? { extraRoutes: o.extraRoutes } : {}), ...(o.webRoot ? { webRoot: o.webRoot } : {}),
  });
  const { url, port } = await api.listen();
  return { api, url, port, clock, core, logs, audit, users, close: () => api.close() };
}

/** A made-up password; no fixture holds a real credential. */
export const FIXTURE_PASSWORD = "fixture-pass-not-a-real-secret";
export async function addUser(h: Harness, u: { id: string; username: string; role: "owner" | "admin" | "operator" | "member" | "viewer"; agentRights?: Record<string, "use" | "manage"> }) {
  return h.users.add({ ...u, passwordHash: await hashPassword(FIXTURE_PASSWORD) });
}
export async function loginAs(h: Harness, username: string, password = FIXTURE_PASSWORD): Promise<{ cookie: string; res: Res }> {
  const res = await raw(h, { method: "POST", path: "/api/v1/session", headers: jsonHeaders(), body: JSON.stringify({ username, password }) });
  const set = res.headers["set-cookie"]?.[0] ?? "";
  return { cookie: set.split(";", 1)[0]!, res };
}
/** One DELETE/POST with a fresh one-time CSRF token. */
export async function write(h: Harness, cookie: string, o: { method?: string; path: string; body?: unknown }): Promise<Res> {
  const t = await csrfToken(h, cookie);
  return raw(h, { method: o.method ?? "POST", path: o.path, headers: { cookie, "x-csrf-token": t, ...(o.body !== undefined ? jsonHeaders() : {}) }, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) });
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
