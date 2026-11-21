//! Project card completion and independent coding review.
use super::gate::{CodingGate, GateOverride, GatePorts, GateResult, Snapshot, VerifyInput};
use crate::approvals::js_json::J;
use crate::collab::service::CollabService;
use crate::collab::types::Project;
use crate::collab::{CollabError, CollabErrorCode as C};
use crate::logs::methods::AbortSignal;
use crate::rbac::authorize::authorize;
use crate::rbac::types::{
    AuthorizeContext, Principal, PrincipalKind, ProjectRight, Resource, Role,
};
use crate::toolcall::json::V;

type R<T> = Result<T, CollabError>;

/// Resolves an agent's already-bound worktree. Access is checked by the caller first.
pub trait WorktreeBindings {
    /// Worktree path matching this exact assignment, or none.
    fn root(&self, agent: &str, project: &str, card: &str) -> R<Option<String>>;
    /// Canonicalize through the trusted path boundary.
    fn canonical(&self, path: &str) -> R<String>;
}

/// Current tree and verification operations.
pub trait SurfaceGate {
    /// Confirm the worktree and inspect its current tree.
    fn snapshot(&self, root: &str) -> R<Snapshot>;
    /// Verify completion for the same tree.
    fn verify(&mut self, input: VerifyInput<'_>) -> R<GateResult>;
    /// Store valid review evidence for the original writer and the reviewer.
    fn record_review(
        &mut self,
        task: &str,
        snapshot: &Snapshot,
        reviewer: &str,
        writer: &str,
    ) -> R<()>;
}

/// Tool-dispatch identity bound to an authenticated turn.
#[derive(Clone, Copy)]
pub struct Worker<'a> {
    /// The working agent.
    pub agent: &'a str,
    /// Identity in the original dispatch context.
    pub user_id: &'a str,
    /// Project of the turn, if present.
    pub turn_project: Option<&'a str>,
}

/// Parameters for completing the assigned card.
#[derive(Clone, Copy)]
pub struct CompleteInput<'a> {
    /// Authoritative authenticated person.
    pub person: &'a Principal,
    /// Target project.
    pub project: &'a str,
    /// Target card.
    pub card: &'a str,
    /// Dispatch context for the tool entry point.
    pub worker: Option<Worker<'a>>,
    /// Note supplied only by an authorized human override.
    pub override_note: Option<&'a str>,
    /// Operation cancellation.
    pub abort: &'a AbortSignal,
}

/// The resulting moved card and verification proof.
pub struct Completion {
    /// The card as stored.
    pub card: J,
    /// The verdict on the worktree.
    pub verification: GateResult,
}

impl SurfaceGate for (&CodingGate, &mut GatePorts<'_>) {
    fn snapshot(&self, root: &str) -> R<Snapshot> {
        self.0.snapshot(root, self.1)
    }
    fn verify(&mut self, input: VerifyInput<'_>) -> R<GateResult> {
        self.0.verify(input, self.1)
    }
    fn record_review(
        &mut self,
        task: &str,
        snapshot: &Snapshot,
        reviewer: &str,
        writer: &str,
    ) -> R<()> {
        self.0
            .record_review(task, snapshot, reviewer, writer, self.1)
    }
}

/// Opaque review ticket bound to an authorized worktree and writer.
pub struct ReviewTicket {
    project: String,
    card: String,
    person: Principal,
    snapshot: Snapshot,
    writer: String,
}

impl ReviewTicket {
    /// The read-only worktree resolved by dispatch for this review.
    pub fn root(&self) -> &str {
        &self.snapshot.root
    }
}

fn denied(message: &str) -> CollabError {
    CollabError::new(C::Unauthorized, message)
}

fn conflict(message: &str) -> CollabError {
    CollabError::new(C::Conflict, message)
}

fn text<'a>(value: &'a J, field: &str) -> Option<&'a str> {
    value.get(field).and_then(J::as_str)
}

pub(super) fn member_principal(principal: &Principal, project: &Project) -> Principal {
    let stored = project
        .members
        .iter()
        .find(|m| m.user_id == principal.user_id);
    let right = stored.and_then(|m| match m.role.as_str() {
        "lead" => Some(ProjectRight::Lead),
        "member" => Some(ProjectRight::Member),
        _ => None,
    });
    Principal {
        project_rights: Some(right.into_iter().map(|r| (project.id.clone(), r)).collect()),
        ..principal.clone()
    }
}

fn admitted(
    service: &CollabService,
    who: &Principal,
    project_id: &str,
    card_id: &str,
) -> R<(Project, J, Principal)> {
    if who.kind != Some(PrincipalKind::Person) {
        return Err(denied("a person is required"));
    }
    let project = service.get_project(who, project_id).map_err(|e| {
        if e.code == C::Unauthorized {
            denied("collaboration request refused")
        } else {
            e
        }
    })?;
    let principal = member_principal(who, &project);
    let resource = Resource::Project {
        project_id: project.id.clone(),
    };
    if !authorize(
        Some(&principal),
        "project.write",
        &resource,
        &AuthorizeContext::default(),
    )
    .is_allow()
    {
        return Err(denied("project write required"));
    }
    if project.archived_at.is_some() {
        return Err(conflict("project is archived"));
    }
    let card = service.store().board_get_card(&project.id, card_id)?;
    if card.get("archived") == Some(&J::Bool(true)) {
        return Err(conflict("card archived"));
    }
    Ok((project, card, principal))
}

fn assignees(card: &J) -> impl Iterator<Item = &str> {
    let slice = match card.get("assignees") {
        Some(J::Arr(assignees)) => assignees.as_slice(),
        _ => &[],
    };
    slice
        .iter()
        .filter(|who| text(who, "kind") == Some("agent"))
        .filter_map(|who| text(who, "id"))
}

fn assigned(project: &Project, card: &J, agent: &str) -> bool {
    project.agents.iter().any(|id| id == agent) && assignees(card).any(|id| id == agent)
}

fn can_use(person: &Principal, agent: &str) -> bool {
    let resource = Resource::Agent {
        agent_id: agent.to_owned(),
    };
    authorize(
        Some(person),
        "agent.use",
        &resource,
        &AuthorizeContext::default(),
    )
    .is_allow()
}

/// Complete a card whose proof, worktree and assignment match at the end of verification.
pub fn complete(
    service: &CollabService,
    worktrees: &dyn WorktreeBindings,
    gate: &mut dyn SurfaceGate,
    input: CompleteInput<'_>,
) -> R<Completion> {
    if input.worker.as_ref().is_some_and(|worker| {
        worker.user_id != input.person.user_id
            || worker.turn_project.is_some_and(|p| p != input.project)
    }) {
        return Err(denied("authenticated project principal required"));
    }
    let (project, card, principal) = admitted(service, input.person, input.project, input.card)?;
    let agent = input
        .worker
        .as_ref()
        .map(|w| w.agent)
        .or_else(|| assignees(&card).next())
        .filter(|agent| assigned(&project, &card, agent) && can_use(input.person, agent))
        .ok_or_else(|| denied("assigned project agent required"))?;
    let root = worktrees
        .root(agent, &project.id, input.card)?
        .ok_or_else(|| conflict("bound coding worktree unavailable"))?;
    let task = format!("{}/{}", project.id, input.card);
    let override_note = if let Some(note) = input.override_note {
        let lead = project
            .members
            .iter()
            .any(|m| m.user_id == principal.user_id && m.role == "lead");
        if input.worker.is_some() || (!lead && !matches!(principal.role, Role::Owner | Role::Admin))
        {
            return Err(denied("a project lead must explicitly override"));
        }
        Some(GateOverride {
            actor: &principal,
            project: &project.id,
            note,
        })
    } else {
        None
    };
    let verification = gate.verify(VerifyInput {
        task: &task,
        root: &root,
        abort: input.abort,
        override_note,
    })?;
    if !verification.ok {
        return Err(conflict("coding verification refused completion"));
    }
    if input.abort.is_aborted() {
        return Err(CollabError::new(C::Aborted, "coding verification aborted"));
    }
    let (live, current, _) = admitted(service, input.person, &project.id, input.card)?;
    let bound = worktrees
        .root(agent, &live.id, input.card)?
        .ok_or_else(|| denied("task assignment changed during verification"))?;
    if !assigned(&live, &current, agent)
        || !can_use(input.person, agent)
        || worktrees.canonical(&bound)? != worktrees.canonical(&root)?
    {
        return Err(denied("task assignment changed during verification"));
    }
    if gate.snapshot(&root)?.tree_hash != verification.tree_hash {
        return Err(conflict("worktree changed after verification"));
    }
    let columns = service.store().board_columns(&live.id)?;
    let done = columns
        .iter()
        .find(|c| text(c, "titleKey") == Some("project.board.done"))
        .and_then(|c| text(c, "id"))
        .ok_or_else(|| conflict("done column unavailable"))?;
    let actor = match &input.worker {
        Some(worker) => J::obj([("kind", J::s("agent")), ("id", J::s(worker.agent))]),
        None => J::obj([
            ("kind", J::s("person")),
            ("id", J::s(&input.person.user_id)),
        ]),
    };
    let card = service
        .store()
        .board_move_card(&live.id, input.card, done, None, &actor, false)?;
    Ok(Completion { card, verification })
}

/// Prepare an independent review of the authorized writer's current worktree.
pub fn start_review(
    service: &CollabService,
    worktrees: &dyn WorktreeBindings,
    gate: &dyn SurfaceGate,
    person: &Principal,
    project_id: &str,
    card_id: &str,
    writer: &str,
) -> R<ReviewTicket> {
    if service.is_a2a_agent(writer) {
        return Err(denied("a local coding agent is required"));
    }
    let (project, card, _) = admitted(service, person, project_id, card_id)?;
    if !assigned(&project, &card, writer) || !can_use(person, writer) {
        return Err(denied("assigned review caller required"));
    }
    let root = worktrees
        .root(writer, project_id, card_id)?
        .ok_or_else(|| conflict("review worktree unavailable"))?;
    let snapshot = gate.snapshot(&root)?;
    Ok(ReviewTicket {
        project: project.id,
        card: card_id.to_owned(),
        person: person.clone(),
        snapshot,
        writer: writer.to_owned(),
    })
}

/// Store passing evidence only from a local, independent project reviewer.
pub fn finish_review(
    service: &CollabService,
    gate: &mut dyn SurfaceGate,
    ticket: &ReviewTicket,
    reviewer: &str,
    report: &V,
) -> R<()> {
    if !report.get("status").is_some_and(|v| v.is_str("done"))
        || !report
            .get("output")
            .and_then(|v| v.get("verdict"))
            .is_some_and(|v| v.is_str("pass"))
    {
        return Ok(());
    }
    let (project, card, _) = admitted(service, &ticket.person, &ticket.project, &ticket.card)?;
    if service.is_a2a_agent(reviewer)
        || !project.agents.iter().any(|a| a == reviewer)
        || !can_use(&ticket.person, reviewer)
        || !assigned(&project, &card, &ticket.writer)
    {
        return Err(denied("local reviewer project assignment required"));
    }
    gate.record_review(
        &format!("{}/{}", ticket.project, ticket.card),
        &ticket.snapshot,
        reviewer,
        &ticket.writer,
    )
}

#[cfg(test)]
#[path = "surface_vectors.rs"]
mod vectors;
