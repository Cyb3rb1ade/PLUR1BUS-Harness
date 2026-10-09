// RPC surface for provider login on top of the D110 AuthService (R2): auth.login.start|await|cancel, auth.credentials.list,
// auth.logout, auth.status. The principal is the guard's authenticated one (never a param); the AuthService itself
// refuses anything but the installation owner's own credentials. No token, refresh token, client id, code verifier or
// callback code is ever part of a result, an error or a log line: results are projected field by field.
import type { Handler, CallContext } from "./server.ts";
import { RpcError } from "./errors.ts";
import { authenticatedPrincipal } from "../rbac/guard.ts";
import { OpenAIError } from "../openai-auth/ports.ts";
import type { AuthService, CredentialInfo } from "../openai-auth/service.ts";
import type { PlanPrincipal } from "../openai-auth/profiles.ts";

/** Closed mapping from the service's constant codes; the code itself is the `reason`, vendor detail never escapes. */
const MAPPING: Record<string, "E_DENIED" | "E_CONFLICT" | "E_NOT_AVAILABLE" | "E_STORAGE" | "E_INVALID_PARAMS" | "E_NOT_FOUND"> = {
  "owner-only": "E_DENIED", "access-denied": "E_DENIED", "state-mismatch": "E_DENIED", "scope-denied": "E_DENIED", "credential-denied": "E_DENIED",
  "id-token-invalid": "E_DENIED", "policy-denied": "E_DENIED", "surface-denied": "E_DENIED",
  "login-timeout": "E_CONFLICT", "login-cancelled": "E_CONFLICT", "port-in-use": "E_CONFLICT", "capacity-exceeded": "E_CONFLICT",
  "persist-failed": "E_STORAGE", "invalid-request": "E_INVALID_PARAMS", "auth-required": "E_NOT_FOUND",
};

function fail(e: unknown, unknownLogin = false): never {
  if (e instanceof RpcError) throw e;
  if (e instanceof OpenAIError) {
    // The service answers an unknown or foreign login id with owner-only; for a login id the caller can only mean "not pending".
    if (unknownLogin && e.code === "owner-only") throw new RpcError("E_NOT_FOUND", "login not found", { reason: "login-unknown" });
    throw new RpcError(MAPPING[e.code] ?? "E_NOT_AVAILABLE", `login refused (${e.code})`, { reason: e.code });
  }
  throw new RpcError("E_INTERNAL", "login request failed");
}

/** Explicit projection: whatever the service object carries, only these metadata fields leave the process. */
export function projectCredential(c: CredentialInfo) {
  return { id: c.id, person: c.person, workspace: c.workspace, kind: c.kind, billingPath: c.billingPath, expiresAt: c.expiresAt, needsLogin: c.needsLogin };
}

const str = (params: unknown, key: string, pattern?: RegExp): string | undefined => {
  const v = typeof params === "object" && params !== null ? (params as Record<string, unknown>)[key] : undefined;
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !v || v.length > 128 || (pattern && !pattern.test(v))) throw new RpcError("E_INVALID_PARAMS", `invalid ${key}`);
  return v;
};
const required = (params: unknown, key: string, pattern?: RegExp): string => {
  const v = str(params, key, pattern);
  if (v === undefined) throw new RpcError("E_INVALID_PARAMS", `${key} is required`);
  return v;
};
const ID = /^[a-f0-9]{64}$/;

/** The loopback port the authorize URL redirects to (for the headless `ssh -L` hint); no secret part of the URL is read. */
function callbackPort(url: string): number {
  try {
    const redirect = new URL(new URL(url).searchParams.get("redirect_uri") ?? "");
    const port = Number(redirect.port);
    if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
  } catch { /* falls through */ }
  throw new OpenAIError("invalid-request");
}

export function buildAuthSurface(service: () => AuthService | null): Record<string, Handler> {
  const bind = (fn: (s: AuthService, p: any, who: PlanPrincipal, ctx: CallContext) => unknown): Handler => async (p, ctx) => {
    const principal = authenticatedPrincipal(ctx);
    const s = service();
    if (!s) throw new RpcError("E_NOT_AVAILABLE", "provider login unavailable");
    // The authenticated person, on their own installation: the service's requireOwner is the second gate.
    const who: PlanPrincipal = { owner: principal.userId, user: principal.userId, agentOwner: principal.userId, deployment: "local" };
    try { return await fn(s, p, who, ctx); } catch (e) { return fail(e); }
  };
  return {
    "auth.login.start": bind(async (s, p, who) => {
      const provider = str(p, "provider") ?? "openai";
      if (provider !== "openai") throw new RpcError("E_INVALID_PARAMS", "provider has no OAuth login", { reason: "unsupported-provider" });
      const credentialId = str(p, "credentialId", ID);
      const started = await s.startLogin({ principal: who, ...(credentialId ? { credentialId } : {}) });
      const authorizeUrl = started.authorizeUrl.value();
      let port: number;
      try { port = callbackPort(authorizeUrl); } catch (e) { try { s.cancelLogin(started.loginId, who); } catch { /* already gone */ } throw e; }
      return { attemptId: started.loginId, authorizeUrl, callbackPort: port };
    }),
    "auth.login.await": bind(async (s, p, who, ctx) => {
      const attemptId = required(p, "attemptId");
      // A caller that goes away (CLI killed, socket dropped) must not leave a listener bound until the login deadline.
      const abandon = () => { try { s.cancelLogin(attemptId, who); } catch { /* finished or not ours */ } };
      ctx.signal.addEventListener("abort", abandon, { once: true });
      if (ctx.signal.aborted) abandon();
      try { return projectCredential(await s.awaitLogin(attemptId, who)); }
      catch (e) { return fail(e, true); }
      finally { ctx.signal.removeEventListener("abort", abandon); }
    }),
    "auth.login.cancel": bind(async (s, p, who) => {
      const attemptId = required(p, "attemptId");
      try { s.cancelLogin(attemptId, who); } catch (e) { return fail(e, true); }
      // Settle the attempt so a login nobody is waiting on does not stay in the service's pending table.
      void s.awaitLogin(attemptId, who).catch(() => {});
      return { cancelled: true };
    }),
    "auth.credentials.list": bind(async (s, _p, who) => ({ credentials: (await s.listCredentials(who)).map(projectCredential) })),
    "auth.logout": bind(async (s, p, who) => {
      const id = required(p, "id", ID);
      await s.logout(id, who);
      return { id, loggedOut: true };
    }),
    "auth.status": bind(async (s, _p, who) => {
      const status = await s.status(who);
      return { credentials: status.credentials.map(projectCredential), pendingLogins: status.pendingLogins };
    }),
  };
}
