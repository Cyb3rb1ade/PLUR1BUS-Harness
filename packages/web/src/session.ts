import { signal } from "@preact/signals";

// Provisional routes (the real Harness API is built in parallel); everything the UI knows about them is here.
export const SESSION_ROUTES = {
  whoami: "/api/v1/auth/whoami",
  login: "/api/v1/auth/login",
  logout: "/api/v1/auth/logout",
} as const;

export type SessionUser = { userId: string; displayName: string; role: string };
export type LoginFailure =
  | { kind: "invalid-credentials" }
  | { kind: "rate-limited"; retryAfterSeconds: number | null }
  | { kind: "network" }
  | { kind: "server"; status: number };
export type LoginResult = { ok: true; user: SessionUser } | { ok: false; failure: LoginFailure };

/** The only session surface UI code uses; the HTTP client and any test double implement it. */
export interface SessionApi {
  /** The signed-in user, or null when there is no valid session. Rejects only on a network or server failure. */
  whoami(): Promise<SessionUser | null>;
  login(credentials: { username: string; password: string }): Promise<LoginResult>;
  /** Ends the session; never rejects (the local state is cleared either way). */
  logout(): Promise<void>;
}

function asUser(v: unknown): SessionUser | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.userId !== "string" || typeof o.displayName !== "string" || typeof o.role !== "string") return null;
  return { userId: o.userId, displayName: o.displayName, role: o.role };
}

export class HttpSessionApi implements SessionApi {
  #csrf: string | null = null; // memory only: never written to storage
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
    const body: unknown = await res.json();
    const user = asUser(body);
    if (!user) throw new Error("whoami: unexpected body");
    if (typeof (body as { csrf?: unknown }).csrf === "string") this.#csrf = (body as { csrf: string }).csrf;
    return user;
  }

  async login(c: { username: string; password: string }): Promise<LoginResult> {
    let res: Response;
    try {
      res = await this.#fetch(this.#base + SESSION_ROUTES.login, {
        method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ username: c.username, password: c.password }),
      });
    } catch {
      return { ok: false, failure: { kind: "network" } };
    }
    if (res.status === 401) return { ok: false, failure: { kind: "invalid-credentials" } };
    if (res.status === 429) {
      const n = Number(res.headers.get("retry-after"));
      return { ok: false, failure: { kind: "rate-limited", retryAfterSeconds: Number.isFinite(n) && n > 0 ? Math.ceil(n) : null } };
    }
    if (!res.ok) return { ok: false, failure: { kind: "server", status: res.status } };
    let body: unknown;
    try { body = await res.json(); } catch { return { ok: false, failure: { kind: "server", status: res.status } }; }
    const user = asUser(body);
    const csrf = (body as { csrf?: unknown }).csrf;
    if (!user || typeof csrf !== "string") return { ok: false, failure: { kind: "server", status: res.status } };
    this.#csrf = csrf;
    return { ok: true, user };
  }

  async logout(): Promise<void> {
    try {
      await this.#fetch(this.#base + SESSION_ROUTES.logout, {
        method: "POST", credentials: "same-origin",
        headers: this.#csrf ? { "x-csrf-token": this.#csrf } : {},
      });
    } catch { /* the local state is cleared regardless */ }
    this.#csrf = null;
  }
}

export type SessionState =
  | { status: "checking" }
  | { status: "anonymous" }
  | { status: "authenticated"; user: SessionUser };

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

export async function signIn(username: string, password: string): Promise<LoginResult> {
  const result = await api.login({ username, password });
  if (result.ok) sessionState.value = { status: "authenticated", user: result.user };
  return result;
}

export async function signOut(): Promise<void> {
  await api.logout();
  sessionState.value = { status: "anonymous" };
}
