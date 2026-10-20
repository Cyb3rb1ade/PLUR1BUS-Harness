import { RPC_RULES, authorize } from "./rbac-bridge.ts";
import { ERROR_CODES, METHODS_BY_SERVER, validateParams } from "@plur1bus/rpc-schema";
import type { ApiPrincipal } from "@plur1bus/module-api";
import type { CoreRpc } from "./core-rpc.ts";

/** Explicit exposure, not a prefix match: additions require review and a test. Unsafe unguarded memory/caller paths,
 * lifecycle internals, subscriptions, admin backup/import and secret reveal are deliberately absent. */
export const WEB_CORE_METHODS = new Set([
  "chat.promote.links", "chat.promote.preview", "chat.promote.commit",
  "collab.trace.get", "collab.trace.list", "collab.session.replay", "collab.chain.cancel",
  "project.column.list", "project.card.comment.add", "project.card.comment.list", "project.card.activity.list", "task.complete",
  "model.embedding.select", "model.licence.confirm", "model.licence.list", "model.licence.check", "agent.create", "agent.validate", "agent.import",
  "core.status", "agent.list", "agent.status", "agent.activity.list", "agent.pause", "agent.resume", "agent.archive", "agent.unarchive", "agent.export", "agent.delete", "agent.rights.get", "agent.rights.set",
  "inbox.count", "inbox.list", "inbox.markRead", "inbox.dismiss", "session.list", "session.get", "session.create", "session.submit", "session.cancel", "session.archive", "session.resume", "session.events",
  "project.list", "project.get", "project.create", "project.update", "project.card.list", "project.card.create", "project.card.update", "project.card.move",
  "memory.curation.list", "memory.curation.resolve",
  "memory.list", "memory.show", "memory.forget", "grant.list", "grant.create", "grant.revoke", "approval.list", "approval.get", "approval.verify", "approval.decide", "approval.cancel",
  "breakglass.list", "breakglass.notices", "breakglass.request", "breakglass.revoke", "identity.list", "identity.link.request", "identity.link.remove", "user.list", "user.role.set", "user.disable", "user.enable", "user.invite.create", "user.invite.list", "user.invite.revoke",
  "device.list", "device.rename", "device.revoke", "pairing.qr", "media.search", "media.index.status", "media.index.reindex", "media.caption.set", "media.output.get",
  "channel.list", "channel.get", "channel.set", "channel.enable", "channel.disable", "channel.test", "logs.query", "logs.tail", "audit.verify",
  "dreams.status", "dreams.log", "dreams.schedule.get", "dreams.schedule.set", "dreams.enable", "dreams.disable", "dreams.run", "jobs.list", "jobs.history", "jobs.run", "jobs.create", "jobs.update", "jobs.delete", "doctor.report",
  "budget.status", "budget.set", "auth.status", "auth.credentials.list", "auth.login.start", "auth.login.await", "auth.login.cancel", "auth.logout",
  "voice.status", "voice.metrics.get", "voice.language.get", "voice.language.list", "voice.language.set", "voice.realtime.profile.get", "voice.realtime.profile.set", "voice.models.list", "voice.models.install", "voice.realtime.start", "voice.realtime.stop",
  "secret.status", "secret.list", "secret.set", "secret.delete", "models.list", "models.setOverride", "models.removeManual",
]);
export const WEB_SUPERVISOR_METHODS = new Set(["config.get", "config.set", "module.list", "module.graph"]);
export function webEndpoint(method: string): "core" | "supervisor" | null {
  if (WEB_CORE_METHODS.has(method) && METHODS_BY_SERVER.core.includes(method)) return "core";
  if (WEB_SUPERVISOR_METHODS.has(method) && METHODS_BY_SERVER.supervisor.includes(method)) return "supervisor";
  return null;
}
const messages: Record<string, string> = { E_DENIED: "request denied", E_UNAUTHORIZED: "authentication required", E_INVALID_PARAMS: "invalid parameters", E_NOT_AVAILABLE: "not available", E_CORE_UNAVAILABLE: "backend unavailable", E_CONFLICT: "conflict" };
export function rpcFailure(id: unknown, e: unknown, fallback = "E_CORE_UNAVAILABLE"): Record<string, unknown> {
  const x = e as { error?: unknown; code?: unknown; jsonrpcCode?: unknown; reason?: unknown } | null;
  const error = typeof x?.error === "string" && (ERROR_CODES as readonly string[]).includes(x.error) ? x.error : fallback;
  const reason = typeof x?.reason === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(x.reason) ? x.reason : undefined;
  const code = typeof x?.code === "number" ? x.code : typeof x?.jsonrpcCode === "number" ? x.jsonrpcCode : error === "E_INVALID_PARAMS" ? -32602 : -32000;
  return { jsonrpc: "2.0", id, error: { code, message: messages[error] ?? "RPC request failed", data: { error, ...(reason ? { reason } : {}) } } };
}
export async function rpcRoute(core: CoreRpc, body: unknown, principal: ApiPrincipal, connectionKey?: string): Promise<Record<string, unknown>> {
  const b = body as Record<string, unknown> | null;
  const id = b && (typeof b.id === "string" || Number.isSafeInteger(b.id)) ? b.id : null;
  if (!b || typeof b !== "object" || Array.isArray(b) || b.jsonrpc !== "2.0" || id === null || typeof b.method !== "string" || b.method.length > 256)
    return rpcFailure(null, { error: "E_INVALID_PARAMS", code: -32600, reason: "invalid-request" });
  const endpoint = webEndpoint(b.method);
  if (!endpoint) return rpcFailure(id, { error: "E_DENIED", code: -32601, reason: "web-method" });
  if (b.params !== undefined && (!b.params || typeof b.params !== "object" || Array.isArray(b.params))) return rpcFailure(id, { error: "E_INVALID_PARAMS" });
  const params = { ...(b.params as object ?? {}) } as Record<string, unknown>;
  delete params.principal; delete params.actAs;
  if (!validateParams(b.method, params).ok) return rpcFailure(id, { error: "E_INVALID_PARAMS" });
  // A native device session has no ambient permission for legacy RPCs without an explicit action rule.
  if (principal.kind === "person" && principal.tokenScopes !== undefined) {
    const rule=RPC_RULES[b.method];
    if(!rule || authorize(principal,rule.action,rule.resource(params)).effect!=="allow")return rpcFailure(id,{error:"E_DENIED",reason:"device-scope"});
  }
  if (!core.callAs) return rpcFailure(id, { error: "E_NOT_AVAILABLE", reason: "api-delegation-unavailable" });
  try {
    if (b.method === "config.set") await core.callAs("model.licence.check", { changes: params.changes }, principal, "core", connectionKey);
    return { jsonrpc: "2.0", id, result: await core.callAs(b.method, params, principal, endpoint, connectionKey) }; }
  catch (e) { return rpcFailure(id, e); }
}
