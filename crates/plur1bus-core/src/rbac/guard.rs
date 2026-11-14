//! `rbac/guard.ts`: the rule table of the core's RPC methods and the decision the guard makes before a handler runs
//! (P4-12 task 6). A library: nothing in the front door calls it yet; wrapping the handlers comes with the flip.
//!
//! [`RPC_RULES`] names, per method, the action it needs, whether only a person may call it, whether only the API service
//! itself may, and how its resource is built from the parameters. A method without a rule is not guarded. The vectors
//! under `fixtures/parity/rbac-guard/` (`scripts/parity/export-rbac-guard.ts`) hold the table as data and 16,677 decisions;
//! `guard_vectors.rs` replays them.
//!
//! The decision takes the principal as a [`Js`] value, as [`authorize_js`] does: a resolver can hand over anything, and
//! what the audit line says about a malformed principal (`String(principal.role)`) is part of the contract.
//! [`principal_js`] turns a typed [`Principal`] into that form.
use super::audit::{AuditEvent, AuditSink};
use super::authorize::{authorize_js, JsDecision};
use super::loose::Js;
use super::types::{DenyReason, Principal};
use serde_json::{json, Value};

/// Who may call a guarded method at all.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Caller {
    /// Whoever the action allows.
    Anyone,
    /// `humanOnly`: only a principal of kind `person`; anything else is refused as `agent-principal` in every state.
    Human,
    /// `apiServiceOnly`: only the credential-authenticated API service, without a browser or agent principal.
    Service,
}

/// How a rule builds its resource from the parameters. Whatever is missing or mistyped becomes "" and is denied.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuleResource {
    /// `{ kind: "system" }`.
    System,
    /// `{ kind: "agent", agentId: params.agentId }`.
    Agent,
    /// `{ kind: "memory", scope: "workspace", agentId: params.agentId }`.
    WorkspaceMemory,
}

/// `RpcRule`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RpcRule {
    /// The RPC method.
    pub method: &'static str,
    /// The action `authorize` is asked for.
    pub action: &'static str,
    /// Who may call it.
    pub caller: Caller,
    /// Its resource.
    pub resource: RuleResource,
}

const fn rule(
    method: &'static str,
    action: &'static str,
    caller: Caller,
    resource: RuleResource,
) -> RpcRule {
    RpcRule {
        method,
        action,
        caller,
        resource,
    }
}

use Caller::{Anyone, Human, Service};
use RuleResource::{Agent as A, System as S, WorkspaceMemory as W};

/// `RPC_RULES`, in the order of the TypeScript table.
pub const RPC_RULES: &[RpcRule] = &[
    rule("a2a.peer.add", "a2a.peers.manage", Human, S),
    rule("a2a.peer.list", "a2a.peers.manage", Human, S),
    rule("a2a.peer.remove", "a2a.peers.manage", Human, S),
    rule("a2a.peer.trust", "a2a.peers.manage", Human, S),
    rule("admin.import.detect", "imports.manage", Human, S),
    rule("admin.import.wsl.list", "imports.manage", Human, S),
    rule("admin.import.plan", "imports.manage", Human, S),
    rule("admin.import.preflight", "imports.manage", Human, S),
    rule("admin.import.skills", "imports.manage", Human, S),
    rule("admin.import.apply", "imports.manage", Human, S),
    rule("admin.import.status", "imports.manage", Human, S),
    rule("admin.import.abort", "imports.manage", Human, S),
    rule("admin.import.runs", "imports.manage", Human, S),
    rule("admin.import.rollback", "imports.manage", Human, S),
    rule("admin.import.ssh.key.status", "imports.read", Human, S),
    rule(
        "admin.import.ssh.connections.list",
        "imports.read",
        Human,
        S,
    ),
    rule("admin.import.ssh.key.generate", "imports.manage", Human, S),
    rule("admin.import.ssh.key.rotate", "imports.manage", Human, S),
    rule("admin.import.ssh.key.delete", "imports.manage", Human, S),
    rule(
        "admin.import.ssh.connections.set",
        "imports.manage",
        Human,
        S,
    ),
    rule(
        "admin.import.ssh.connections.delete",
        "imports.manage",
        Human,
        S,
    ),
    rule("admin.import.ssh.hostKey.probe", "imports.manage", Human, S),
    rule("admin.import.ssh.hostKey.trust", "imports.manage", Human, S),
    rule("ext.list", "extensions.read", Human, S),
    rule("ext.show", "extensions.read", Human, S),
    rule("ext.watch", "extensions.read", Human, S),
    rule("ext.inspection.get", "extensions.read", Human, S),
    rule("admin.extensions.setup.get", "extensions.read", Human, S),
    rule(
        "admin.extensions.runtime.status",
        "extensions.read",
        Human,
        S,
    ),
    rule("admin.extensions.auth.status", "extensions.read", Human, S),
    rule("ext.inspect", "extensions.manage", Human, S),
    rule("ext.install", "extensions.manage", Human, S),
    rule("ext.uninstall", "extensions.manage", Human, S),
    rule("ext.restore", "extensions.manage", Human, S),
    rule("ext.enable", "extensions.manage", Human, S),
    rule("ext.disable", "extensions.manage", Human, S),
    rule("admin.extensions.setup.set", "extensions.manage", Human, S),
    rule("admin.extensions.auth.start", "extensions.manage", Human, S),
    rule(
        "admin.extensions.auth.submit",
        "extensions.manage",
        Human,
        S,
    ),
    rule(
        "admin.extensions.auth.cancel",
        "extensions.manage",
        Human,
        S,
    ),
    rule(
        "admin.extensions.runtime.hold",
        "extensions.manage",
        Human,
        S,
    ),
    rule(
        "admin.extensions.runtime.release",
        "extensions.manage",
        Human,
        S,
    ),
    rule("secret.describe", "settings.write", Human, S),
    rule("secret.grants.list", "settings.read", Human, S),
    rule("delivery.target.list", "agent.list", Human, S),
    rule("delivery.target.add", "agent.list", Human, S),
    rule("delivery.target.confirm", "agent.list", Human, S),
    rule("delivery.target.remove", "agent.list", Human, S),
    rule("delivery.target.subscribe", "agent.list", Human, S),
    rule("channel.history.list", "chat:read", Human, S),
    rule("channel.history.get", "chat:read", Human, S),
    rule("channel.handoff.create", "chat:write", Human, S),
    rule("channel.handoff.redeem", "chat:write", Human, S),
    rule("chat.promote.links", "chat:read", Human, S),
    rule("chat.promote.preview", "chat:write", Human, S),
    rule("chat.promote.commit", "chat:write", Human, S),
    rule("events.subscribe", "agent.list", Anyone, S),
    rule("voice.session.create", "agent.use", Human, A),
    rule("decision.status", "settings.read", Human, S),
    rule("decision.test", "settings.write", Human, S),
    rule("admin.engine.test", "settings.write", Human, S),
    rule("models.test", "settings.write", Human, S),
    rule("budget.set", "settings.write", Human, S),
    rule("chat.create", "chat:write", Anyone, S),
    rule("chat.list", "chat:read", Anyone, S),
    rule("chat.get", "chat:read", Anyone, S),
    rule("chat.events", "chat:read", Anyone, S),
    rule("chat.submit", "chat:write", Anyone, S),
    rule("chat.update", "chat:write", Anyone, S),
    rule("chat.archive", "chat:write", Anyone, S),
    rule("chat.restore", "chat:write", Anyone, S),
    rule("chat.cancel", "chat:write", Anyone, S),
    rule("chat.rewind", "chat:write", Human, S),
    rule("chat.fork", "chat:write", Anyone, S),
    rule("chat.delete", "chat:delete", Anyone, S),
    rule("chat.export", "chat:read", Anyone, S),
    rule("chat.model.get", "chat:read", Anyone, S),
    rule("chat.model.set", "chat:write", Human, S),
    rule("jobs.create", "agent.manage", Human, A),
    rule("jobs.update", "agent.list", Human, S),
    rule("jobs.delete", "agent.list", Human, S),
    rule("doctor.report", "agent.list", Human, S),
    rule("telemetry.cache.summary", "doctor.read", Human, S),
    rule("agent.activity.list", "agent.list", Human, S),
    rule("inbox.list", "inbox.read", Anyone, S),
    rule("inbox.count", "inbox.read", Anyone, S),
    rule("inbox.markRead", "inbox.write", Anyone, S),
    rule("inbox.dismiss", "inbox.write", Anyone, S),
    rule("project.column.list", "project.board.read", Anyone, S),
    rule("project.card.list", "project.board.read", Anyone, S),
    rule("project.card.get", "project.board.read", Anyone, S),
    rule("project.card.comment.list", "project.board.read", Anyone, S),
    rule(
        "project.card.activity.list",
        "project.board.read",
        Anyone,
        S,
    ),
    rule("project.column.create", "project.board.manage", Anyone, S),
    rule("project.column.update", "project.board.manage", Anyone, S),
    rule("project.column.move", "project.board.manage", Anyone, S),
    rule("project.column.delete", "project.board.manage", Anyone, S),
    rule("project.card.create", "project.board.write", Anyone, S),
    rule("project.card.update", "project.board.write", Anyone, S),
    rule("project.card.assign", "project.board.write", Anyone, S),
    rule("project.card.unassign", "project.board.write", Anyone, S),
    rule("project.card.archive", "project.board.write", Anyone, S),
    rule("project.card.unarchive", "project.board.write", Anyone, S),
    rule("project.card.move", "project.board.move", Anyone, S),
    rule(
        "project.card.comment.add",
        "project.board.comment",
        Anyone,
        S,
    ),
    rule("media.preferences.get", "media.read", Anyone, S),
    rule("media.preferences.set", "media.write", Anyone, S),
    rule("media.generate", "media.write", Anyone, S),
    rule("media.edit", "media.write", Anyone, S),
    rule("media.job.get", "media.read", Anyone, S),
    rule("media.job.cancel", "media.write", Anyone, S),
    rule("media.job.list", "media.read", Anyone, S),
    rule("media.output.get", "media.read", Anyone, S),
    rule("media.output.list", "media.read", Anyone, S),
    rule("media.output.delete", "media.write", Anyone, S),
    rule("media.adapters.list", "media.read", Anyone, S),
    rule("media.search", "media.index.read", Anyone, S),
    rule("media.index.status", "media.index.read", Anyone, S),
    rule("media.index.pause", "media.index.operate", Anyone, S),
    rule("media.index.resume", "media.index.operate", Anyone, S),
    rule("media.index.reindex", "media.index.operate", Anyone, S),
    rule("media.caption.set", "media.caption.write", Anyone, S),
    rule("team.get", "team.surface.read", Human, S),
    rule("team.list", "team.surface.read", Human, S),
    rule("team.create", "team.surface.write", Human, S),
    rule("team.composition.confirm", "team.surface.write", Human, S),
    rule("team.plan.approve", "team.surface.write", Human, S),
    rule("team.scope.extend", "team.surface.write", Human, S),
    rule("team.pause", "team.surface.write", Human, S),
    rule("team.resume", "team.surface.write", Human, S),
    rule("team.cancel", "team.surface.write", Human, S),
    rule("team.package.reassign", "team.surface.write", Human, S),
    rule("team.package.budget.set", "team.surface.write", Human, S),
    rule("team.budget.set", "team.surface.write", Human, S),
    rule("team.package.sync.set", "team.surface.write", Human, S),
    rule("project.create", "project.create", Anyone, S),
    rule("project.get", "project.surface.read", Anyone, S),
    rule("project.list", "project.surface.read", Anyone, S),
    rule("project.update", "project.surface.write", Anyone, S),
    rule("project.archive", "project.surface.write", Anyone, S),
    rule("project.member.add", "project.surface.write", Anyone, S),
    rule("project.member.remove", "project.surface.write", Anyone, S),
    rule("project.member.role", "project.surface.write", Anyone, S),
    rule("project.agent.add", "project.surface.write", Anyone, S),
    rule("project.agent.remove", "project.surface.write", Anyone, S),
    rule("project.repo.bind", "project.surface.write", Human, S),
    rule("project.repo.unbind", "project.surface.write", Human, S),
    rule("task.complete", "project.surface.write", Human, S),
    rule("collab.session.replay", "project.surface.read", Anyone, S),
    rule("collab.trace.get", "project.surface.read", Anyone, S),
    rule("collab.trace.list", "project.surface.read", Anyone, S),
    rule("collab.chain.cancel", "project.surface.write", Anyone, S),
    rule("identity.link.request", "identity.self.write", Anyone, S),
    rule("identity.link.list", "identity.self.read", Anyone, S),
    rule("identity.link.approve", "identity.self.write", Anyone, S),
    rule("identity.link.decline", "identity.self.write", Anyone, S),
    rule("identity.link.remove", "identity.self.write", Anyone, S),
    rule("identity.principals", "identity.self.read", Anyone, S),
    rule("auth.login.start", "auth.credentials.write", Anyone, S),
    rule("auth.login.await", "auth.credentials.write", Anyone, S),
    rule("auth.login.cancel", "auth.credentials.write", Anyone, S),
    rule("auth.logout", "auth.credentials.write", Anyone, S),
    rule("auth.credentials.list", "auth.credentials.read", Anyone, S),
    rule("auth.status", "auth.credentials.read", Anyone, S),
    rule("channel.list", "channel.read", Anyone, S),
    rule("channel.get", "channel.read", Anyone, S),
    rule("channel.status", "channel.read", Anyone, S),
    rule("channel.test", "channel.read", Anyone, S),
    rule("channel.enable", "channel.write", Anyone, S),
    rule("channel.disable", "channel.write", Anyone, S),
    rule("channel.set", "channel.write", Anyone, S),
    rule("channel.crypto", "channel.write", Anyone, S),
    rule("agent.pause", "admin.agent.operate", Anyone, A),
    rule("agent.resume", "admin.agent.operate", Anyone, A),
    rule("agent.archive", "admin.agent.manage", Anyone, A),
    rule("agent.unarchive", "admin.agent.manage", Anyone, A),
    rule("agent.export", "admin.agent.manage", Anyone, A),
    rule("agent.delete", "admin.agent.delete", Anyone, A),
    rule("user.list", "admin.users.read", Anyone, S),
    rule("user.role.set", "admin.users.write", Anyone, S),
    rule("admin.api.person.resolve", "admin.users.read", Service, S),
    rule("admin.api.invite.validate", "admin.users.read", Service, S),
    rule("user.disable", "admin.users.write", Human, S),
    rule("user.enable", "admin.users.write", Human, S),
    rule("user.invite.create", "admin.users.write", Anyone, S),
    rule("user.invite.list", "admin.users.read", Anyone, S),
    rule("user.invite.revoke", "admin.users.write", Anyone, S),
    rule("agent.rights.get", "admin.agent.rights", Anyone, A),
    rule("agent.rights.set", "admin.agent.rights", Anyone, A),
    rule("breakglass.request", "admin.breakglass.write", Anyone, S),
    rule("breakglass.list", "admin.breakglass.read", Anyone, S),
    rule("breakglass.revoke", "admin.breakglass.write", Anyone, S),
    rule("breakglass.notices", "admin.notices.read", Anyone, S),
    rule("code.session.open", "admin.sessions.write", Human, S),
    rule("code.session.mode", "admin.sessions.write", Human, S),
    rule("code.session.check", "admin.sessions.write", Human, S),
    rule("code.session.diff", "admin.sessions.transcript", Human, S),
    rule("session.model.get", "admin.sessions.transcript", Anyone, S),
    rule("session.get", "admin.sessions.transcript", Anyone, S),
    rule("session.resume", "admin.sessions.transcript", Anyone, S),
    rule("session.events", "admin.sessions.transcript", Anyone, S),
    rule("memory.curation.list", "agent.manage", Human, A),
    rule("memory.curation.resolve", "agent.manage", Human, A),
    rule("memory.list", "admin.memory.read", Anyone, S),
    rule("memory.show", "admin.memory.read", Anyone, S),
    rule("memory.importText.preview", "imports.manage", Human, S),
    rule("memory.importText.apply", "imports.manage", Human, S),
    rule("memory.importText.rollback", "imports.manage", Human, S),
    rule("memory.exportText", "admin.memory.read", Human, S),
    rule("session.create", "admin.sessions.write", Anyone, S),
    rule("session.submit", "admin.sessions.write", Anyone, S),
    rule("session.model.set", "admin.sessions.write", Human, S),
    rule("session.cancel", "admin.sessions.write", Anyone, S),
    rule("session.rewind", "admin.sessions.write", Human, S),
    rule("session.archive", "admin.sessions.write", Anyone, S),
    rule("session.list", "admin.sessions.read", Anyone, S),
    rule("admin.api.device.pair", "admin.pairing.read", Service, S),
    rule(
        "admin.api.device.challenge",
        "admin.pairing.read",
        Service,
        S,
    ),
    rule("admin.api.device.prove", "admin.pairing.read", Service, S),
    rule(
        "admin.api.device.announce",
        "admin.pairing.read",
        Service,
        S,
    ),
    rule("device.pair", "remote.device.write", Anyone, S),
    rule("admin.api.desktop.redeem", "admin.pairing.read", Service, S),
    rule("admin.api.desktop.token", "admin.pairing.read", Service, S),
    rule(
        "admin.api.desktop.resolve",
        "admin.pairing.read",
        Service,
        S,
    ),
    rule("device.list", "device.list", Anyone, S),
    rule("device.revoke", "device.revoke", Anyone, S),
    rule("device.rename", "device.rename", Anyone, S),
    rule("pairing.qr", "admin.pairing.read", Anyone, S),
    rule("memory.forget", "memory.forget", Anyone, A),
    rule("agent.status", "agent.read", Anyone, A),
    rule("jobs.run", "jobs.run", Anyone, S),
    rule("models.setOverride", "models.write", Anyone, S),
    rule("models.removeManual", "models.write", Anyone, S),
    rule("egress.status", "egress.read", Anyone, S),
    rule("admin.obsidian.detect", "admin.obsidian.detect", Anyone, S),
    rule(
        "admin.obsidian.prepare",
        "admin.obsidian.prepare",
        Anyone,
        S,
    ),
    rule(
        "admin.obsidian.confirm",
        "admin.obsidian.confirm",
        Anyone,
        S,
    ),
    rule("admin.migrate", "admin.migrate", Anyone, S),
    rule("admin.embedding.probe", "admin.embedding.probe", Anyone, S),
    rule("admin.embedding.serve", "admin.embedding.serve", Anyone, S),
    rule("admin.embedding.check", "admin.embedding.check", Anyone, S),
    rule("admin.reembed.plan", "admin.reembed.plan", Anyone, S),
    rule("admin.reembed.run", "admin.reembed.run", Anyone, S),
    rule("admin.reembed.status", "admin.reembed.status", Anyone, S),
    rule("admin.reembed.abort", "admin.reembed.abort", Anyone, S),
    rule("dreams.learn.run", "jobs.run", Human, S),
    rule("dreams.learn.status", "agent.list", Human, S),
    rule("dreams.learn.list", "agent.list", Human, S),
    rule("dreams.learn.get", "agent.list", Human, S),
    rule("dreams.learn.decide", "agent.list", Human, S),
    rule("dreams.learn.rollback", "agent.list", Human, S),
    rule("dreams.learn.calibration", "agent.list", Human, S),
    rule("dreams.run", "jobs.run", Anyone, S),
    rule("dreams.schedule.set", "settings.write", Anyone, S),
    rule("dreams.enable", "settings.write", Anyone, S),
    rule("dreams.disable", "settings.write", Anyone, S),
    rule("dreams.diary", "agent.manage", Anyone, A),
    rule("admin.backup.snapshot", "admin.backup.snapshot", Anyone, S),
    rule("logs.query", "logs.query", Anyone, S),
    rule("logs.tail", "logs.query", Anyone, S),
    rule("logs.levels", "logs.query", Anyone, S),
    rule("audit.verify", "audit.read", Anyone, S),
    rule("identity.list", "users.read", Human, S),
    rule("identity.human.create", "users.manage", Human, S),
    rule("identity.link", "users.manage", Human, S),
    rule("identity.unlink", "users.manage", Human, S),
    rule("identity.pair.start", "users.manage", Human, S),
    rule("identity.pair.claim", "users.manage", Human, S),
    rule("identity.pair.confirm", "users.manage", Human, S),
    rule("model.memory.status", "settings.write", Human, S),
    rule("model.licence.confirm", "settings.write", Human, S),
    rule("model.licence.list", "settings.write", Human, S),
    rule("model.licence.check", "settings.write", Human, S),
    rule("grant.list", "grant.read", Anyone, S),
    rule("grant.get", "grant.read", Anyone, S),
    rule("grant.create", "grant.write", Anyone, S),
    rule("grant.revoke", "grant.write", Anyone, S),
    rule("approval.list", "approval.read", Anyone, S),
    rule("approval.get", "approval.read", Anyone, S),
    rule("approval.verify", "approval.read", Anyone, S),
    rule("approval.audit", "approval.read", Anyone, S),
    rule("approval.decide", "approval.decide", Anyone, S),
    rule("approval.cancel", "approval.decide", Anyone, S),
    rule("memory.recall", "memory.workspace.read", Anyone, W),
    rule("memory.capture", "memory.workspace.write", Anyone, W),
    rule(
        "memory.sensitivity.get",
        "memory.sensitivity.read",
        Anyone,
        A,
    ),
    rule(
        "memory.sensitivity.set",
        "memory.sensitivity.write",
        Anyone,
        A,
    ),
    rule(
        "memory.sensitivity.clear",
        "memory.sensitivity.write",
        Anyone,
        A,
    ),
    rule("external.turn.start", "agent.use", Anyone, A),
    rule("external.turn.events", "agent.read", Anyone, A),
    rule("external.turn.get", "agent.read", Anyone, A),
    rule("external.turn.cancel", "agent.use", Anyone, A),
];

/// The rule of a method, if it has one.
pub fn rule_for(method: &str) -> Option<&'static RpcRule> {
    RPC_RULES.iter().find(|r| r.method == method)
}

/// `field(params, key)`: an own string member of an object, "" for everything else.
fn field(params: Option<&Value>, key: &str) -> String {
    match params {
        Some(Value::Object(map)) => map
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
        _ => String::new(),
    }
}

fn obj(members: &[(&str, Js)]) -> Js {
    Js::Obj(
        members
            .iter()
            .map(|(k, v)| ((*k).to_owned(), v.clone()))
            .collect(),
    )
}
fn text(s: &str) -> Js {
    Js::Str(s.to_owned())
}
fn agent_resource(agent_id: Js) -> Js {
    obj(&[("kind", text("agent")), ("agentId", agent_id)])
}
fn agent_memory(scope: &str, agent_id: Js) -> Js {
    obj(&[
        ("kind", text("memory")),
        ("scope", text(scope)),
        ("agentId", agent_id),
    ])
}
fn user_memory(owner: Js) -> Js {
    obj(&[
        ("kind", text("memory")),
        ("scope", text("user")),
        ("ownerUserId", owner),
    ])
}

impl RuleResource {
    /// The resource of a call with these parameters, as the value `authorize` reads.
    pub fn build(self, params: Option<&Value>) -> Js {
        match self {
            RuleResource::System => obj(&[("kind", text("system"))]),
            RuleResource::Agent => agent_resource(Js::Str(field(params, "agentId"))),
            RuleResource::WorkspaceMemory => {
                agent_memory("workspace", Js::Str(field(params, "agentId")))
            }
        }
    }
}

/// `LOCAL_OWNER` (ruling R8 of the TypeScript guard): a connection that passed the core's own token handshake is the
/// installation owner.
pub fn local_owner() -> Principal {
    let mut p = Principal::new("local-owner", super::types::Role::Owner);
    p.kind = Some(super::types::PrincipalKind::Person);
    p
}

/// A typed principal as the value the guard and `authorize` read. `binding_agent_id` is the agent an API token is bound
/// to (`principal.binding.agentId`), which the memory fallback reads when the parameters name no agent.
pub fn principal_js(p: &Principal, binding_agent_id: Option<&str>) -> Js {
    let mut out = vec![("userId".to_owned(), text(&p.user_id))];
    if let Some(kind) = p.kind {
        out.push(("kind".to_owned(), text(kind.as_str())));
    }
    out.push(("role".to_owned(), text(p.role.as_str())));
    if let Some(rights) = &p.agent_rights {
        out.push((
            "agentRights".to_owned(),
            Js::Obj(
                rights
                    .iter()
                    .map(|(k, r)| (k.clone(), text(r.as_str())))
                    .collect(),
            ),
        ));
    }
    if let Some(rights) = &p.project_rights {
        out.push((
            "projectRights".to_owned(),
            Js::Obj(
                rights
                    .iter()
                    .map(|(k, r)| (k.clone(), text(r.as_str())))
                    .collect(),
            ),
        ));
    }
    if let Some(scopes) = &p.token_scopes {
        out.push((
            "tokenScopes".to_owned(),
            Js::Arr(scopes.iter().map(|s| text(s)).collect()),
        ));
    }
    if let Some(agent) = binding_agent_id {
        out.push(("binding".to_owned(), obj(&[("agentId", text(agent))])));
    }
    if let Some(grants) = &p.break_glass {
        let grant = |g: &super::types::BreakGlassGrant| {
            let mut m = vec![
                ("id", text(&g.id)),
                ("holderUserId", text(&g.holder_user_id)),
                ("targetUserId", text(&g.target_user_id)),
                ("reason", text(&g.reason)),
                ("issuedAt", Js::Num(g.issued_at)),
                ("expiresAt", Js::Num(g.expires_at)),
            ];
            if let Some(at) = g.revoked_at {
                m.push(("revokedAt", Js::Num(at)));
            }
            obj(&m)
        };
        out.push((
            "breakGlass".to_owned(),
            Js::Arr(grants.iter().map(grant).collect()),
        ));
    }
    Js::Obj(out)
}

/// What the principal resolver of a call answered.
#[derive(Clone, Debug, PartialEq)]
pub enum Resolved<'a> {
    /// A principal (of whatever shape).
    Principal(&'a Js),
    /// Nobody: `null` or `undefined`.
    Nobody,
    /// The resolver failed.
    Failed,
    /// The resolver refused a disabled person (`E_DENIED`, reason `person-disabled`): passed on as it is, with its message.
    Disabled(&'a str),
}

/// What the server established about the call's context; request text can set none of it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CallFacts {
    /// The call came over a scoped IPC client context (`isClientContext`).
    pub client: bool,
    /// The call's API identity.
    pub api: ApiContext,
}

/// `apiPrincipal(ctx)`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ApiContext {
    /// Not an API call (`undefined`).
    #[default]
    NotApi,
    /// The API service itself, with its own credential and no principal (`null`).
    Service,
    /// The API service on behalf of a browser or agent principal.
    Principal,
}

/// A refusal: the `RpcError` the caller gets.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
    /// `E_DENIED` or `E_UNAUTHORIZED`.
    pub code: &'static str,
    /// The message.
    pub message: String,
    /// `data.reason`.
    pub reason: String,
}

/// What the guard decided for one call.
#[derive(Clone, Debug, PartialEq)]
pub struct GuardDecision {
    /// `Ok`: the handler runs (for a principal, that principal is the call's authenticated identity). `Err`: it does not.
    pub outcome: Result<(), Refusal>,
    /// The audit event of a denial or an unauthenticated call. Recording it may fail without changing the outcome.
    pub audit: Option<AuditEvent>,
}

fn refused(code: &'static str, message: impl Into<String>, reason: &str) -> Result<(), Refusal> {
    Err(Refusal {
        code,
        message: message.into(),
        reason: reason.to_owned(),
    })
}

fn event(
    now: i64,
    host: &str,
    action: &str,
    user: &str,
    target: &str,
    detail: Vec<(&str, Value)>,
) -> AuditEvent {
    AuditEvent {
        at: now,
        user: user.to_owned(),
        host: host.to_owned(),
        action: action.to_owned(),
        target: target.to_owned(),
        detail: detail.into_iter().map(|(k, v)| (k.to_owned(), v)).collect(),
    }
}

/// `authorize` for the guard. A principal on which TypeScript's `authorize` throws (a `null` rights table, scopes that are
/// not an array) is denied as invalid here: fail closed, where the TypeScript guard lets the `TypeError` through.
fn decide(principal: &Js, action: &str, resource: &Js, ctx: &Js) -> JsDecision {
    authorize_js(principal, &text(action), resource, ctx).unwrap_or(JsDecision::Deny {
        reason: DenyReason::InvalidPrincipal,
    })
}

/// `{ tokenScopes: _, ...rest } = principal`.
fn without_scopes(principal: &Js) -> Js {
    match principal {
        Js::Obj(members) => Js::Obj(
            members
                .iter()
                .filter(|(k, _)| k != "tokenScopes")
                .cloned()
                .collect(),
        ),
        other => other.clone(),
    }
}

/// `principal.tokenScopes && scopes.some(s => principal.tokenScopes.includes(s))`.
fn has_scope(principal: &Js, any_of: &[&str]) -> bool {
    match principal.get("tokenScopes") {
        Js::Arr(list) => list
            .iter()
            .any(|s| s.as_str().is_some_and(|s| any_of.contains(&s))),
        _ => false,
    }
}

/// `authorizeMemoryFallback`: what a token whose scopes do not name the rule's action may still do. An external turn with
/// an A2A or MCP scope counts as using (or reading) the agent; recall and capture over a scoped client context count as
/// using the agent, and otherwise need the right to use the agent and one of the memory scopes.
fn memory_fallback(
    method: &str,
    principal: &Js,
    params: Option<&Value>,
    facts: &CallFacts,
    ctx: &Js,
) -> Option<JsDecision> {
    let named = field(params, "agentId");
    let agent_id = if named.is_empty() {
        match principal.get("binding") {
            Js::Undefined | Js::Null => Js::Str(String::new()),
            binding => match binding.get("agentId") {
                Js::Undefined | Js::Null => Js::Str(String::new()),
                id => id.clone(),
            },
        }
    } else {
        Js::Str(named)
    };
    let agent = agent_resource(agent_id.clone());
    let allowed = |d: JsDecision| d.is_allow().then_some(d);
    let turn = |scopes: &[&str], action: &str| {
        if has_scope(principal, scopes) {
            allowed(decide(&without_scopes(principal), action, &agent, ctx))
        } else {
            None
        }
    };
    match method {
        "external.turn.start" | "external.turn.cancel" => {
            turn(&["a2a.task", "mcp.write", "mcp:call"], "agent.use")
        }
        "external.turn.events" | "external.turn.get" => {
            turn(&["a2a.task", "mcp.read", "mcp:call"], "agent.read")
        }
        "memory.recall" | "memory.capture" => {
            if facts.client {
                if let Some(d) = allowed(decide(principal, "agent.use", &agent, ctx)) {
                    return Some(d);
                }
            }
            if !decide(&without_scopes(principal), "agent.use", &agent, ctx).is_allow() {
                return None;
            }
            let own = user_memory(principal.get("userId").clone());
            let candidates: Vec<(&str, Js)> = if method == "memory.recall" {
                vec![
                    (
                        "memory.workspace.read",
                        agent_memory("workspace", agent_id.clone()),
                    ),
                    ("memory.user.read", own),
                    (
                        "memory.agent-private.read",
                        agent_memory("agent-private", agent_id.clone()),
                    ),
                ]
            } else {
                vec![
                    ("memory.user.write", own),
                    (
                        "memory.agent-private.write",
                        agent_memory("agent-private", agent_id.clone()),
                    ),
                ]
            };
            candidates
                .into_iter()
                .find_map(|(action, resource)| allowed(decide(principal, action, &resource, ctx)))
        }
        _ => None,
    }
}

/// The guard's decision for one call of `method`; `None` when the method has no rule (it is not guarded).
pub fn guard(
    method: &str,
    resolved: &Resolved<'_>,
    params: Option<&Value>,
    facts: &CallFacts,
    now: i64,
    host: &str,
) -> Option<GuardDecision> {
    let r = rule_for(method)?;
    if r.caller == Service {
        let outcome = if facts.api == ApiContext::Service {
            Ok(())
        } else {
            refused(
                "E_DENIED",
                "API service credential required",
                "api-service-only",
            )
        };
        return Some(GuardDecision {
            outcome,
            audit: None,
        });
    }
    let unauthenticated = |reason: &str| GuardDecision {
        outcome: refused("E_UNAUTHORIZED", "authentication required", reason),
        audit: Some(event(
            now,
            host,
            "rbac.unauthenticated",
            "anonymous",
            method,
            vec![("action", json!(r.action)), ("reason", json!(reason))],
        )),
    };
    let principal = match resolved {
        Resolved::Disabled(message) => {
            return Some(GuardDecision {
                outcome: refused("E_DENIED", *message, "person-disabled"),
                audit: None,
            })
        }
        Resolved::Failed => return Some(unauthenticated("resolver-failed")),
        Resolved::Nobody | Resolved::Principal(Js::Null | Js::Undefined) => {
            return Some(unauthenticated("no-principal"))
        }
        Resolved::Principal(p) => *p,
    };
    let ctx = obj(&[("now", Js::Num(now as f64))]);
    let mut d = if r.caller == Human && principal.get("kind").as_str() != Some("person") {
        JsDecision::Deny {
            reason: DenyReason::AgentPrincipal,
        }
    } else {
        decide(principal, r.action, &r.resource.build(params), &ctx)
    };
    if matches!(
        d,
        JsDecision::Deny {
            reason: DenyReason::TokenScope
        }
    ) {
        if let Some(fallback) = memory_fallback(method, principal, params, facts, &ctx) {
            d = fallback;
        }
    }
    Some(match d {
        JsDecision::Allow { .. } => GuardDecision {
            outcome: Ok(()),
            audit: None,
        },
        JsDecision::Deny { reason } => {
            let user = principal
                .get("userId")
                .as_str()
                .filter(|u| !u.is_empty())
                .unwrap_or("anonymous");
            GuardDecision {
                outcome: refused(
                    "E_DENIED",
                    format!("not permitted: {}", r.action),
                    reason.as_str(),
                ),
                audit: Some(event(
                    now,
                    host,
                    "rbac.denied",
                    user,
                    method,
                    vec![
                        ("action", json!(r.action)),
                        ("reason", json!(reason.as_str())),
                        ("role", json!(principal.get("role").to_js_string())),
                    ],
                )),
            }
        }
    })
}

/// Hands a decision's audit event to the sink. Its failure never changes an outcome: the refusal stands.
pub fn record(decision: &GuardDecision, sink: &mut dyn AuditSink) {
    if let Some(event) = &decision.audit {
        let _ = sink.append(event);
    }
}
