//! Human coding bindings, D109 folder authority and connection-local ACP modes.
use super::surface::{member_principal, WorktreeBindings};
use crate::approvals::js_json::J;
use crate::budget::{Clock, IdSource};
use crate::collab::board::CardFields;
use crate::collab::service::CollabService;
use crate::collab::{CollabError, CollabErrorCode as C};
use crate::identity::principals::derive_user_principal;
use crate::logs::methods::AbortSignal;
use crate::policy::decide::{decide, Clock as PolicyClock, Decision, Via};
use crate::policy::{decide::GrantSource, fs_paths::CanonicalPath};
use crate::rbac::audit::{AuditEvent, AuditSink};
use crate::rbac::authorize::authorize;
use crate::rbac::types::{AuthorizeContext, Principal, PrincipalKind, Resource};
use crate::sessions::store::SessionStore;
use crate::sessions::{
    CreateSessionInput, ErrorCode, MemoryMode, SessionError, SessionKind, SessionRecord,
    WorktreeBinding,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

type R<T> = Result<T, CollabError>;

/// Resolves a worktree through the host's D109 policy and read-only Git port.
pub trait CodeRoots {
    /// Checks current filesystem and Git identity for this agent.
    fn root(&self, agent: &str, path: &str) -> R<CanonicalPath>;
    /// Current branch name, if attached.
    fn branch(&self, root: &str) -> Option<String>;
}

/// Connection and caller facts certified by dispatch.
pub struct CodeConnection<'a> {
    /// Authenticated connection.
    pub id: &'a str,
    /// Linked caller identity resolved by the host.
    pub caller: &'a str,
    /// Local interactive CLI can request approval for a new root.
    pub local_cli: bool,
    /// Approval surface trust level.
    pub surface: u8,
    /// Aborts open, grant wait or mode selection.
    pub abort: &'a AbortSignal,
}

/// Request to bind an existing or new session.
#[derive(Clone, Copy)]
pub struct CodeOpen<'a> {
    /// Agent with live use rights.
    pub agent: &'a str,
    /// Requested worktree root.
    pub root: &'a str,
    /// Existing session to reopen.
    pub session: Option<&'a str>,
    /// Optional project/card binding, jointly present.
    pub card: Option<(&'a str, &'a str)>,
    /// Session memory mode.
    pub memory: Option<MemoryMode>,
    /// Whether a person is available on this connection.
    pub interactive: Option<bool>,
}

/// Trusted folder request coupled to the actual session and presence.
pub struct FolderRequest<'a> {
    /// Canonical worktree.
    pub root: &'a str,
    /// Authenticated person.
    pub person: &'a str,
    /// Agent bound to the session.
    pub agent: &'a str,
    /// Owning session.
    pub session: &'a str,
    /// Optional project context.
    pub project: Option<&'a str>,
    /// Trust level from the connection.
    pub surface: u8,
    /// The live presence checked by the approval service before any effect.
    pub lease: PresenceLease,
}

/// Opaque liveness of the connection/session pair.
#[derive(Clone)]
pub struct PresenceLease(Arc<AtomicBool>, AbortSignal);

impl PresenceLease {
    /// True while the registered presence remains active and connected.
    pub fn active(&self) -> bool {
        self.0.load(Ordering::Acquire) && !self.1.is_aborted()
    }
}

/// Trusted identity, approval and grant lifecycle ports. Folder requests must use the approval service.
pub trait CodingAuthority: GrantSource {
    /// Whether the agent is currently registered.
    fn agent_active(&self, agent: &str) -> bool;
    /// Authorizes the caller identity linked to the authenticated person.
    fn linked_caller(&self, person: &Principal, caller: &str) -> bool;
    /// Optional legacy owner name, only if the caller link was verified.
    fn legacy_owner(&self, _person: &Principal, _caller: &str) -> Option<String> {
        None
    }
    /// Resolve the currently authenticated person for a later turn.
    fn resolve_person(&self, person: &str) -> Option<Principal>;
    /// Request an approval without granting a capability.
    fn request_folder(&mut self, request: FolderRequest<'_>) -> R<String>;
    /// Check whether the existing folder request is still pending.
    fn folder_pending(&self, id: &str, person: &str) -> bool;
    /// Withdraw an outstanding request.
    fn cancel_folder(&mut self, id: &str, person: &str);
    /// End task-bound authority.
    fn end_task(&mut self, id: &str);
    /// End authority for a volatile session at core close.
    fn end_session(&mut self, _id: &str) {}
}

/// Injected services used by coding sessions.
pub struct SessionPorts<'a> {
    /// Folder and Git identity.
    pub roots: &'a dyn CodeRoots,
    /// Verified authority and grant source.
    pub authority: &'a mut dyn CodingAuthority,
    /// Optional collaboration board and worktree registry.
    pub project: Option<(&'a CollabService, &'a dyn WorktreeBindings)>,
    /// Current time.
    pub clock: &'a dyn Clock,
    /// Task IDs.
    pub ids: &'a dyn IdSource,
    /// Audit sink for bindings and mode updates.
    pub audit: &'a mut dyn AuditSink,
}

/// Connection-scoped profile.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// Ordinary ACP chat.
    Chat,
    /// Coding tools and prompt.
    Coding,
}

impl Mode {
    /// Wire name.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::Coding => "coding",
        }
    }
}

/// The effect of opening a coding session.
pub enum OpenState {
    /// Binding awaits explicit consent.
    GrantRequired(String),
    /// The verified binding is established.
    Open,
}

/// Session state returned by open.
pub struct Opened {
    /// Result of the open.
    pub state: OpenState,
    /// Owning session.
    pub session: SessionRecord,
    /// Canonical worktree.
    pub root: String,
    /// Current Git branch when attached.
    pub branch: Option<String>,
    /// Last event sequence.
    pub last_event_seq: i64,
    /// Active turn if the session already runs one.
    pub running_turn: Option<String>,
}

/// Authorized current access to a bound coding session.
pub struct RootAccess {
    /// Owning session.
    pub session: SessionRecord,
    /// Immutable binding.
    pub binding: WorktreeBinding,
    /// Fresh D109 canonical scope.
    pub root: CanonicalPath,
}

/// Effective approver view for a future turn on one connection.
pub struct Approver {
    /// Presence task id.
    pub task: Option<String>,
    /// Captured profile.
    pub mode: Option<Mode>,
    /// Surface trust, lowered to zero for noninteractive presence.
    pub surface: u8,
}

/// Trusted turn context used during coding profile selection.
pub struct CodeTurn<'a> {
    /// Stored session identifier.
    pub session: &'a str,
    /// Principal hash already established by the transport.
    pub owner: &'a str,
    /// Active agent for the turn.
    pub agent: &'a str,
    /// Linked caller, when known.
    pub caller: Option<&'a str>,
    /// Authenticated connection, for ACP and task-scoped grants.
    pub connection: Option<&'a str>,
    /// Internal roles retain their own profile.
    pub background: bool,
    /// Live agent setting read by the caller.
    pub coding_agent: bool,
}

/// Profile selection and optional authoritative project binding.
pub struct PreparedTurn {
    /// Whether to use the coding profile.
    pub coding: bool,
    /// Stored project context, when any.
    pub project: Option<String>,
}

const MAX_PRESENCES: usize = 1024;

struct PendingFolder {
    id: String,
    root: String,
    lease: PresenceLease,
}

struct Presence {
    person: String,
    task: String,
    interactive: bool,
    mode: Option<Mode>,
    order: u64,
    lease: PresenceLease,
    pending: Option<PendingFolder>,
}

/// Connection-local state for coding sessions.
#[derive(Default)]
pub struct CodingSessions {
    presences: HashMap<(String, String), Presence>,
    ephemeral: HashSet<String>,
    opened: u64,
}

fn err(code: C, text: &str) -> CollabError {
    CollabError::new(code, text)
}

fn store_error(error: SessionError) -> CollabError {
    let code = match error.code {
        ErrorCode::NotFound => C::NotFound,
        ErrorCode::Invalid => C::Invalid,
        ErrorCode::Conflict | ErrorCode::Immutable => C::Conflict,
        ErrorCode::Storage => return err(C::Storage, "coding session store failed"),
    };
    CollabError::new(code, error.message)
}

fn grant_needed(message: &str) -> CollabError {
    CollabError::with_reason(C::Unauthorized, message, "root-not-granted")
}

fn mode_conflict() -> CollabError {
    CollabError::with_reason(
        C::Conflict,
        "open the coding session on this connection before selecting its mode",
        "code-mode-connection",
    )
}

fn key(connection: &str, session: &str) -> (String, String) {
    (connection.to_owned(), session.to_owned())
}

fn live_lease(abort: &AbortSignal) -> PresenceLease {
    PresenceLease(Arc::new(AtomicBool::new(true)), abort.clone())
}

fn withdraw(presence: &mut Presence, authority: &mut dyn CodingAuthority) {
    if let Some(request) = presence.pending.take() {
        request.lease.0.store(false, Ordering::Release);
        authority.cancel_folder(&request.id, &presence.person);
    }
}

fn owner_id(who: &Principal) -> R<String> {
    derive_user_principal(&who.user_id)
        .map_err(|_| err(C::Unauthorized, "coding session binding requires a person"))
}

fn owned(
    store: &SessionStore,
    id: &str,
    who: &Principal,
    caller: Option<&str>,
    authority: &dyn CodingAuthority,
) -> R<SessionRecord> {
    let missing = || err(C::NotFound, "session not found");
    let stored = store
        .get_session(id)
        .map_err(store_error)?
        .ok_or_else(missing)?;
    let owner = owner_id(who)?;
    let legacy = caller
        .filter(|identity| authority.linked_caller(who, identity))
        .and_then(|caller| authority.legacy_owner(who, caller));
    if stored.owner != owner && legacy.as_deref() != Some(&stored.owner) {
        return Err(missing());
    }
    Ok(stored)
}

fn human(who: &Principal, agent: &str, authority: &dyn CodingAuthority) -> R<()> {
    if who.kind != Some(PrincipalKind::Person) {
        return Err(err(
            C::Unauthorized,
            "coding session binding requires a person",
        ));
    }
    if !authority.agent_active(agent) {
        return Err(err(C::NotFound, "coding agent not found"));
    }
    if !authorize(
        Some(who),
        "agent.use",
        &Resource::Agent {
            agent_id: agent.to_owned(),
        },
        &AuthorizeContext::default(),
    )
    .is_allow()
    {
        return Err(err(C::Unauthorized, "agent use right required"));
    }
    Ok(())
}

struct Card {
    root: String,
    title: String,
    links: Vec<J>,
}

fn card(
    ports: &SessionPorts<'_>,
    who: &Principal,
    agent: &str,
    project: &str,
    id: &str,
) -> R<Card> {
    let (collab, worktrees) = ports
        .project
        .ok_or_else(|| err(C::Conflict, "project coding is unavailable"))?;
    let p = collab.get_project(who, project)?;
    let scoped = member_principal(who, &p);
    if p.archived_at.is_some()
        || !authorize(
            Some(&scoped),
            "project.write",
            &Resource::Project {
                project_id: p.id.clone(),
            },
            &AuthorizeContext::default(),
        )
        .is_allow()
    {
        return Err(err(
            C::Unauthorized,
            "active project write membership required",
        ));
    }
    let stored = collab.store().board_get_card(project, id)?;
    let assigned = match stored.get("assignees") {
        Some(J::Arr(list)) => list.iter().any(|a| {
            a.get("kind").and_then(J::as_str) == Some("agent")
                && a.get("id").and_then(J::as_str) == Some(agent)
        }),
        _ => false,
    };
    if stored.get("archived") == Some(&J::Bool(true))
        || !p.agents.iter().any(|a| a == agent)
        || !assigned
    {
        return Err(err(
            C::Unauthorized,
            "active card requires the assigned project agent",
        ));
    }
    let bound = worktrees
        .root(agent, project, id)?
        .ok_or_else(|| err(C::Conflict, "bound card worktree is unavailable"))?;
    let root = worktrees.canonical(&bound)?;
    let title = stored
        .get("title")
        .and_then(J::as_str)
        .ok_or_else(|| err(C::Storage, "coding card title is unavailable"))?
        .to_owned();
    let links = match stored.get("links") {
        Some(J::Arr(links)) => links.clone(),
        _ => Vec::new(),
    };
    Ok(Card { root, title, links })
}

fn linked_sessions(card: &Card) -> impl Iterator<Item = &str> {
    card.links
        .iter()
        .filter(|link| link.get("kind").and_then(J::as_str) == Some("session"))
        .filter_map(|link| link.get("id").and_then(J::as_str))
}

fn active_link(card: &Card, store: &SessionStore) -> R<Option<SessionRecord>> {
    let mut existing = None;
    for id in linked_sessions(card) {
        if let Some(session) = store
            .get_session(id)
            .map_err(store_error)?
            .filter(|s| s.kind == SessionKind::Card && s.archived_at.is_none())
        {
            if existing.is_some() {
                return Err(err(
                    C::Conflict,
                    "card has ambiguous active session bindings",
                ));
            }
            existing = Some(session);
        }
    }
    Ok(existing)
}

struct ClockProbe<'a>(&'a dyn Clock);
impl PolicyClock for ClockProbe<'_> {
    fn now(&self) -> f64 {
        self.0.now() as f64
    }
}

fn granted(
    root: &CanonicalPath,
    who: &Principal,
    agent: &str,
    session: &str,
    project: Option<&str>,
    task: Option<&str>,
    ports: &SessionPorts<'_>,
) -> bool {
    let path = root.canonical();
    let action_hash = format!("{:x}", Sha256::digest(json!([session, path]).to_string()));
    let call = json!({ "capability": "fs.read", "tool": "file.read", "effect": "read",
        "flags": { "outsideRoots": root.root_id().is_none(), "denyListHit": false, "systemTree": root.system_tree() },
        "targets": [path], "access": "read", "actionHash": action_hash });
    let mut ctx = json!({ "principal": { "person": who.user_id }, "subject": { "kind": "agent", "agentId": agent },
        "surface": 0, "sessionId": session });
    if let Some(project) = project {
        ctx["projectId"] = json!(project);
    }
    if let Some(task) = task {
        ctx["taskId"] = json!(task);
    }
    match decide(&call, &ctx, ports.authority, &ClockProbe(ports.clock)) {
        Decision::Allow {
            via: Via::Grant,
            grant_id,
            ..
        } => grant_id
            .and_then(|id| ports.authority.get(&id))
            .and_then(|g| g["scope"].as_str().map(str::to_owned))
            .is_some_and(|scope| scope != "once"),
        Decision::Allow { .. } => true,
        _ => false,
    }
}

fn audit(
    who: &Principal,
    action: &str,
    session: &str,
    detail: Vec<(String, Value)>,
    ports: &mut SessionPorts<'_>,
) -> R<()> {
    ports
        .audit
        .append(&AuditEvent {
            at: ports.clock.now(),
            user: who.user_id.clone(),
            host: "core".to_owned(),
            action: action.to_owned(),
            target: session.to_owned(),
            detail,
        })
        .map_err(|_| err(C::Storage, "coding session audit failed"))
}

impl CodingSessions {
    /// Opens or resumes a coding binding or requests interactive consent from the approval service.
    pub fn open(
        &mut self,
        input: CodeOpen<'_>,
        who: &Principal,
        connection: &CodeConnection<'_>,
        store: &mut SessionStore,
        ports: &mut SessionPorts<'_>,
    ) -> R<Opened> {
        human(who, input.agent, ports.authority)?;
        if !ports.authority.linked_caller(who, connection.caller) {
            return Err(err(
                C::Unauthorized,
                "caller identity must be linked to the authenticated person",
            ));
        }
        let explicit = input
            .session
            .map(|id| owned(store, id, who, Some(connection.caller), ports.authority))
            .transpose()?;
        let prior = input
            .session
            .map(|id| store.worktree(id).map_err(store_error))
            .transpose()?
            .flatten();
        let project_card = input.card.or_else(|| {
            prior
                .as_ref()
                .and_then(|b| Some((b.project_id.as_deref()?, b.card_id.as_deref()?)))
        });
        let root = ports.roots.root(input.agent, input.root)?;
        if connection.abort.is_aborted() {
            return Err(CollabError::with_reason(
                C::Aborted,
                "coding folder request was aborted",
                "aborted",
            ));
        }
        let data = project_card
            .map(|(p, id)| card(ports, who, input.agent, p, id))
            .transpose()?;
        if data.as_ref().is_some_and(|c| c.root != root.canonical()) {
            return Err(CollabError::with_reason(
                C::Unauthorized,
                "coding root must equal the card's shared worktree",
                "card-root-mismatch",
            ));
        }
        let linked = data
            .as_ref()
            .map(|c| active_link(c, store))
            .transpose()?
            .flatten();
        if explicit
            .as_ref()
            .zip(linked.as_ref())
            .is_some_and(|(a, b)| a.id != b.id)
        {
            return Err(err(C::Conflict, "card session binding does not match"));
        }
        let existing = explicit.or(linked);
        let project = project_card.map(|(p, _)| p);
        let card_id = project_card.map(|(_, c)| c);
        let may_ask = input.interactive == Some(true)
            && connection.local_cli
            && connection.surface >= 1
            && existing.as_ref().is_none_or(|s| s.kind != SessionKind::Acp);
        let session = if let Some(session) = existing {
            let session = owned(
                store,
                &session.id,
                who,
                Some(connection.caller),
                ports.authority,
            )?;
            if session.agent_id != input.agent
                || session.archived_at.is_some()
                || input.memory.is_some_and(|m| m != session.memory_mode)
            {
                return Err(err(
                    C::Conflict,
                    "session agent, memory mode or active state does not match",
                ));
            }
            let fits = match project {
                Some(p) => session.kind == SessionKind::Card && session.scope == p,
                None => matches!(session.kind, SessionKind::Direct | SessionKind::Acp),
            };
            if !fits {
                return Err(err(C::Conflict, "card session binding does not match"));
            }
            if store
                .worktree(&session.id)
                .map_err(store_error)?
                .is_some_and(|old| {
                    old.root != root.canonical()
                        || old.project_id.as_deref() != project
                        || old.card_id.as_deref() != card_id
                })
            {
                return Err(err(C::Conflict, "worktree binding is immutable"));
            }
            session
        } else {
            if !may_ask && !granted(&root, who, input.agent, "", project, None, ports) {
                return Err(grant_needed(
                    "folder is not a granted root; open it from an interactive local CLI",
                ));
            }
            let kind = if data.is_some() {
                SessionKind::Card
            } else {
                SessionKind::Direct
            };
            let mut create = CreateSessionInput::new(kind, input.agent, &owner_id(who)?);
            create.scope = project.map(str::to_owned);
            create.title = Some(
                data.as_ref()
                    .map_or("Coding", |c| c.title.as_str())
                    .to_owned(),
            );
            create.memory_mode = input.memory;
            store.create_session(&create).map_err(store_error)?
        };
        if session.memory_mode == MemoryMode::Incognito {
            self.ephemeral.insert(session.id.clone());
        }
        let entry = self.refresh_presence(
            &session,
            who,
            connection,
            input.interactive != Some(false),
            ports,
        )?;
        let root_text = root.canonical();
        if !granted(
            &root,
            who,
            &session.agent_id,
            &session.id,
            project,
            Some(entry.task.as_str()),
            ports,
        ) {
            if !may_ask {
                return Err(grant_needed("folder grant is missing or revoked"));
            }
            if !entry.pending.as_ref().is_some_and(|request| {
                request.root == root_text
                    && request.lease.active()
                    && ports.authority.folder_pending(&request.id, &who.user_id)
            }) {
                withdraw(entry, ports.authority);
                let lease = live_lease(connection.abort);
                let id = ports
                    .authority
                    .request_folder(FolderRequest {
                        root: root_text,
                        person: &who.user_id,
                        agent: &session.agent_id,
                        session: &session.id,
                        project,
                        surface: connection.surface.min(3),
                        lease: lease.clone(),
                    })
                    .map_err(|_| {
                        CollabError::with_reason(
                            C::Unauthorized,
                            "coding folder permission request was refused or cancelled",
                            "folder-request-refused",
                        )
                    })?;
                entry.pending = Some(PendingFolder {
                    id,
                    root: root_text.to_owned(),
                    lease,
                });
            }
            let id = entry
                .pending
                .as_ref()
                .ok_or_else(|| err(C::Storage, "folder request unavailable"))?
                .id
                .clone();
            return Ok(Opened {
                state: OpenState::GrantRequired(id),
                session,
                root: root_text.to_owned(),
                branch: None,
                last_event_seq: 0,
                running_turn: None,
            });
        }
        withdraw(entry, ports.authority);
        if store.worktree(&session.id).map_err(store_error)?.is_none() {
            audit(
                who,
                "code.session.bind",
                &session.id,
                vec![
                    ("root".to_owned(), json!(root_text)),
                    ("projectId".to_owned(), json!(project)),
                    ("cardId".to_owned(), json!(card_id)),
                ],
                ports,
            )?;
        }
        store
            .bind_worktree(&session.id, root_text, project, card_id, &who.user_id)
            .map_err(store_error)?;
        if let (Some((p, id)), Some(mut card), Some((collab, _))) =
            (project_card, data, ports.project)
        {
            if !linked_sessions(&card).any(|id| id == session.id) {
                card.links.push(J::obj([
                    ("kind", J::s("session")),
                    ("id", J::s(&session.id)),
                ]));
                let actor = J::obj([("kind", J::s("person")), ("id", J::s(&who.user_id))]);
                collab.store().board_update_card(
                    p,
                    id,
                    &CardFields {
                        links: Some(card.links),
                        ..CardFields::default()
                    },
                    &actor,
                )?;
            }
        }
        entry.mode.get_or_insert(Mode::Coding);
        let last_event_seq = store
            .last_event_seq(&session.id)
            .map_err(store_error)?
            .unwrap_or(0);
        let running_turn = store
            .running_turn(&session.id)
            .map_err(store_error)?
            .map(|t| t.id);
        Ok(Opened {
            state: OpenState::Open,
            session,
            root: root_text.to_owned(),
            branch: ports.roots.branch(root_text),
            last_event_seq,
            running_turn,
        })
    }

    fn refresh_presence(
        &mut self,
        session: &SessionRecord,
        who: &Principal,
        connection: &CodeConnection<'_>,
        interactive: bool,
        ports: &mut SessionPorts<'_>,
    ) -> R<&mut Presence> {
        let identity = key(connection.id, &session.id);
        let stale: Vec<_> = self
            .presences
            .iter()
            .filter(|((conn, id), p)| {
                conn == connection.id
                    && (p.person != who.user_id
                        || !p.lease.active()
                        || (session.kind != SessionKind::Acp && id != &session.id))
            })
            .map(|(key, _)| key.clone())
            .collect();
        for key in stale {
            self.end(&key, ports.authority);
        }
        self.opened = self.opened.saturating_add(1);
        if !self.presences.contains_key(&identity) {
            if self.presences.len() >= MAX_PRESENCES {
                let oldest = self
                    .presences
                    .iter()
                    .min_by_key(|(_, p)| p.order)
                    .map(|(key, _)| key.clone());
                if let Some(oldest) = oldest {
                    self.end(&oldest, ports.authority);
                }
            }
            let entry = Presence {
                person: who.user_id.clone(),
                task: format!("code_{}", ports.ids.next_id()),
                interactive,
                mode: None,
                order: self.opened,
                lease: live_lease(connection.abort),
                pending: None,
            };
            self.presences.insert(identity.clone(), entry);
        }
        let current = self
            .presences
            .get_mut(&identity)
            .ok_or_else(mode_conflict)?;
        current.interactive = interactive;
        current.order = self.opened;
        Ok(current)
    }

    /// Revalidates ownership, root and folder permissions; a claimed task must still be live.
    pub fn require_root(
        &self,
        id: &str,
        who: &Principal,
        caller: Option<&str>,
        task: Option<&str>,
        store: &SessionStore,
        ports: &SessionPorts<'_>,
    ) -> R<RootAccess> {
        let session = owned(store, id, who, caller, ports.authority)?;
        human(who, &session.agent_id, ports.authority)?;
        if session.archived_at.is_some() {
            return Err(err(C::Conflict, "coding session is archived"));
        }
        let binding = store
            .worktree(&session.id)
            .map_err(store_error)?
            .ok_or_else(|| {
                CollabError::with_reason(
                    C::NotFound,
                    "session has no coding worktree binding",
                    "binding-unavailable",
                )
            })?;
        let root = ports.roots.root(&session.agent_id, &binding.root)?;
        let current = owned(store, id, who, caller, ports.authority)?;
        human(who, &current.agent_id, ports.authority)?;
        if current.archived_at.is_some() {
            return Err(err(C::Conflict, "coding session is archived"));
        }
        match (binding.project_id.as_deref(), binding.card_id.as_deref()) {
            (Some(project), Some(card_id)) => {
                let expected = card(ports, who, &current.agent_id, project, card_id)?;
                if expected.root != binding.root
                    || !linked_sessions(&expected).any(|id| id == current.id)
                {
                    return Err(err(
                        C::Unauthorized,
                        "card worktree/session binding changed",
                    ));
                }
            }
            (None, None) => {}
            _ => {
                return Err(err(
                    C::Unauthorized,
                    "card worktree/session binding changed",
                ))
            }
        }
        let task = task.filter(|task| self.has_task(task, id, Some(&who.user_id)));
        if root.canonical() != binding.root
            || !granted(
                &root,
                who,
                &current.agent_id,
                id,
                binding.project_id.as_deref(),
                task,
                ports,
            )
        {
            return Err(grant_needed("folder grant is missing or revoked"));
        }
        Ok(RootAccess {
            session: current,
            binding,
            root,
        })
    }

    /// Selects a coding profile for a turn and checks its current binding and authority.
    pub fn prepare(
        &self,
        turn: &CodeTurn<'_>,
        store: &SessionStore,
        ports: &SessionPorts<'_>,
    ) -> R<PreparedTurn> {
        let session = store.get_session(turn.session).map_err(store_error)?;
        let binding = store.worktree(turn.session).map_err(store_error)?;
        let Some(binding) = binding else {
            let acp = session.as_ref().is_some_and(|s| s.kind == SessionKind::Acp);
            let project_card = ports.project.is_some()
                && session.is_some_and(|s| s.kind == SessionKind::Card && s.scope != "user");
            return Ok(PreparedTurn {
                coding: !turn.background && !acp && (turn.coding_agent || project_card),
                project: None,
            });
        };
        let session = session
            .filter(|session| session.owner == turn.owner && session.agent_id == turn.agent)
            .ok_or_else(|| {
                err(
                    C::Unauthorized,
                    "coding request does not match the stored session",
                )
            })?;
        if turn.background {
            return Ok(PreparedTurn {
                coding: false,
                project: binding.project_id,
            });
        }
        let presence = turn
            .connection
            .and_then(|id| self.presences.get(&key(id, turn.session)))
            .filter(|p| p.person == binding.created_by && p.lease.active());
        let mode = presence.and_then(|p| p.mode);
        if session.kind == SessionKind::Acp && mode.is_none() {
            return Err(CollabError::with_reason(
                C::Conflict,
                "the ACP connection mode expired; open a new editor session",
                "code-mode-connection",
            ));
        }
        let who = ports
            .authority
            .resolve_person(&binding.created_by)
            .ok_or_else(|| err(C::Unauthorized, "coding session owner is unavailable"))?;
        let task = presence.map(|p| p.task.as_str());
        let current = self.require_root(turn.session, &who, turn.caller, task, store, ports)?;
        if current.binding != binding {
            return Err(err(C::Conflict, "coding worktree binding changed"));
        }
        Ok(PreparedTurn {
            coding: session.kind != SessionKind::Acp || mode == Some(Mode::Coding),
            project: binding.project_id,
        })
    }

    /// Sets the future profile on this ACP connection/session pair.
    pub fn set_mode(
        &mut self,
        id: &str,
        mode: Mode,
        who: &Principal,
        connection: &CodeConnection<'_>,
        store: &SessionStore,
        ports: &mut SessionPorts<'_>,
    ) -> R<bool> {
        let session = owned(store, id, who, Some(connection.caller), ports.authority)?;
        human(who, &session.agent_id, ports.authority)?;
        if !ports.authority.linked_caller(who, connection.caller) {
            return Err(err(
                C::Unauthorized,
                "caller identity must be linked to the authenticated person",
            ));
        }
        if session.kind != SessionKind::Acp {
            return Err(err(
                C::Invalid,
                "mode selection requires an ACP session and chat or coding",
            ));
        }
        let identity = key(connection.id, id);
        let task = self.presences.get(&identity).map(|p| p.task.as_str());
        self.require_root(id, who, Some(connection.caller), task, store, ports)?;
        let presence = self
            .presences
            .get_mut(&identity)
            .filter(|p| {
                p.person == who.user_id
                    && p.lease.active()
                    && p.mode.is_some()
                    && !connection.abort.is_aborted()
            })
            .ok_or_else(mode_conflict)?;
        let from = presence.mode.ok_or_else(mode_conflict)?;
        if from == mode {
            return Ok(false);
        }
        audit(
            who,
            "code.session.mode",
            id,
            vec![
                ("from".to_owned(), json!(from.as_str())),
                ("to".to_owned(), json!(mode.as_str())),
            ],
            ports,
        )?;
        presence.mode = Some(mode);
        Ok(true)
    }

    /// Projects a future turn without increasing the triggering connection's trust.
    pub fn approver(&self, connection: &str, session: &str, person: &str, surface: u8) -> Approver {
        let presence = self
            .presences
            .get(&key(connection, session))
            .filter(|p| p.person == person && p.lease.active());
        Approver {
            task: presence.map(|p| p.task.clone()),
            mode: presence.and_then(|p| p.mode),
            surface: if presence.is_some_and(|p| !p.interactive) {
                0
            } else {
                surface.min(3)
            },
        }
    }

    /// True if a native task still has the observed connection and optional person.
    pub fn has_task(&self, task: &str, session: &str, person: Option<&str>) -> bool {
        self.presences.iter().any(|((_, id), p)| {
            id == session
                && p.task == task
                && person.is_none_or(|who| who == p.person)
                && p.lease.active()
        })
    }

    fn end(&mut self, key: &(String, String), authority: &mut dyn CodingAuthority) {
        if let Some(mut presence) = self.presences.remove(key) {
            presence.lease.0.store(false, Ordering::Release);
            withdraw(&mut presence, authority);
            authority.end_task(&presence.task);
        }
    }

    /// Withdraws pending requests and authority for the closed connection.
    pub fn connection_closed(&mut self, connection: &str, authority: &mut dyn CodingAuthority) {
        let found: Vec<_> = self
            .presences
            .keys()
            .filter(|(id, _)| id == connection)
            .cloned()
            .collect();
        for key in found {
            self.end(&key, authority);
        }
    }

    /// Withdraws every task and pending request for an ended session.
    pub fn session_ended(&mut self, session: &str, authority: &mut dyn CodingAuthority) {
        self.ephemeral.remove(session);
        let found: Vec<_> = self
            .presences
            .keys()
            .filter(|(_, id)| id == session)
            .cloned()
            .collect();
        for key in found {
            self.end(&key, authority);
        }
    }

    /// Relinquish all scoped authority before the host closes its approval writer.
    pub fn close(&mut self, authority: &mut dyn CodingAuthority) {
        let found: Vec<_> = self.presences.keys().cloned().collect();
        for key in found {
            self.end(&key, authority);
        }
        for session in self.ephemeral.drain() {
            authority.end_session(&session);
        }
    }
}

#[cfg(test)]
#[path = "session_vectors.rs"]
mod vectors;
