// A mock Harness API for the web UI tests: the built static files under the strict CSP of ADR-004, plus the provisional
// /api/v1/auth routes of src/session.ts. Local only (127.0.0.1, ephemeral port); never reaches a real harness.
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";

export const STRICT_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

export type MockUser = { password: string; displayName: string; role: string };
export type MockOptions = {
  distDir: string;
  users?: Record<string, MockUser>;
  /** Consecutive failed logins before the mock answers 429. */
  maxFailures?: number;
  retryAfterSeconds?: number;
};
export type LoggedRequest = { method: string; url: string; csrf: string | null; hasCookie: boolean };

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };

export class MockHarnessServer {
  readonly requests: LoggedRequest[] = [];
  readonly sessions = new Map<string, { userId: string; csrf: string }>();
  failures = 0;
  /** When set, every /api/v1 route answers with this status (e.g. 503). */
  forceStatus: number | null = null;
  #server: Server | undefined;
  readonly #opts: Required<MockOptions>;

  constructor(opts: MockOptions) {
    this.#opts = {
      users: { alice: { password: "correct horse battery", displayName: "Alice", role: "owner" } },
      maxFailures: 5,
      retryAfterSeconds: 30,
      ...opts,
    };
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

  #sessionOf(req: IncomingMessage): { id: string; userId: string; csrf: string } | null {
    const m = /(?:^|;\s*)p1_session=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? "");
    const id = m?.[1];
    const s = id ? this.sessions.get(id) : undefined;
    return id && s ? { id, ...s } : null;
  }

  #json(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...extra });
    res.end(JSON.stringify(body));
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = (req.url ?? "/").split("?")[0] ?? "/";
    const csrfHeader = req.headers["x-csrf-token"];
    this.requests.push({ method: req.method ?? "GET", url: req.url ?? "/", csrf: typeof csrfHeader === "string" ? csrfHeader : null, hasCookie: !!req.headers.cookie });
    res.setHeader("content-security-policy", STRICT_CSP);
    res.setHeader("x-content-type-options", "nosniff");

    if (url.startsWith("/api/v1/")) {
      if (this.forceStatus !== null) return this.#json(res, this.forceStatus, { error: { code: "E_UNAVAILABLE" } });
      return this.#api(req, res, url);
    }
    const name = url === "/" ? "index.html" : url.slice(1);
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) { res.writeHead(404).end(); return; }
    try {
      const body = await readFile(join(this.#opts.distDir, name));
      const ext = name.slice(name.lastIndexOf("."));
      res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": "no-store" });
      res.end(body);
    } catch { res.writeHead(404).end(); }
  }

  async #readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return null; }
  }

  async #api(req: IncomingMessage, res: ServerResponse, url: string): Promise<void> {
    if (url === "/api/v1/auth/whoami" && req.method === "GET") {
      const s = this.#sessionOf(req);
      if (!s) return this.#json(res, 401, { error: { code: "E_AUTH", reason: "no-session" } });
      const u = this.#opts.users[s.userId];
      return this.#json(res, 200, { userId: s.userId, displayName: u?.displayName ?? s.userId, role: u?.role ?? "member", csrf: s.csrf });
    }
    if (url === "/api/v1/auth/login" && req.method === "POST") {
      if (this.failures >= this.#opts.maxFailures) {
        return this.#json(res, 429, { error: { code: "E_RATE" } }, { "retry-after": String(this.#opts.retryAfterSeconds) });
      }
      const body = (await this.#readBody(req)) as { username?: unknown; password?: unknown } | null;
      const u = typeof body?.username === "string" ? this.#opts.users[body.username] : undefined;
      if (!u || body?.password !== u.password) {
        this.failures += 1;
        return this.#json(res, 401, { error: { code: "E_AUTH", reason: "invalid-credentials" } });
      }
      this.failures = 0;
      const id = randomBytes(24).toString("base64url");
      const csrf = randomBytes(16).toString("base64url");
      this.sessions.set(id, { userId: body!.username as string, csrf });
      return this.#json(res, 200, { userId: body!.username, displayName: u.displayName, role: u.role, csrf },
        { "set-cookie": `p1_session=${id}; HttpOnly; SameSite=Lax; Path=/` });
    }
    if (url === "/api/v1/auth/logout" && req.method === "POST") {
      const s = this.#sessionOf(req);
      if (!s) return this.#json(res, 401, { error: { code: "E_AUTH", reason: "no-session" } });
      if (req.headers["x-csrf-token"] !== s.csrf) return this.#json(res, 403, { error: { code: "E_CSRF" } });
      this.sessions.delete(s.id);
      res.writeHead(204, { "set-cookie": "p1_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" });
      res.end();
      return;
    }
    this.#json(res, 404, { error: { code: "E_NOT_FOUND" } });
  }
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
