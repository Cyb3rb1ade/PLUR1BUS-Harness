// D109 §4: grant.list | grant.create | grant.revoke. A grant belongs to the calling person: the person, `createdBy` and the surface level
// come from the authenticated connection (see `callerOf`), never from params. The store enforces the ceiling and the minimum surface of
// the capability; this file adds the wire mapping, the "never" classes, the agent check and the surface a grant of that scope needs.
import type { GrantCreateParams, GrantListParams, GrantMatch, GrantRecord, GrantRevokeParams } from "@plur1bus/rpc-schema";
import { guarded, type ApprovalMethodDeps, type Caller, type PermissionHandles } from "../approvals/rpc-common.ts";
import { grantRecordOf, page, parseIso } from "../approvals/wire.ts";
import { CAPABILITIES, requiredSurface, scopeRank, type GrantScope } from "../policy/index.ts";
import type { Handler } from "../rpc/server.ts";
import { RpcError } from "../rpc/errors.ts";
import { GrantError, type CreateGrantInput, type GrantState, type StoredGrant } from "./store.ts";

const invalid = (reason: string, detail: string, message: string): RpcError => new RpcError("E_INVALID_PARAMS", message, { reason, detail });

function matchOf(m: GrantMatch | undefined): CreateGrantInput["match"] {
  if (m === undefined) return { kind: "capability" };
  if (m.kind === "path") {
    if (typeof m.path !== "string" || (m.access !== "read" && m.access !== "write")) throw invalid("invalid-grant", "match", "a path match needs path and access");
    return { kind: "path", path: m.path, access: m.access, recursive: m.recursive === true };
  }
  if (m.kind === "capability" || m.kind === "action") {
    if (m.path !== undefined || m.access !== undefined || m.recursive !== undefined) throw invalid("invalid-grant", "match", `a ${m.kind} match takes no path, access or recursive`);
    return { kind: m.kind };
  }
  throw invalid("invalid-grant", "match", "unknown match kind");
}

function mapGrantError(e: unknown): unknown {
  if (!(e instanceof GrantError)) return e;
  switch (e.code) {
    case "never-capability": return new RpcError("E_DENIED", e.message, { reason: "policy-never" });
    case "surface-too-low": return new RpcError("E_DENIED", e.message, { reason: "surface-untrusted" });
    case "ceiling-exceeded": return new RpcError("E_INVALID_PARAMS", e.message, { reason: "ceiling-exceeded" });
    case "duplicate-id": return new RpcError("E_INVALID_PARAMS", e.message, { reason: "duplicate-id" });
    default: return new RpcError("E_INVALID_PARAMS", e.message, { reason: "invalid-grant" });
  }
}

export function buildGrantMethods(d: ApprovalMethodDeps): Record<"grant.list" | "grant.create" | "grant.revoke", Handler> {
  const guard = guarded(d);
  const viewOf = (h: PermissionHandles, person: string, id: string): { grant: StoredGrant; state: GrantState } | undefined =>
    h.grants.inspect({ person }).find((v) => v.grant.id === id);

  return {
    "grant.list": guard("grant.list", async (p: GrantListParams = {}, c: Caller, h) => {
      const cap = p.capability?.trim().toLowerCase();
      const views = h.grants.inspect({ person: c.person, ...(p.agent !== undefined ? { agent: p.agent } : {}) })
        .filter((v) => (cap === undefined || v.grant.capability === cap) && (p.state === undefined || v.state === p.state));
      const out = page("g", views.map((v) => ({ ...v, id: v.grant.id, createdAt: v.grant.createdAt })), {
        filter: { agent: p.agent, capability: cap, state: p.state }, ...(p.limit !== undefined ? { limit: p.limit } : {}), ...(p.cursor !== undefined ? { cursor: p.cursor } : {}),
      });
      return { grants: out.items.map((v) => grantRecordOf(v.grant, v.state)), ...(out.nextCursor ? { nextCursor: out.nextCursor } : {}) };
    }),

    "grant.create": guard("grant.create", async (p: GrantCreateParams, c: Caller, h): Promise<GrantRecord> => {
      const capability = typeof p.capability === "string" ? p.capability.trim().toLowerCase() : "";
      const def = CAPABILITIES.get(capability);
      if (!def) throw invalid("invalid-grant", "capability", `unknown capability ${capability.slice(0, 64)}`);
      if (def.base.inside === "never") throw new RpcError("E_DENIED", `${def.id} is a never capability; no grant can exist for it`, { reason: "policy-never" });
      if (p.scope !== "task" && p.scope !== "session" && p.scope !== "always") throw invalid("invalid-grant", "scope", "a grant is task, session or always; once is made by approval.decide");
      d.requireAgent(p.agent);
      const match = matchOf(p.match);
      let expiresAt: number | undefined;
      if (p.expiresAt !== undefined) {
        expiresAt = parseIso(p.expiresAt);
        if (expiresAt === undefined) throw invalid("invalid-grant", "expiresAt", "expiresAt must be an RFC 3339 time");
      }
      // §5: the surface a grant of this scope needs. A path grant is the way to reach outside the roots, so it is judged as outside them.
      // Only when the scope is within the capability's ceiling: the store reports an over-wide scope as ceiling-exceeded.
      if (def.ceiling !== null && scopeRank(p.scope) <= scopeRank(def.ceiling) && c.surface < requiredSurface(def, p.scope as GrantScope, { outsideRoots: match.kind === "path", denyListHit: false })) {
        throw new RpcError("E_DENIED", `a ${p.scope} grant for ${def.id} needs a more trusted surface than this connection`, { reason: "surface-untrusted" });
      }
      let g: StoredGrant;
      try {
        g = h.grants.create({
          capability: def.id, person: c.person, agent: p.agent, scope: p.scope, match, createdBy: c.person, surface: c.surface,
          ...(expiresAt !== undefined ? { expiresAt } : {}), ...(p.taskId !== undefined ? { taskId: p.taskId } : {}), ...(p.sessionId !== undefined ? { sessionId: p.sessionId } : {}),
          ...(p.projectId !== undefined ? { projectId: p.projectId } : {}), ...(p.jobId !== undefined ? { jobId: p.jobId } : {}),
          ...(p.delegable === true ? { delegable: true } : {}), ...(p.acknowledgedUnsandboxed === true ? { acknowledgedUnsandboxed: true } : {}),
        });
      } catch (e) { throw mapGrantError(e); }
      const rec = grantRecordOf(g, "active");
      d.notify?.grantChanged("created", rec);
      return rec;
    }),

    "grant.revoke": guard("grant.revoke", async (p: GrantRevokeParams, c: Caller, h): Promise<GrantRecord> => {
      const v = viewOf(h, c.person, p.id);
      if (!v) throw new RpcError("E_NOT_FOUND", `no grant ${p.id}`);
      if (v.state === "revoked" || v.state === "consumed") return grantRecordOf(v.grant, v.state);
      const ended = h.grants.revoke(p.id, c.person);
      const now = viewOf(h, c.person, p.id) ?? v;
      const rec = grantRecordOf(now.grant, now.state);
      if (ended) d.notify?.grantChanged("revoked", rec);
      return rec;
    }),
  };
}
