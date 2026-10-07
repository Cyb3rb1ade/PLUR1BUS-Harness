import { signal } from "@preact/signals";

// The Harness API's session surface (packages/api, docs/api-surface.md): the owner token is exchanged once for an
// HttpOnly cookie; every write then needs a one-time CSRF token from GET /api/v1/csrf in X-CSRF-Token.
export const SESSION_ROUTES = {
  whoami: "/api/v1/whoami",
  session: "/api/v1/session",
  csrf: "/api/v1/csrf",
} as const;
export const CSRF_HEADER = "x-csrf-token";

export type SessionUser = { id: string; role: string };
export type LoginFailure =
  | { kind: "invalid-token" }
  | { kind: "rate-limited"; retryAfterSeconds: number | null }
  | { kind: "network" }
  | { kind: "server"; status: number };
export type LoginResult = { ok: true; user: SessionUser } | { ok: false; failure: LoginFailure };
export type WriteFailure =
  | { kind: "session-expired" }
  | { kind: "csrf" }
  | { kind: "rate-limited"; retryAfterSeconds: number | null }
  | { kind: "network" }
  | { kind: "server"; status: number };
export type WriteResult = { ok: true; status: number; body: unknown } | { ok: false; failure: WriteFailure };
export type WriteMethod = "POST" | "PUT" | "PATCH" | "DELETE";

/** The only session surface UI code uses; the HTTP client and any test double implement it. */
export interface SessionApi {
  /** The signed-in user, or null when there is no valid session. Rejects only on a network or server failure. */
  whoami(): Promise<SessionUser | null>;
  /** Exchanges the owner token for a session cookie. The token is held in no field and sent nowhere but this body. */
  login(credentials: { token: string }): Promise<LoginResult>;
  /** A mutating request: fetches a fresh one-time CSRF token first and sends it (retrying once if it is refused). */
  write(method: WriteMethod, path: string, body?: unknown): Promise<WriteResult>;
  /** Ends the session; never rejects (the local state is cleared either way). */
  logout(): Promise<void>;
}

function asUser(v: unknown): SessionUser | null {
  const p = typeof v === "object" && v !== null ? (v as { principal?: unknown }).principal : undefined;
  if (typeof p !== "object" || p === null) return null;
  const o = p as Record<string, unknown>;
  if (typeof o.id !== "string" || typeof o.role !== "string") return null;
  return { id: o.id, role: o.role };
}

function retryAfter(res: Response): number | null {
  const n = Number(res.headers.get("retry-after"));
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : null;
}

async function reasonOf(res: Response): Promise<string | undefined> {
  try { const b = (await res.json()) as { reason?: unknown }; return typeof b.reason === "string" ? b.reason : undefined; } catch { return undefined; }
}

export class HttpSessionApi implements SessionApi {
  readonly #base: string;
  readonly #fetch: typeof fetch;

  constructor(base = "", fetchImpl: typeof fetch = (...a) => globalThis.fetch(...a)) {
    this.#base = base;
    this.#fetch = fetchImpl;
  }

  async whoami(): Promise<SessionUser | null> {
    const res = await this.#fetch(this.#base + SESSION_ROUTES.whoami, { credentials: "same-origin", headers: { accept: "application/json" } });
    if (res.status === 401) return null;
    if (!res.ok) throw new Error(`whoami ${res.status}`);
    const user = asUser(await res.json());
    if (!user) throw new Error("whoami: unexpected body");
    return user;
  }

  async login(c: { token: string }): Promise<LoginResult> {
    let res: Response;
    try {
      res = await this.#fetch(this.#base + SESSION_ROUTES.session, {
        method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ token: c.token }),
      });
    } catch {
      return { ok: false, failure: { kind: "network" } };
    }
    if (res.status === 401) return { ok: false, failure: { kind: "invalid-token" } };
    if (res.status === 429) return { ok: false, failure: { kind: "rate-limited", retryAfterSeconds: retryAfter(res) } };
    if (!res.ok) return { ok: false, failure: { kind: "server", status: res.status } };
    let body: unknown;
    try { body = await res.json(); } catch { return { ok: false, failure: { kind: "server", status: res.status } }; }
    const user = asUser(body);
    return user ? { ok: true, user } : { ok: false, failure: { kind: "server", status: res.status } };
  }

  /** One-time token (GET /api/v1/csrf); a failure is already a WriteFailure. */
  async #csrf(): Promise<{ token: string } | { failure: WriteFailure }> {
    let res: Response;
    try { res = await this.#fetch(this.#base + SESSION_ROUTES.csrf, { credentials: "same-origin", headers: { accept: "application/json" } }); }
    catch { return { failure: { kind: "network" } }; }
    if (res.status === 401) return { failure: { kind: "session-expired" } };
    if (res.status === 429) return { failure: { kind: "rate-limited", retryAfterSeconds: retryAfter(res) } };
    if (!res.ok) return { failure: { kind: "server", status: res.status } };
    try {
      const t = ((await res.json()) as { token?: unknown }).token;
      if (typeof t === "string" && t !== "") return { token: t };
    } catch { /* falls through */ }
    return { failure: { kind: "server", status: res.status } };
  }

  async write(method: WriteMethod, path: string, body?: unknown): Promise<WriteResult> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const c = await this.#csrf();
      if ("failure" in c) return { ok: false, failure: c.failure };
      let res: Response;
      try {
        res = await this.#fetch(this.#base + path, {
          method, credentials: "same-origin",
          headers: { accept: "application/json", [CSRF_HEADER]: c.token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch { return { ok: false, failure: { kind: "network" } }; }
      if (res.status === 401) return { ok: false, failure: { kind: "session-expired" } };
      if (res.status === 403 && (await reasonOf(res)) === "csrf") { if (attempt === 0) continue; return { ok: false, failure: { kind: "csrf" } }; }
      if (res.status === 429) return { ok: false, failure: { kind: "rate-limited", retryAfterSeconds: retryAfter(res) } };
      if (!res.ok) return { ok: false, failure: { kind: "server", status: res.status } };
      let parsed: unknown = null;
      try { parsed = await res.json(); } catch { /* an empty body is fine */ }
      return { ok: true, status: res.status, body: parsed };
    }
    return { ok: false, failure: { kind: "csrf" } };
  }

  async logout(): Promise<void> {
    try { await this.write("DELETE", SESSION_ROUTES.session); } catch { /* the local state is cleared regardless */ }
  }
}

export type SessionState =
  | { status: "checking" }
  | { status: "anonymous" }
  | { status: "authenticated"; user: SessionUser };

/** Why the user is signed out again, shown once on the sign-in page. */
export const sessionNotice = signal<"expired" | null>(null);

export const sessionState = signal<SessionState>({ status: "checking" });

let api: SessionApi = new HttpSessionApi();
export function configureSession(next: SessionApi): void { api = next; }

export async function initSession(): Promise<void> {
  try {
    const user = await api.whoami();
    sessionState.value = user ? { status: "authenticated", user } : { status: "anonymous" };
  } catch {
    sessionState.value = { status: "anonymous" };
  }
}

export async function signIn(token: string): Promise<LoginResult> {
  const result = await api.login({ token });
  if (result.ok) { sessionNotice.value = null; sessionState.value = { status: "authenticated", user: result.user }; }
  return result;
}

/** A mutating request through the session: an expired session signs the UI out with a notice. */
export async function sessionWrite(method: WriteMethod, path: string, body?: unknown): Promise<WriteResult> {
  const result = await api.write(method, path, body);
  if (!result.ok && result.failure.kind === "session-expired") {
    sessionNotice.value = "expired";
    sessionState.value = { status: "anonymous" };
  }
  return result;
}

export async function signOut(): Promise<void> {
  await api.logout();
  sessionNotice.value = null;
  sessionState.value = { status: "anonymous" };
}
