// The integration point for core RPC methods: wraps the handlers named in `RPC_RULES` with principal resolution and
// `authorize`. Methods without a rule pass through untouched. Only a representative set is secured so far
// (docs/rbac.md lists the rest): memory.forget, agent.status, jobs.run, the models.* writes and the admin.* family.
import { RpcError } from "../rpc/errors.ts";
import type { CallContext, Handler } from "../rpc/server.ts";
import type { AuditSink } from "./audit.ts";
import { authorize } from "./authorize.ts";
import type { Principal, Resource } from "./types.ts";

/** RULING R8: until the Harness API supplies sessions and tokens, a connection that passed the core's own token
 *  handshake (a 0600 file in the home, ADR-012) is the installation owner. */
export const LOCAL_OWNER: Principal = Object.freeze({ userId: "local-owner", role: "owner" });

export type PrincipalResolver = (ctx: CallContext, method: string, params: unknown) => Principal | null | undefined | Promise<Principal | null | undefined>;

export interface RpcRule {
  action: string;
  /** Builds the resource from the params. Whatever is missing or mistyped becomes "" and `authorize` denies it. */
  resource: (params: unknown) => Resource;
}

const field = (params: unknown, key: string): string => {
  if (typeof params !== "object" || params === null || !Object.hasOwn(params, key)) return "";
  const v = (params as Record<string, unknown>)[key];
  return typeof v === "string" ? v : "";
};
const agent = (params: unknown): Resource => ({ kind: "agent", agentId: field(params, "agentId") });
const system = (): Resource => ({ kind: "system" });
const rule = (action: string, resource: RpcRule["resource"]): RpcRule => ({ action, resource });

export const RPC_RULES: Readonly<Record<string, RpcRule>> = Object.freeze({
  "memory.forget": rule("memory.forget", agent),
  "agent.status": rule("agent.read", agent),
  "jobs.run": rule("jobs.run", system),
  "models.setOverride": rule("models.write", system),
  "models.removeManual": rule("models.write", system),
  "admin.obsidian.detect": rule("admin.obsidian.detect", system),
  "admin.obsidian.prepare": rule("admin.obsidian.prepare", system),
  "admin.obsidian.confirm": rule("admin.obsidian.confirm", system),
  "admin.migrate": rule("admin.migrate", system),
  "admin.embedding.probe": rule("admin.embedding.probe", system),
  "admin.embedding.serve": rule("admin.embedding.serve", system),
  "admin.backup.snapshot": rule("admin.backup.snapshot", system),
});

export interface GuardOptions {
  resolve: PrincipalResolver;
  /** Sees denials and unauthenticated calls; its failures never change an outcome. */
  audit?: AuditSink;
  now: () => number;
  host?: string;
  rules?: Readonly<Record<string, RpcRule>>;
}

export function guardMethods(handlers: Record<string, Handler>, o: GuardOptions): Record<string, Handler> {
  const rules = o.rules ?? RPC_RULES;
  const host = o.host ?? "local";
  const record = (action: string, user: string, target: string, detail: Record<string, unknown>): void => {
    try { o.audit?.append({ at: o.now(), actor: { user, host }, action, target, detail }); } catch { /* the refusal stands */ }
  };
  const out: Record<string, Handler> = { ...handlers };
  for (const [method, r] of Object.entries(rules)) {
    const inner = handlers[method];
    if (!inner) continue;
    out[method] = async (params, ctx) => {
      let principal: Principal | null | undefined;
      try { principal = await o.resolve(ctx, method, params); }
      catch {
        record("rbac.unauthenticated", "anonymous", method, { action: r.action, reason: "resolver-failed" });
        throw new RpcError("E_UNAUTHORIZED", "authentication required", { reason: "resolver-failed" });
      }
      if (principal === null || principal === undefined) {
        record("rbac.unauthenticated", "anonymous", method, { action: r.action, reason: "no-principal" });
        throw new RpcError("E_UNAUTHORIZED", "authentication required", { reason: "no-principal" });
      }
      const d = authorize(principal, r.action, r.resource(params), { now: o.now() });
      if (d.effect === "deny") {
        record("rbac.denied", typeof principal.userId === "string" && principal.userId !== "" ? principal.userId : "anonymous", method,
          { action: r.action, reason: d.reason, role: String(principal.role) });
        throw new RpcError("E_DENIED", `not permitted: ${r.action}`, { reason: d.reason });
      }
      return inner(params, ctx);
    };
  }
  return out;
}
