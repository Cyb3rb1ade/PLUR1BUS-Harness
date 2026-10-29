// The delegation credential is separate from core.token. It authenticates the API, never the browser.
import { timingSafeEqual } from "node:crypto";
import type { CallContext } from "./rpc-server.ts";
import { RpcError } from "./rpc-error.ts";

export interface ApiPrincipal {
  userId: string; kind: "person" | "agent"; role: "owner" | "admin" | "operator" | "member" | "viewer";
  agentRights?: Readonly<Record<string, "use" | "manage">>;
  projectRights?: Readonly<Record<string, "member" | "lead">>;
  tokenScopes?: readonly string[];
}
export type ApiTransport = "loopback" | "remote";
export interface ApiDelegation { clientId: "harness-api"; token: string; principal?: ApiPrincipal; transport?: ApiTransport }
const roles = new Set(["owner", "admin", "operator", "member", "viewer"]);
const identities = new WeakMap<CallContext, ApiPrincipal | null>();
const transports = new WeakMap<CallContext, ApiTransport>();
/** Only the shared server registers a context after checking the API credential. */
export function bindApiPrincipal(ctx: CallContext, p: ApiPrincipal | null, transport?: ApiTransport): void {
  identities.set(ctx, p);
  if (p && transport !== undefined) transports.set(ctx, transport); else transports.delete(ctx);
}
export function apiPrincipal(ctx: CallContext): ApiPrincipal | null | undefined { return identities.get(ctx); }
/** Verified API request locality; plain context fields, RPC params and principal snapshots cannot grant it. */
export function apiTransport(ctx: CallContext): ApiTransport | undefined { return transports.get(ctx); }
export function validApiPrincipal(v: unknown): v is ApiPrincipal {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const p = v as Record<string, unknown>;
  if (Object.keys(p).some(k => !["userId", "kind", "role", "agentRights", "projectRights", "tokenScopes"].includes(k))) return false;
  if (typeof p.userId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(p.userId) || !roles.has(String(p.role)) || !["person", "agent"].includes(String(p.kind))) return false;
  for (const [key, values] of [["agentRights", ["use", "manage"]], ["projectRights", ["member", "lead"]]] as const) {
    const rights = p[key];
    if (rights !== undefined && (!rights || typeof rights !== "object" || Array.isArray(rights) || Object.entries(rights).some(([k, x]) => !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(k) || !(values as readonly unknown[]).includes(x)))) return false;
  }
  return p.tokenScopes === undefined || (Array.isArray(p.tokenScopes) && p.tokenScopes.every(s => typeof s === "string" && s.length <= 256));
}
export function verifyApiDelegation(v: unknown, token: string | undefined): ApiPrincipal | null {
  const deny = (): never => { throw new RpcError("E_UNAUTHORIZED", "API delegation refused", { reason: "api-delegation" }); };
  if (!token || !v || typeof v !== "object" || Array.isArray(v)) return deny();
  const d = v as Record<string, unknown>;
  if (Object.keys(d).some(k => !["clientId", "token", "principal", "transport"].includes(k)) || d.clientId !== "harness-api" || typeof d.token !== "string" || d.transport !== undefined && d.transport !== "loopback" && d.transport !== "remote") return deny();
  const got = Buffer.from(d.token), want = Buffer.from(token);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return deny();
  if (d.principal === undefined) return null;
  if (!validApiPrincipal(d.principal)) return deny();
  return structuredClone(d.principal);
}
