// A mock Harness API for the web UI tests: the built static files under the strict CSP of ADR-004, plus the provisional
// /api/v1 session routes of src/session.ts. Local only (127.0.0.1, ephemeral port); never reaches a real harness.
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { MockEvents, MockRpc } from "./mock-rpc.ts";

export const STRICT_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

export const OWNER_TOKEN = "t0ken-0123456789abcdef0123456789abcdef-owner";
export const COOKIE = "plur1bus_session";
export type MockOptions = {
  distDir: string;
  /** The owner token the mock accepts (the real one is `run/api-owner.token`; this one is a fixture). */
  token?: string;
  /** Consecutive failed logins before the mock answers 429. */
  maxFailures?: number;
  retryAfterSeconds?: number;
};
export type LoggedRequest = { method: string; url: string; csrf: string | null; hasCookie: boolean; body: string };
/** A route extension (see mock-rpc.ts): answers the request and returns true, or returns false to let the mock go on. */
export type MockExtension = (req: IncomingMessage, res: ServerResponse, path: string, body: string) => boolean | Promise<boolean>;

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };

export class MockHarnessServer {
  readonly requests: LoggedRequest[] = [];
  /** Live sessions by cookie value; `csrf` holds the one-time tokens issued and not yet used. */
  readonly sessions = new Map<string, { csrf: Set<string> }>();
  failures = 0;
  /** When set, every /api/v1 route answers with this status (e.g. 503). */
  forceStatus: number | null = null;
  /** When true, the next write refuses its CSRF token (even a fresh one) once more; counts down per refusal. */
  rejectCsrf = 0;
  /** Extra routes tried before the built-in ones; mock-rpc.ts installs /rpc and /events here. */
  readonly extensions: MockExtension[] = [];
  /** JSON-RPC on `/rpc` (scenarios per method). Off the wire until a test enables it, like the real backend today. */
  readonly rpc: MockRpc;
  /** SSE on `/events` (push events, drop connections, watch reconnects). */
  readonly events: MockEvents;
  #server: Server | undefined;
  readonly #opts: Required<MockOptions>;

  constructor(opts: MockOptions) {
    this.#opts = { token: OWNER_TOKEN, maxFailures: 5, retryAfterSeconds: 30, ...opts };
    this.rpc = new MockRpc(this);
    this.events = new MockEvents(this);
    this.extensions.push((req, res, path, body) => this.rpc.serve(req, res, path, body), (req, res, path) => this.events.serve(req, res, path));
  }

  async start(): Promise<string> {
    this.#server = createServer((req, res) => { void this.#handle(req, res); });
    await new Promise<void>((resolve) => this.#server!.listen(0, "127.0.0.1", resolve));
    const a = this.#server.address();
    if (!a || typeof a === "string") throw new Error("mock server has no address");
    return `http://127.0.0.1:${a.port}`;
  }

  async stop(): Promise<void> {
    this.#server?.closeAllConnections();
    await new Promise<void>((resolve) => this.#server?.close(() => resolve()) ?? resolve());
  }

  /** The live session behind the request's cookie, or null. */
  sessionOf(req: IncomingMessage): { id: string; csrf: Set<string> } | null {
    const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]+)`).exec(req.headers.cookie ?? "");
    const id = m?.[1];
    const s = id ? this.sessions.get(id) : undefined;
    return id && s ? { id, csrf: s.csrf } : null;
  }

  #json(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...extra });
    res.end(JSON.stringify(body));
  }

  #error(res: ServerResponse, status: number, error: string, reason: string, extra: Record<string, string> = {}): void {
    this.#json(res, status, { schema: "error/1", error, message: reason, reason }, extra);
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = (req.url ?? "/").split("?")[0] ?? "/";
    const body = url.startsWith("/api/v1/") || url === "/rpc" ? await this.#readBody(req) : "";
    const csrfHeader = req.headers["x-csrf-token"];
    this.requests.push({ method: req.method ?? "GET", url: req.url ?? "/", csrf: typeof csrfHeader === "string" ? csrfHeader : null, hasCookie: !!req.headers.cookie, body });
    res.setHeader("content-security-policy", STRICT_CSP);
    res.setHeader("x-content-type-options", "nosniff");

    for (const ext of this.extensions) if (await ext(req, res, url, body)) return;
    if (url.startsWith("/api/v1/")) {
      if (this.forceStatus !== null) return this.#error(res, this.forceStatus, "E_CORE_UNAVAILABLE", "unavailable");
      return this.#api(req, res, url, body);
    }
    const name = url === "/" ? "index.html" : url.slice(1);
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) { res.writeHead(404).end(); return; }
    try {
      const file = await readFile(join(this.#opts.distDir, name));
      const ext = name.slice(name.lastIndexOf("."));
      res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": "no-store" });
      res.end(file);
    } catch { res.writeHead(404).end(); }
  }

  async #readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  }

  #api(req: IncomingMessage, res: ServerResponse, url: string, raw: string): void {
    const principal = { kind: "owner", id: "owner", role: "owner" };
    const times = { createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-01T12:00:00.000Z", idleExpiresAt: "2026-01-01T00:30:00.000Z" };
    if (url === "/api/v1/session" && req.method === "POST") {
      if (this.failures >= this.#opts.maxFailures) return this.#error(res, 429, "E_DENIED", "rate-limited", { "retry-after": String(this.#opts.retryAfterSeconds) });
      let parsed: { token?: unknown } | null = null;
      try { parsed = JSON.parse(raw) as { token?: unknown }; } catch { /* handled below */ }
      if (!parsed || typeof parsed.token !== "string") return this.#error(res, 400, "E_INVALID_PARAMS", "body");
      if (parsed.token !== this.#opts.token) { this.failures += 1; return this.#error(res, 401, "E_UNAUTHORIZED", "invalid-token"); }
      this.failures = 0;
      const id = randomBytes(24).toString("base64url");
      this.sessions.set(id, { csrf: new Set() });
      return this.#json(res, 200, { schema: "session.create/1", principal, ...times },
        { "set-cookie": `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200` });
    }
    const s = this.sessionOf(req);
    if (!s) return this.#error(res, 401, "E_UNAUTHORIZED", "no-session");
    if (url === "/api/v1/whoami" && req.method === "GET") return this.#json(res, 200, { schema: "whoami/1", principal, session: times });
    if (url === "/api/v1/csrf" && req.method === "GET") {
      const token = randomBytes(16).toString("base64url");
      s.csrf.add(token);
      return this.#json(res, 200, { schema: "csrf/1", token, expiresAt: times.expiresAt });
    }
    if (url === "/api/v1/session" && req.method === "DELETE") {
      const t = req.headers["x-csrf-token"];
      const ok = typeof t === "string" && s.csrf.delete(t) && this.rejectCsrf === 0;
      if (this.rejectCsrf > 0) this.rejectCsrf -= 1;
      if (!ok) return this.#error(res, 403, "E_DENIED", "csrf");
      this.sessions.delete(s.id);
      return this.#json(res, 200, { schema: "session.delete/1", ok: true }, { "set-cookie": `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` });
    }
    this.#error(res, 404, "E_NOT_FOUND", "route");
  }

  /** Test hook: forget every session server-side, as an idle or absolute expiry would. */
  expireAll(): void { this.sessions.clear(); }
}
/** A fetch that keeps cookies (Node's fetch has no jar), so the HTTP client can be tested without a browser. */
export function cookieFetch(): typeof fetch {
  const jar = new Map<string, string>();
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    if (jar.size > 0) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await fetch(input, { ...init, headers });
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(";");
      const [k, v] = (pair ?? "").split("=");
      if (!k) continue;
      if (attrs.some((a) => /^\s*max-age=0/i.test(a)) || v === "") jar.delete(k.trim()); else jar.set(k.trim(), v ?? "");
    }
    return res;
  };
}
