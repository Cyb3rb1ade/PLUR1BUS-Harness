// F39-F42/F44 administration. Authenticated identity comes only from the RPC guard; params never assert authority.
import type { Handler, CallContext } from "./server.ts";
import { RpcError } from "./errors.ts";
import { authenticatedPrincipal } from "../rbac/guard.ts";
import { authorize } from "../rbac/authorize.ts";
import { ROLES, type Principal, type Role } from "../rbac/types.ts";
import type { AuditSink } from "../rbac/audit.ts";
import type { BreakGlass } from "../rbac/break-glass.ts";
import { BreakGlassError } from "../rbac/break-glass.ts";
import type { AdminStore } from "../identity/admin-store.ts";
import type { IdentityService, Actor } from "../identity/service.ts";
import { IdentityError } from "../identity/service.ts";
import type { AgentLifecycle } from "../agents/lifecycle.ts";
import type { SessionStore } from "../session/store.ts";
import { mapSessionError, toWireSession } from "../session/methods.ts";
import { parsePairingLink, qrData } from "../../../remote-access/src/pairing.ts";
import { mapIdentityError } from "../identity/rpc.ts";

export interface AdminSurfaceDeps {
  people: AdminStore; lifecycle: AgentLifecycle; identity: IdentityService;
  sessions: () => SessionStore | null; breakglass: BreakGlass;
  agents: () => Record<string, { displayName?: string; [key: string]: unknown }>;
  export: (agentId: string, who: Principal) => Promise<unknown>;
  /** Only a real engine API may erase memory. Absent in the pinned 1.12.0 contract: fail closed. */
  erase?: (agentId: string) => Promise<void>;
  /** The engine-derived session-owner principals belonging to this authenticated person. */
  ownership: (who: Principal, params?: unknown) => string[];
  sessionUsage?: (ids: readonly string[]) => Map<string, import("./session-usage.ts").SessionUsage>;
  audit: AuditSink; clock: () => number;
}
const obj = (p: unknown): Record<string, any> => p && typeof p === "object" && !Array.isArray(p) ? p as Record<string, any> : {};
function text(p: Record<string, any>, key: string, max = 128): string { const v = p[key]; if (typeof v !== "string" || !v || v.length > max || /[\u0000-\u001f\u007f]/.test(v)) throw new RpcError("E_INVALID_PARAMS", `invalid ${key}`); return v; }
function preset(v: unknown): Role { if (!ROLES.includes(v as Role)) throw new RpcError("E_INVALID_PARAMS", "unknown role preset"); return v as Role; }
export function buildAdminSurface(d: AdminSurfaceDeps): Record<string, Handler> {
  const audit = (who: Principal, action: string, target: string, detail: Record<string, unknown> = {}) => {
    try { d.audit.append({ at: d.clock(), actor: { user: who.userId, host: "rpc" }, action, target, detail }); }
    catch { throw new RpcError("E_STORAGE", "administrative action cannot be audited", { reason: "audit-failed" }); }
  };
  const bind = (action: string, fn: (p: Record<string, any>, a: Principal, ctx: CallContext) => unknown): Handler => async (params, ctx) => {
    const a = authenticatedPrincipal(ctx);
    if (a.kind !== "person") throw new RpcError("E_DENIED", "administration is human-only", { reason: "agent-principal" });
    const p = obj(params);
    const resource = ["admin.agent.operate", "admin.agent.manage", "admin.agent.delete", "admin.agent.rights"].includes(action) ? { kind: "agent" as const, agentId: text(p, "agentId", 64) } : { kind: "system" as const };
    if (authorize(a, action, resource, { now: d.clock() }).effect !== "allow") throw new RpcError("E_DENIED", "administrative operation denied");
    try { return await fn(p, a, ctx); }
    catch (e) {
      if (e instanceof RpcError) throw e;
      if (e instanceof IdentityError) return mapIdentityError(e);
      if (e instanceof BreakGlassError) throw new RpcError(e.code === "not-permitted" ? "E_DENIED" : e.code === "unknown-grant" ? "E_NOT_FOUND" : e.code === "audit-failed" ? "E_STORAGE" : e.code === "notification-failed" ? "E_NOT_AVAILABLE" : "E_INVALID_PARAMS", "break-glass request refused", { reason: e.code });
      throw new RpcError("E_STORAGE", "administrative storage unavailable");
    }
  };
  const actor = (a: Principal): Actor => ({ user: a.userId, host: "rpc", role: a.role, kind: "person", ...(a.tokenScopes ? { tokenScopes: a.tokenScopes } : {}) });
  const deleting = new Set<string>();
  const agent = (p: Record<string, any>) => {
    const id = text(p, "agentId", 64);
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) throw new RpcError("E_INVALID_PARAMS", "invalid agentId");
    if (deleting.has(id)) throw new RpcError("E_CONFLICT", "agent erasure is in progress", { reason: "delete-in-progress" });
    const all = d.agents();
    const config = Object.hasOwn(all, id) ? all[id] : undefined;
    if (!config || d.lifecycle.state(id).deleted) throw new RpcError("E_NOT_FOUND", "agent not found");
    return { id, config };
  };
  const user = (id: string) => {
    if (!d.people.users().some(u => u.id === id) && !d.identity.list({}).humans.some(h => h.id === id)) throw new RpcError("E_NOT_FOUND", "user not found");
    return id;
  };
  const toggle = (operation: "pause" | "resume" | "archive" | "unarchive") => bind(operation === "pause" || operation === "resume" ? "admin.agent.operate" : "admin.agent.manage", (p, a) => {
    const { id } = agent(p), state = d.lifecycle.state(id);
    if (operation === "resume" && state.archived) throw new RpcError("E_CONFLICT", "unarchive before resuming", { reason: "archived" });
    const patch = operation === "pause" ? { paused: true } : operation === "resume" ? { paused: false } : operation === "archive" ? { archived: true } : { archived: false };
    audit(a, `agent.${operation}`, id);
    return { agentId: id, ...d.lifecycle.set(id, patch) };
  });
  return {
    "agent.pause": toggle("pause"), "agent.resume": toggle("resume"), "agent.archive": toggle("archive"), "agent.unarchive": toggle("unarchive"),
    "agent.export": bind("admin.agent.manage", async (p, a) => {
      const { id } = agent(p);
      audit(a, "agent.export.offered", id);
      const offer = d.lifecycle.offer(id, a.userId, d.clock());
      if (p.offerOnly === true) return { agentId: id, ...offer };
      const bundle = await d.export(id, a);
      audit(a, "agent.export", id);
      return { agentId: id, ...offer, bundle };
    }),
    "agent.delete": bind("admin.agent.delete", async (p, a) => {
      const { id, config } = agent(p);
      if (!d.lifecycle.state(id).archived) throw new RpcError("E_CONFLICT", "archive before deleting", { reason: "not-archived" });
      if (text(p, "confirmName") !== (config.displayName ?? id)) throw new RpcError("E_INVALID_PARAMS", "typed name does not match", { reason: "name-mismatch" });
      d.lifecycle.requireOffer(text(p, "exportOfferId"), id, a.userId, d.clock());
      if (!d.erase) { audit(a, "agent.delete.unavailable", id, { reason: "engine-erasure-unavailable" }); throw new RpcError("E_NOT_AVAILABLE", "the pinned engine has no agent erasure API", { reason: "engine-erasure-unavailable" }); }
      audit(a, "agent.delete", id);
      deleting.add(id);
      try { await d.erase(id); d.lifecycle.set(id, { deleted: true }); audit(a, "agent.deleted", id); }
      catch (e) { audit(a, "agent.delete.failed", id, { reason: "engine-erasure-failed" }); throw e; }
      finally { deleting.delete(id); }
      return { agentId: id, deleted: true };
    }),
    "user.list": bind("admin.users.read", () => {
      const people = new Map(d.identity.list({}).humans.map(h => [h.id, { id: h.id, displayName: h.displayName, role: d.people.role(h.id) }]));
      for (const u of d.people.users()) if (!people.has(u.id)) people.set(u.id, { ...u, displayName: u.id });
      return { users: [...people.values()].sort((a, b) => a.id.localeCompare(b.id)) };
    }),
    "user.role.set": bind("admin.users.write", (p, a) => {
      const id = user(text(p, "userId")), role = preset(p.role), before = d.people.role(id);
      if ((before === "owner" || role === "owner") && a.role !== "owner") throw new RpcError("E_DENIED", "only an Owner may change ownership", { reason: "owner-only" });
      d.people.setRole(id, role, () => audit(a, "user.role.set", id, { previous: before, role }));
      return { userId: id, role };
    }),
    "user.invite.create": bind("admin.users.write", (p, a) => {
      const displayName = text(p, "displayName"), channel = text(p, "channel", 32), role = preset(p.role);
      // Invitations never create another Owner: ownership transfer is a separate, audited operation.
      if (role === "owner") throw new RpcError("E_DENIED", "an invitation cannot grant ownership");
      const minutes = p.expiresInMinutes ?? 60;
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) throw new RpcError("E_INVALID_PARAMS", "invite lifetime must be 1-60 minutes");
      audit(a, "user.invite.create", "invitation", { role, channel });
      const h = d.identity.createHuman({ displayName }, actor(a));
      const pair = d.identity.startPairing({ humanId: h.id, channel, ttlMs: minutes * 60_000 }, actor(a));
      d.people.setRole(h.id, role, () => {});
      d.people.invite({ id: pair.pairingId, userId: h.id, role, channel, expiresAt: pair.expiresAt });
      return { id: pair.pairingId, userId: h.id, role, channel, expiresAt: pair.expiresAt, code: pair.code };
    }),
    "user.invite.list": bind("admin.users.read", () => {
      const pairs = d.identity.list({}).pairings;
      return { invites: d.people.invites().map(i => ({ id: i.id, userId: i.userId, role: i.role, channel: i.channel, expiresAt: i.expiresAt, state: i.revoked ? "revoked" : pairs.find(p => p.id === i.id)?.state === "confirmed" ? "confirmed" : i.expiresAt <= d.clock() ? "expired" : pairs.find(p => p.id === i.id)?.state ?? "expired" })) };
    }),
    "user.invite.revoke": bind("admin.users.write", (p, a) => {
      const id = text(p, "inviteId"), invite = d.people.invites().find(i => i.id === id);
      if (!invite) throw new RpcError("E_NOT_FOUND", "invitation not found");
      audit(a, "user.invite.revoke", id);
      d.identity.revokePairing(id, actor(a)); d.people.revoke(id);
      return { id, revoked: true };
    }),
    "agent.rights.get": bind("admin.agent.rights", p => { const { id } = agent(p); return { agentId: id, rights: d.people.rights(id) }; }),
    "agent.rights.set": bind("admin.agent.rights", (p, a) => {
      const { id } = agent(p), userId = user(text(p, "userId"));
      if (p.right !== "use" && p.right !== "manage" && p.right !== null) throw new RpcError("E_INVALID_PARAMS", "invalid agent right");
      audit(a, "agent.rights.set", id, { userId, right: p.right });
      d.people.setRight(id, userId, p.right);
      return { agentId: id, userId, right: p.right };
    }),
    "breakglass.request": bind("admin.breakglass.write", (p, a) => {
      const targetUserId = user(text(p, "targetUserId")), reason = text(p, "reason", 500).trim(), minutes = p.windowMinutes ?? 15;
      if (reason.length < 10 || !Number.isInteger(minutes) || minutes < 1 || minutes > 60) throw new RpcError("E_INVALID_PARAMS", "reason must be 10-500 characters and window 1-60 minutes");
      return d.breakglass.request(a, { targetUserId, reason, ttlMs: minutes * 60_000 });
    }),
    "breakglass.list": bind("admin.breakglass.read", (_p, a) => ({ grants: d.breakglass.active(a.userId) })),
    "breakglass.revoke": bind("admin.breakglass.write", (p, a) => { const id = text(p, "grantId"); d.breakglass.revoke(a, id); return { id, revoked: true }; }),
    "breakglass.notices": bind("admin.notices.read", (_p, a) => ({ notices: d.people.notices(a.userId) })),
    "session.list": bind("admin.sessions.read", (p, a) => {
      const store = d.sessions(); if (!store) throw new RpcError("E_NOT_AVAILABLE", "sessions unavailable");
      const operator = ["owner", "admin", "operator", "viewer"].includes(a.role);
      const owners = d.ownership(a, p);
      if (!operator && p.allOwners === true) throw new RpcError("E_DENIED", "all-owner metadata requires an operations role");
      if (!operator && p.owner !== undefined && !owners.includes(p.owner)) throw new RpcError("E_DENIED", "only own session metadata is available");
      // Operators cannot search another person's message text as a metadata existence oracle.
      if (p.search !== undefined && (p.allOwners === true || (p.owner !== undefined && !owners.includes(p.owner)))) throw new RpcError("E_DENIED", "transcript search requires own sessions", { reason: "transcript-search" });
      try {
        const r = store.listOverview({ ...(p.owner ? { owner: text(p, "owner") } : p.allOwners !== true || !operator ? { owners } : {}), ...(p.agentId ? { agentId: text(p, "agentId", 64) } : {}), ...(p.kind ? { kind: p.kind } : {}), ...(p.archived ? { archived: p.archived } : {}), ...(p.limit ? { limit: p.limit } : {}), ...(p.search ? { search: p.search } : {}) });
        const accounting = d.sessionUsage?.(r.sessions.map(s => s.id));
        return { sessions: r.sessions.map(s => ({ ...toWireSession(s), owner: s.owner, model: accounting?.get(s.id)?.model ?? s.model, usage: accounting?.get(s.id)?.usage ?? s.usage })), truncated: r.truncated };
      } catch (e) { return mapSessionError(e); }
    }),
    "pairing.qr": bind("admin.pairing.read", p => {
      const link = text(p, "link", 2331), parsed = parsePairingLink(link);
      if (!parsed.ok) throw new RpcError("E_INVALID_PARAMS", "invalid pairing offer");
      if (parsed.offer.expiresAt <= d.clock()) throw new RpcError("E_CONFLICT", "pairing offer expired", { reason: "offer-expired" });
      return { link, qr: qrData(link), expiresAt: parsed.offer.expiresAt };
    }),
  };
}
