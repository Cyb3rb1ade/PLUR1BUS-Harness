// The integration point for core RPC methods: wraps the handlers named in `RPC_RULES` with principal resolution and
// `authorize`. Methods without a rule pass through untouched. Only a representative set is secured so far
// (docs/rbac.md lists the rest): grant.* and approval.* (human-only), memory.forget, agent.status, jobs.run, the models.* writes and the admin.* family.
import { apiPrincipal, isClientContext } from "@plur1bus/module-api";
import { RpcError } from "../rpc/errors.ts";
import type { CallContext, Handler } from "../rpc/server.ts";
import type { AuditSink } from "./audit.ts";
import { authorize } from "./authorize.ts";
import type { AuthorizeContext, Decision, Principal, Resource } from "./types.ts";

/** RULING R8: until the Harness API supplies sessions and tokens, a connection that passed the core's own token
 *  handshake (a 0600 file in the home, ADR-012) is the installation owner. */
export const LOCAL_OWNER: Principal = Object.freeze({ userId: "local-owner", role: "owner", kind: "person" });

export type PrincipalResolver = (ctx: CallContext, method: string, params: unknown) => Principal | null | undefined | Promise<Principal | null | undefined>;

export interface RpcRule {
  action: string;
  humanOnly?: boolean;
  /** Only the credential-authenticated API service, without a browser/agent principal. */
  apiServiceOnly?: boolean;
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

const authenticated = new WeakMap<CallContext, Principal>();
/** Identity established by this invocation's guard, never supplied in request text. */
export function authenticatedPrincipal(ctx: CallContext): Principal {
  const principal = authenticated.get(ctx);
  if (!principal) throw new RpcError("E_UNAUTHORIZED", "authentication required");
  return principal;
}

export const RPC_RULES: Readonly<Record<string, RpcRule>> = Object.freeze({
  ...Object.fromEntries(["a2a.peer.add", "a2a.peer.list", "a2a.peer.remove", "a2a.peer.trust"].map(method => [method, { ...rule("a2a.peers.manage", system), humanOnly: true }])),
  ...Object.fromEntries(["admin.import.detect", "admin.import.wsl.list", "admin.import.plan", "admin.import.preflight",
    "admin.import.skills", "admin.import.apply", "admin.import.status", "admin.import.abort", "admin.import.runs",
    "admin.import.rollback"].map(method => [method,
    { ...rule("imports.manage", system), humanOnly: true }])),
  ...Object.fromEntries(["admin.import.ssh.key.status", "admin.import.ssh.connections.list"].map(method => [method,
    { ...rule("imports.read", system), humanOnly: true }])),
  ...Object.fromEntries(["admin.import.ssh.key.generate", "admin.import.ssh.key.rotate", "admin.import.ssh.key.delete",
    "admin.import.ssh.connections.set", "admin.import.ssh.connections.delete", "admin.import.ssh.hostKey.probe",
    "admin.import.ssh.hostKey.trust"].map(method => [method, { ...rule("imports.manage", system), humanOnly: true }])),
  ...Object.fromEntries(["ext.list", "ext.show", "ext.watch", "ext.inspection.get", "admin.extensions.setup.get", "admin.extensions.runtime.status", "admin.extensions.auth.status"].map(method => [method, { ...rule("extensions.read", system), humanOnly: true }])),
  ...Object.fromEntries(["ext.inspect", "ext.install", "ext.uninstall", "ext.restore", "ext.enable", "ext.disable", "admin.extensions.setup.set", "admin.extensions.auth.start", "admin.extensions.auth.submit", "admin.extensions.auth.cancel", "admin.extensions.runtime.hold", "admin.extensions.runtime.release"].map(method => [method, { ...rule("extensions.manage", system), humanOnly: true }])),
  "secret.describe": { ...rule("settings.write", system), humanOnly: true },
  "secret.grants.list": { ...rule("settings.read", system), humanOnly: true },
  "delivery.target.list": { ...rule("agent.list", system), humanOnly: true },
  "delivery.target.add": { ...rule("agent.list", system), humanOnly: true },
  "delivery.target.confirm": { ...rule("agent.list", system), humanOnly: true },
  "delivery.target.remove": { ...rule("agent.list", system), humanOnly: true },
  "delivery.target.subscribe": { ...rule("agent.list", system), humanOnly: true },
  "channel.history.list": { ...rule("chat:read", system), humanOnly: true },
  "channel.history.get": { ...rule("chat:read", system), humanOnly: true },
  "channel.handoff.create": { ...rule("chat:write", system), humanOnly: true },
  "channel.handoff.redeem": { ...rule("chat:write", system), humanOnly: true },
  "chat.promote.links": { ...rule("chat:read", system), humanOnly: true },
  "chat.promote.preview": { ...rule("chat:write", system), humanOnly: true },
  "chat.promote.commit": { ...rule("chat:write", system), humanOnly: true },
  "events.subscribe": rule("agent.list", system),
  "voice.session.create": { ...rule("agent.use", agent), humanOnly: true },
  "decision.status": { ...rule("settings.read", system), humanOnly: true },
  "decision.test": { ...rule("settings.write", system), humanOnly: true },
  "admin.engine.test": { ...rule("settings.write", system), humanOnly: true },
  "models.test": { ...rule("settings.write", system), humanOnly: true },
  "budget.set": { ...rule("settings.write", system), humanOnly: true },
  "chat.create": rule("chat:write", system),
  "chat.list": rule("chat:read", system),
  "chat.get": rule("chat:read", system),
  "chat.events": rule("chat:read", system),
  "chat.submit": rule("chat:write", system),
  "chat.update": rule("chat:write", system),
  "chat.archive": rule("chat:write", system),
  "chat.restore": rule("chat:write", system),
  "chat.cancel": rule("chat:write", system),
  "chat.fork": rule("chat:write", system),
  "chat.delete": rule("chat:delete", system),
  "chat.export": rule("chat:read", system),
  "chat.model.get": rule("chat:read", system),
  // A model or reasoning switch changes cost and routing for the person's own chat: people only, like session.model.set.
  "chat.model.set": { ...rule("chat:write", system), humanOnly: true },

  "jobs.create": { ...rule("agent.manage", agent), humanOnly: true },
  "jobs.update": { ...rule("agent.list", system), humanOnly: true },
  "jobs.delete": { ...rule("agent.list", system), humanOnly: true },
  "doctor.report": { ...rule("agent.list", system), humanOnly: true },
  "telemetry.cache.summary": { ...rule("doctor.read", system), humanOnly: true },
  "agent.activity.list": { ...rule("agent.list", system), humanOnly: true },
  "inbox.list": rule("inbox.read", system),
  "inbox.count": rule("inbox.read", system),
  "inbox.markRead": rule("inbox.write", system),
  "inbox.dismiss": rule("inbox.write", system),
  "project.column.list": rule("project.board.read", system),
  "project.card.list": rule("project.board.read", system),
  "project.card.get": rule("project.board.read", system),
  "project.card.comment.list": rule("project.board.read", system),
  "project.card.activity.list": rule("project.board.read", system),
  "project.column.create": rule("project.board.manage", system),
  "project.column.update": rule("project.board.manage", system),
  "project.column.move": rule("project.board.manage", system),
  "project.column.delete": rule("project.board.manage", system),
  "project.card.create": rule("project.board.write", system),
  "project.card.update": rule("project.board.write", system),
  "project.card.assign": rule("project.board.write", system),
  "project.card.unassign": rule("project.board.write", system),
  "project.card.archive": rule("project.board.write", system),
  "project.card.unarchive": rule("project.board.write", system),
  "project.card.move": rule("project.board.move", system),
  "project.card.comment.add": rule("project.board.comment", system),
  "media.preferences.get": rule("media.read", system),
  "media.preferences.set": rule("media.write", system),
  "media.generate": rule("media.write", system),
  "media.edit": rule("media.write", system),
  "media.job.get": rule("media.read", system),
  "media.job.cancel": rule("media.write", system),
  "media.job.list": rule("media.read", system),
  "media.output.get": rule("media.read", system),
  "media.output.list": rule("media.read", system),
  "media.output.delete": rule("media.write", system),
  "media.adapters.list": rule("media.read", system),
  // Media index (image, video, audio search): search and status are open to every role including agents (the handler narrows the
  // hits to what the caller may read); operating the index is Owner/Admin and people only; a caption edit needs edit rights on the medium.
  "media.search": rule("media.index.read", system),
  "media.index.status": rule("media.index.read", system),
  "media.index.pause": rule("media.index.operate", system),
  "media.index.resume": rule("media.index.operate", system),
  "media.index.reindex": rule("media.index.operate", system),
  "media.caption.set": rule("media.caption.write", system),
  "project.create": rule("project.create", system),
  "project.get": rule("project.surface.read", system),
  "project.list": rule("project.surface.read", system),
  "project.update": rule("project.surface.write", system),
  "project.archive": rule("project.surface.write", system),
  "project.member.add": rule("project.surface.write", system),
  "project.member.remove": rule("project.surface.write", system),
  "project.member.role": rule("project.surface.write", system),
  "project.agent.add": rule("project.surface.write", system),
  "project.agent.remove": rule("project.surface.write", system),
  "task.complete": { ...rule("project.surface.write", system), humanOnly: true },
  "collab.session.replay": rule("project.surface.read", system),
  "collab.trace.get": rule("project.surface.read", system),
  "collab.trace.list": rule("project.surface.read", system),
  "collab.chain.cancel": rule("project.surface.write", system),
  "identity.link.request": rule("identity.self.write", system),
  "identity.link.list": rule("identity.self.read", system),
  "identity.link.approve": rule("identity.self.write", system),
  "identity.link.decline": rule("identity.self.write", system),
  "identity.link.remove": rule("identity.self.write", system),
  "identity.principals": rule("identity.self.read", system),
  // R2 provider login (D110 AuthService): the installation owner's own credentials, people only.
  "auth.login.start": rule("auth.credentials.write", system),
  "auth.login.await": rule("auth.credentials.write", system),
  "auth.login.cancel": rule("auth.credentials.write", system),
  "auth.logout": rule("auth.credentials.write", system),
  "auth.credentials.list": rule("auth.credentials.read", system),
  "auth.status": rule("auth.credentials.read", system),
  // R3 channel management: Owner/Admin, people only. `channel.test` is a read; `--send-owner` additionally needs `channel.write` (checked in the handler).
  "channel.list": rule("channel.read", system),
  "channel.get": rule("channel.read", system),
  "channel.status": rule("channel.read", system),
  "channel.test": rule("channel.read", system),
  "channel.enable": rule("channel.write", system),
  "channel.disable": rule("channel.write", system),
  "channel.set": rule("channel.write", system),
  "channel.crypto": rule("channel.write", system),
  "agent.pause": rule("admin.agent.operate", agent),
  "agent.resume": rule("admin.agent.operate", agent),
  "agent.archive": rule("admin.agent.manage", agent),
  "agent.unarchive": rule("admin.agent.manage", agent),
  "agent.export": rule("admin.agent.manage", agent),
  "agent.delete": rule("admin.agent.delete", agent),
  "user.list": rule("admin.users.read", system),
  "user.role.set": rule("admin.users.write", system),
  "admin.api.person.resolve": { ...rule("admin.users.read", system), apiServiceOnly: true },
  "admin.api.invite.validate": { ...rule("admin.users.read", system), apiServiceOnly: true },
  "user.disable": { ...rule("admin.users.write", system), humanOnly: true },
  "user.enable": { ...rule("admin.users.write", system), humanOnly: true },
  "user.invite.create": rule("admin.users.write", system),
  "user.invite.list": rule("admin.users.read", system),
  "user.invite.revoke": rule("admin.users.write", system),
  "agent.rights.get": rule("admin.agent.rights", agent),
  "agent.rights.set": rule("admin.agent.rights", agent),
  "breakglass.request": rule("admin.breakglass.write", system),
  "breakglass.list": rule("admin.breakglass.read", system),
  "breakglass.revoke": rule("admin.breakglass.write", system),
  "breakglass.notices": rule("admin.notices.read", system),
  "session.model.get": rule("admin.sessions.transcript", system),
  "session.get": rule("admin.sessions.transcript", system),
  "session.resume": rule("admin.sessions.transcript", system),
  "session.events": rule("admin.sessions.transcript", system),
  "memory.curation.list": { ...rule("agent.manage", agent), humanOnly: true },
  "memory.curation.resolve": { ...rule("agent.manage", agent), humanOnly: true },
  "memory.list": rule("admin.memory.read", system),
  "memory.show": rule("admin.memory.read", system),
  "session.create": rule("admin.sessions.write", system),
  "session.submit": rule("admin.sessions.write", system),
  "session.model.set": { ...rule("admin.sessions.write", system), humanOnly: true },
  "session.cancel": rule("admin.sessions.write", system),
  "session.archive": rule("admin.sessions.write", system),
  "session.list": rule("admin.sessions.read", system),
  "admin.api.device.pair": { ...rule("admin.pairing.read", system), apiServiceOnly: true },
  "admin.api.device.challenge": { ...rule("admin.pairing.read", system), apiServiceOnly: true },
  "admin.api.device.prove": { ...rule("admin.pairing.read", system), apiServiceOnly: true },
  "admin.api.device.announce": { ...rule("admin.pairing.read", system), apiServiceOnly: true },
  "device.pair": rule("remote.device.write", system),
  "admin.api.desktop.redeem": { ...rule("admin.pairing.read", system), apiServiceOnly: true },
  "admin.api.desktop.token": { ...rule("admin.pairing.read", system), apiServiceOnly: true },
  "admin.api.desktop.resolve": { ...rule("admin.pairing.read", system), apiServiceOnly: true },
  "device.list": rule("device.list", system),
  "device.revoke": rule("device.revoke", system),
  "device.rename": rule("device.rename", system),
  "pairing.qr": rule("admin.pairing.read", system),
  "memory.forget": rule("memory.forget", agent),
  "agent.status": rule("agent.read", agent),
  "jobs.run": rule("jobs.run", system),
  "models.setOverride": rule("models.write", system),
  "models.removeManual": rule("models.write", system),
  "egress.status": rule("egress.read", system),
  "admin.obsidian.detect": rule("admin.obsidian.detect", system),
  "admin.obsidian.prepare": rule("admin.obsidian.prepare", system),
  "admin.obsidian.confirm": rule("admin.obsidian.confirm", system),
  "admin.migrate": rule("admin.migrate", system),
  "admin.embedding.probe": rule("admin.embedding.probe", system),
  "admin.embedding.serve": rule("admin.embedding.serve", system),
  "admin.embedding.check": rule("admin.embedding.check", system),
  "admin.reembed.plan": rule("admin.reembed.plan", system),
  "admin.reembed.run": rule("admin.reembed.run", system),
  "admin.reembed.status": rule("admin.reembed.status", system),
  "admin.reembed.abort": rule("admin.reembed.abort", system),
  // M1b-3 dreaming, classified by the nearest existing pattern: run-now like `jobs.run`, schedule edits like `settings.write`; the reads (status, log, schedule.get) stay open like `jobs.list|history`.
  "dreams.run": rule("jobs.run", system),
  "dreams.schedule.set": rule("settings.write", system),
  "dreams.enable": rule("settings.write", system),
  "dreams.disable": rule("settings.write", system),
  // Private diary: owner or agent.manage (member with manage). Viewer is denied; not dreaming.read.
  "dreams.diary": rule("agent.manage", agent),
  "admin.backup.snapshot": rule("admin.backup.snapshot", system),
  // D4: the protected log files, Owner/Admin.
  "logs.query": rule("logs.query", system),
  "logs.tail": rule("logs.query", system),
  "logs.levels": rule("logs.query", system),
  "audit.verify": rule("audit.read", system),
  // M3 identity (humans, linked channel identities, pairing): classified by the nearest existing pattern, `users.*` on the system resource.
  "identity.list": { ...rule("users.read", system), humanOnly: true },
  "identity.human.create": { ...rule("users.manage", system), humanOnly: true },
  "identity.link": { ...rule("users.manage", system), humanOnly: true },
  "identity.unlink": { ...rule("users.manage", system), humanOnly: true },
  "identity.pair.start": { ...rule("users.manage", system), humanOnly: true },
  "identity.pair.claim": { ...rule("users.manage", system), humanOnly: true },
  "identity.pair.confirm": { ...rule("users.manage", system), humanOnly: true },
  // D109 grants and approvals (spec 2026-09-28 §4): human-only actions, so an agent principal is refused in every state.
  "model.memory.status": { ...rule("settings.write", system), humanOnly: true },
  "model.licence.confirm": { ...rule("settings.write", system), humanOnly: true },
  "model.licence.list": { ...rule("settings.write", system), humanOnly: true },
  "model.licence.check": { ...rule("settings.write", system), humanOnly: true },
  "grant.list": rule("grant.read", system),
  "grant.get": rule("grant.read", system),
  "grant.create": rule("grant.write", system),
  "grant.revoke": rule("grant.write", system),
  "approval.list": rule("approval.read", system),
  "approval.get": rule("approval.read", system),
  "approval.verify": rule("approval.read", system),
  "approval.audit": rule("approval.read", system),
  "approval.decide": rule("approval.decide", system),
  "approval.cancel": rule("approval.decide", system),
  // M6-A (Arbeitspaket P): memory.recall (memory.workspace.read fallback to memory.*.read) and memory.capture (memory.*.write).
  "memory.recall": rule("memory.workspace.read", (params) => ({ kind: "memory", scope: "workspace", agentId: field(params, "agentId") })),
  "memory.capture": rule("memory.workspace.write", (params) => ({ kind: "memory", scope: "workspace", agentId: field(params, "agentId") })),
  // M6-A (Arbeitspaket P): memory.sensitivity.* (Festlegung 5)
  "memory.sensitivity.get": rule("memory.sensitivity.read", agent),
  "memory.sensitivity.set": rule("memory.sensitivity.write", agent),
  "memory.sensitivity.clear": rule("memory.sensitivity.write", agent),
  // M6-A (Arbeitspaket P): external.turn.* (M6A-A1.3)
  "external.turn.start": rule("agent.use", agent),
  "external.turn.events": rule("agent.read", agent),
  "external.turn.get": rule("agent.read", agent),
  "external.turn.cancel": rule("agent.use", agent),
});

function authorizeMemoryFallback(method: string, principal: Principal, params: unknown, ctx: CallContext, authCtx: AuthorizeContext): Decision | null {
  const agentId = field(params, "agentId") || (principal.binding?.agentId ?? "");
  if (method === "external.turn.start" || method === "external.turn.cancel") {
    if (principal.tokenScopes && (principal.tokenScopes.includes("a2a.task") || principal.tokenScopes.includes("mcp.write") || principal.tokenScopes.includes("mcp:call"))) {
      const { tokenScopes: _omit, ...noScope } = principal;
      const dec = authorize(noScope, "agent.use", { kind: "agent", agentId }, authCtx);
      if (dec.effect === "allow") return dec;
    }
  }
  if (method === "external.turn.events" || method === "external.turn.get") {
    if (principal.tokenScopes && (principal.tokenScopes.includes("a2a.task") || principal.tokenScopes.includes("mcp.read") || principal.tokenScopes.includes("mcp:call"))) {
      const { tokenScopes: _omit, ...noScope } = principal;
      const dec = authorize(noScope, "agent.read", { kind: "agent", agentId }, authCtx);
      if (dec.effect === "allow") return dec;
    }
  }
  if (method === "memory.recall") {
    if (isClientContext(ctx)) {
      const dec = authorize(principal, "agent.use", { kind: "agent", agentId }, authCtx);
      if (dec.effect === "allow") return dec;
    }
    const { tokenScopes: _omitRecall, ...noScopePrincipal } = principal;
    if (authorize(noScopePrincipal, "agent.use", { kind: "agent", agentId }, authCtx).effect !== "allow") return null;
    for (const [action, resource] of [
      ["memory.workspace.read", { kind: "memory", scope: "workspace", agentId }],
      ["memory.user.read", { kind: "memory", scope: "user", ownerUserId: principal.userId }],
      ["memory.agent-private.read", { kind: "memory", scope: "agent-private", agentId }],
    ] as const) {
      const dec = authorize(principal, action, resource, authCtx);
      if (dec.effect === "allow") return dec;
    }
    return null;
  }
  if (method === "memory.capture") {
    if (isClientContext(ctx)) {
      const dec = authorize(principal, "agent.use", { kind: "agent", agentId }, authCtx);
      if (dec.effect === "allow") return dec;
    }
    const { tokenScopes: _omitCapture, ...noScopeCapturePrincipal } = principal;
    if (authorize(noScopeCapturePrincipal, "agent.use", { kind: "agent", agentId }, authCtx).effect !== "allow") return null;
    for (const [action, resource] of [
      ["memory.user.write", { kind: "memory", scope: "user", ownerUserId: principal.userId }],
      ["memory.agent-private.write", { kind: "memory", scope: "agent-private", agentId }],
    ] as const) {
      const dec = authorize(principal, action, resource, authCtx);
      if (dec.effect === "allow") return dec;
    }
    return null;
  }
  return null;
}

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
      if (r.apiServiceOnly) {
        if (apiPrincipal(ctx) !== null) throw new RpcError("E_DENIED", "API service credential required", { reason: "api-service-only" });
        return inner(params, ctx);
      }
      let principal: Principal | null | undefined;
      try { principal = await o.resolve(ctx, method, params); }
      catch (e) {
        if (e instanceof RpcError && e.error === "E_DENIED" && e.reason === "person-disabled") throw e;
        record("rbac.unauthenticated", "anonymous", method, { action: r.action, reason: "resolver-failed" });
        throw new RpcError("E_UNAUTHORIZED", "authentication required", { reason: "resolver-failed" });
      }
      if (principal === null || principal === undefined) {
        record("rbac.unauthenticated", "anonymous", method, { action: r.action, reason: "no-principal" });
        throw new RpcError("E_UNAUTHORIZED", "authentication required", { reason: "no-principal" });
      }
      const authCtx: AuthorizeContext = { now: o.now() };
      let d = r.humanOnly && principal.kind !== "person"
        ? { effect: "deny" as const, reason: "agent-principal" as const }
        : authorize(principal, r.action, r.resource(params), authCtx);
      if (d.effect === "deny" && d.reason === "token-scope") {
        d = authorizeMemoryFallback(method, principal, params, ctx, authCtx) ?? d;
      }
      if (d.effect === "deny") {
        record("rbac.denied", typeof principal.userId === "string" && principal.userId !== "" ? principal.userId : "anonymous", method,
          { action: r.action, reason: d.reason, role: String(principal.role) });
        throw new RpcError("E_DENIED", `not permitted: ${r.action}`, { reason: d.reason });
      }
      authenticated.set(ctx, principal);
      try { return await inner(params, ctx); }
      finally { authenticated.delete(ctx); }
    };
  }
  return out;
}
