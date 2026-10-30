// The delegation credential is separate from core.token. It authenticates the API, never the browser.
import { timingSafeEqual } from "node:crypto";
import type { CallContext } from "./rpc-server.ts";
import { RpcError } from "./rpc-error.ts";

export interface ApiTokenMemoryPolicyOverride {
  readonly recall?: {
    readonly workspace?: boolean;
    readonly user?: boolean;
    readonly agentPrivate?: boolean;
    readonly project?: boolean;
  };
  readonly filter?: readonly ("health" | "financial" | "credential" | "identity" | "personal")[];
  readonly disclose?: "agent-decides" | "never";
  readonly capture?: boolean;
}
export interface ApiTokenBinding {
  readonly audience: "mcp" | "a2a";
  readonly agentId: string;
  readonly projectId?: string;
  readonly system?: string;
  readonly groups?: readonly string[];
  readonly memory?: ApiTokenMemoryPolicyOverride;
}
export interface ApiPrincipal {
  userId: string; kind: "person" | "agent"; role: "owner" | "admin" | "operator" | "member" | "viewer";
  agentRights?: Readonly<Record<string, "use" | "manage">>;
  projectRights?: Readonly<Record<string, "member" | "lead">>;
  tokenScopes?: readonly string[];
  tokenId?: string;
  binding?: ApiTokenBinding;
}
export type ApiTransport = "loopback" | "remote";
export interface ApiDelegation { clientId: "harness-api"; token: string; principal?: ApiPrincipal; transport?: ApiTransport }
const roles = new Set(["owner", "admin", "operator", "member", "viewer"]);
const sensitivitySet = new Set(["health", "financial", "credential", "identity", "personal"]);
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
const isIdentifier = (v: unknown, max = 128): v is string =>
  typeof v === "string" && v.trim().length >= 1 && v.trim().length <= max && !/[\u0000-\u001f\u007f]/.test(v);

function validBinding(v: unknown): v is ApiTokenBinding {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const b = v as Record<string, unknown>;
  if (Object.keys(b).some(k => !["audience", "agentId", "projectId", "system", "groups", "memory"].includes(k))) return false;
  if ((b.audience !== "mcp" && b.audience !== "a2a") || !isIdentifier(b.agentId, 128)) return false;
  if (b.projectId !== undefined && !isIdentifier(b.projectId, 128)) return false;
  if (b.system !== undefined && !isIdentifier(b.system, 128)) return false;
  if (b.groups !== undefined && (!Array.isArray(b.groups) || b.groups.some(g => !isIdentifier(g, 64)))) return false;
  if (b.memory !== undefined) {
    if (!b.memory || typeof b.memory !== "object" || Array.isArray(b.memory)) return false;
    const m = b.memory as Record<string, unknown>;
    if (Object.keys(m).some(k => !["recall", "filter", "disclose", "capture"].includes(k))) return false;
    if (m.recall !== undefined) {
      if (!m.recall || typeof m.recall !== "object" || Array.isArray(m.recall)) return false;
      const r = m.recall as Record<string, unknown>;
      if (Object.keys(r).some(k => !["workspace", "user", "agentPrivate", "project"].includes(k) || typeof r[k] !== "boolean")) return false;
    }
    if (m.filter !== undefined && (!Array.isArray(m.filter) || m.filter.some(c => typeof c !== "string" || !sensitivitySet.has(c)))) return false;
    if (m.disclose !== undefined && m.disclose !== "agent-decides" && m.disclose !== "never") return false;
    if (m.capture !== undefined && typeof m.capture !== "boolean") return false;
  }
  return true;
}
export function validApiPrincipal(v: unknown): v is ApiPrincipal {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const p = v as Record<string, unknown>;
  if (Object.keys(p).some(k => !["userId", "kind", "role", "agentRights", "projectRights", "tokenScopes", "tokenId", "binding"].includes(k))) return false;
  if (typeof p.userId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(p.userId) || !roles.has(String(p.role)) || !["person", "agent"].includes(String(p.kind))) return false;
  for (const [key, values] of [["agentRights", ["use", "manage"]], ["projectRights", ["member", "lead"]]] as const) {
    const rights = p[key];
    if (rights !== undefined && (!rights || typeof rights !== "object" || Array.isArray(rights) || Object.entries(rights).some(([k, x]) => !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(k) || !(values as readonly unknown[]).includes(x)))) return false;
  }
  if (p.tokenId !== undefined && (typeof p.tokenId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(p.tokenId))) return false;
  if (p.binding !== undefined && !validBinding(p.binding)) return false;
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
