//! `collab/service.ts` (the part of K6a): project administration with RBAC and visibility, the admission of a consult or a
//! delegation (authorization, agents, guardrails, budget, refusal records), the trace and task reads with redaction, chains,
//! and the writer slots. A TypeScript `Promise` becomes two explicit calls: [`CollabService::start_consult`] admits and records
//! the start, the caller runs the turn (a [`super::ports::TurnRunner`]), and [`CollabService::finish_consult`] records the
//! outcome. Nothing here waits, spawns or owns a timer; deadlines are the caller's `tick` (R-K-2).
//!
//! **Not in this part (K6a, recorded in the ledger):** the delegate run with handoff tickets and acceptance
//! (`handoff.ts`, `delegations.ts`, `target.ts`), session transcript replay, `shutdown` with in-flight runs, repo binding with
//! git, and team policy. Admission of a delegation ([`CollabService::admit`]) is here, so every refusal reason is.
//!
//! **Security boundary.** A caller sees a project only when stored membership says so; anything else reads exactly like a
//! missing project (`not-found` for privileged roles, `unauthorized`/`membership` for the rest, as TypeScript). Every text that
//! leaves through a trace, a task or an export passes the [`RedactionPort`]; without one nothing is released.
use super::capacity::{writer_capacity, CapacityFacts};
use super::errors::{CollabError, CollabErrorCode as C, GuardrailReason};
use super::guardrails::{evaluate_guardrails, GuardrailInput};
use super::ids::{pair_key, repeat_key, CollabIds};
use super::limits::CallClass;
use super::ports::{
    ActiveDirectory, AgentDirectoryPort, AuthorizePort, BudgetCheck, BudgetPort, EventEmitter,
    NoopEmitter, RbacAuthorize, RedactionPort, UnlimitedBudget,
};
use super::store::{CollabStore, R};
use super::types::{CollabEvent, CollabSpan, CollabTrace, DelegateTask, Project};
use crate::approvals::js_json::J;
use crate::js::{js_trim, utf16_len};
use crate::rbac::types::Principal;
use crate::rbac::types::{PrincipalKind, Resource, Role};
use crate::sessions::compaction::estimate_tokens;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;

/// What the service needs besides its store.
pub struct Ports {
    /// `authorize`.
    pub authorize: Box<dyn AuthorizePort>,
    /// `budget`.
    pub budget: Box<dyn BudgetPort>,
    /// `redact`: absent means nothing is released.
    pub redact: Option<Box<dyn RedactionPort>>,
    /// `emit`.
    pub emit: Box<dyn EventEmitter>,
    /// `directory`.
    pub directory: Box<dyn AgentDirectoryPort>,
    /// `capacity`: the measured machine facts, when the installation measures them.
    pub capacity: Option<Box<dyn Fn() -> CapacityFacts + Send + Sync>>,
}

impl Default for Ports {
    /// The permissive ports of the TypeScript defaults, except redaction (none).
    fn default() -> Self {
        Self {
            authorize: Box::new(RbacAuthorize),
            budget: Box::new(UnlimitedBudget),
            redact: None,
            emit: Box::new(NoopEmitter),
            directory: Box::new(ActiveDirectory),
            capacity: None,
        }
    }
}

#[derive(Clone, Debug)]
struct Chain {
    trace_id: String,
    project_id: String,
    root_span_id: String,
    started_at: i64,
    fanout: i64,
    read_starts: HashMap<String, i64>,
    pair_counts: HashMap<String, i64>,
    tokens_used: i64,
    aborted: bool,
    ended: bool,
}

#[derive(Default)]
struct State {
    chains: HashMap<String, Chain>,
    writers: HashMap<String, i64>,
    reservations: HashMap<u64, Reservation>,
    next_reservation: u64,
    local_reserved: i64,
}

struct Reservation {
    project_id: String,
    local: bool,
    released: bool,
}

/// A held writer slot; release it once, a second release does nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WriterReservation(u64);

/// The identity a writer slot is reserved for.
#[derive(Clone, Debug)]
pub struct WriterIdentity<'a> {
    /// Who asks.
    pub principal: &'a Principal,
    /// The project.
    pub project_id: &'a str,
    /// The delegating agent.
    pub from_agent: &'a str,
    /// The receiving agent.
    pub to_agent: &'a str,
    /// The chain, when there is one.
    pub trace_id: Option<&'a str>,
    /// The parent span.
    pub parent_span_id: Option<&'a str>,
}

/// The input of an admission (`consult` and `delegate` before they run).
#[derive(Clone, Debug)]
pub struct AdmitInput<'a> {
    /// Who asks.
    pub principal: &'a Principal,
    /// The project.
    pub project_id: &'a str,
    /// The calling agent.
    pub from_agent: &'a str,
    /// The target agent.
    pub to_agent: &'a str,
    /// The question (consult) or task (delegate).
    pub text: &'a str,
    /// The context (consult) or acceptance criteria (delegate).
    pub extra: &'a str,
    /// The path so far; absent starts at the caller.
    pub path: Option<Vec<String>>,
    /// An existing chain.
    pub trace_id: Option<&'a str>,
    /// The parent span.
    pub parent_span_id: Option<&'a str>,
    /// The class of the call.
    pub call_class: CallClass,
    /// Whether this is a consult (a delegation is not counted against the pair limit).
    pub consult: bool,
    /// The task id of the calling turn, part of the turn key.
    pub task_id: Option<&'a str>,
}

/// What an admitted consult gives back.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConsultStart {
    /// The chain.
    pub trace_id: String,
    /// The span of this consult.
    pub span_id: String,
    /// The path including the target.
    pub path: Vec<String>,
}

/// How a consult ended, for [`CollabService::finish_consult`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ConsultOutcome {
    /// The run returned.
    Answered {
        /// The text.
        text: String,
        /// Whether it is partial.
        partial: bool,
        /// Input tokens.
        input_tokens: i64,
        /// Output tokens.
        output_tokens: i64,
    },
    /// The run was aborted (a shared flag, a deadline, a shutdown).
    Aborted,
    /// The run failed.
    Failed(String),
}

/// `CollabService`.
pub struct CollabService {
    store: CollabStore,
    ports: Ports,
    ids: std::sync::Arc<dyn CollabIds>,
    state: Mutex<State>,
}

fn preview_cap(text: &str, max_units: usize) -> String {
    if utf16_len(text) <= max_units {
        return text.to_owned();
    }
    let mut used = 0;
    let mut out = String::new();
    for c in text.chars() {
        let n = c.len_utf16();
        if used + n > max_units {
            break;
        }
        used += n;
        out.push(c);
    }
    out.push('…');
    out
}

impl CollabService {
    /// A service over `store` and `ports`; `ids` draws trace and span ids.
    pub fn new(store: CollabStore, ports: Ports, ids: std::sync::Arc<dyn CollabIds>) -> Self {
        Self {
            store,
            ports,
            ids,
            state: Mutex::new(State::default()),
        }
    }

    /// The store, for the board and the worktrees (`worktreeStore`, `boardStore`).
    pub fn store(&self) -> &CollabStore {
        &self.store
    }

    fn st(&self) -> std::sync::MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn fire(
        &self,
        kind: &'static str,
        project_id: &str,
        trace_id: Option<&str>,
        agent_id: Option<&str>,
        data: Value,
    ) {
        self.ports.emit.emit(&CollabEvent {
            kind,
            at: self.store.now(),
            project_id: project_id.to_owned(),
            trace_id: trace_id.map(str::to_owned),
            agent_id: agent_id.map(str::to_owned),
            data,
        });
    }

    fn authz(&self, principal: &Principal, action: &str, resource: &Resource) -> R<()> {
        let d = self.ports.authorize.authorize(principal, action, resource);
        if d.allow {
            Ok(())
        } else {
            Err(CollabError::with_reason(
                C::Unauthorized,
                format!("refused {action}"),
                d.reason,
            ))
        }
    }

    fn project_res(id: &str) -> Resource {
        Resource::Project {
            project_id: id.to_owned(),
        }
    }

    fn agent_res(id: &str) -> Resource {
        Resource::Agent {
            agent_id: id.to_owned(),
        }
    }

    /// `isA2aAgent`: the reserved namespace stays foreign after revocation.
    pub fn is_a2a_agent(&self, id: &str) -> bool {
        let info = self.ports.directory.get(id);
        id.starts_with("a2a:")
            || info
                .as_ref()
                .is_some_and(|i| i.origin_a2a || i.target_kind.as_deref() == Some("a2a"))
    }

    fn require_a2a_owner(&self, principal: &Principal, id: &str) -> R<()> {
        if self.is_a2a_agent(id)
            && (principal.kind != Some(PrincipalKind::Person) || principal.role != Role::Owner)
        {
            return Err(CollabError::new(
                C::Unauthorized,
                "A2A assignment and execution require an Owner person",
            ));
        }
        Ok(())
    }

    fn live_project(&self, id: &str) -> R<Project> {
        let Some(p) = self.store.get_project(id)? else {
            return Err(CollabError::with_reason(
                C::NotFound,
                format!("project {id} not found"),
                "project",
            ));
        };
        if p.archived_at.is_some() {
            return Err(CollabError::with_reason(
                C::Archived,
                format!("project {id} is archived"),
                "archived",
            ));
        }
        Ok(p)
    }

    fn privileged(p: &Principal) -> bool {
        matches!(p.role, Role::Owner | Role::Admin | Role::Operator)
    }

    fn visible(p: &Principal, project: &Project) -> bool {
        Self::privileged(p)
            || project.members.iter().any(|m| m.user_id == p.user_id)
            || (p.kind == Some(PrincipalKind::Agent) && project.agents.contains(&p.user_id))
    }

    /// A project the caller may not see is refused exactly like a missing one (privileged roles get a plain not-found).
    fn visible_project(&self, principal: &Principal, id: &str, what: &str) -> R<Project> {
        if let Some(p) = self.store.get_project(id)? {
            if Self::visible(principal, &p) {
                return Ok(p);
            }
        }
        if Self::privileged(principal) {
            return Err(CollabError::with_reason(
                C::NotFound,
                format!("{what} {id} not found"),
                what,
            ));
        }
        Err(CollabError::with_reason(
            C::Unauthorized,
            "project access refused",
            "membership",
        ))
    }

    fn redactor(&self) -> R<&dyn RedactionPort> {
        self.ports.redact.as_deref().ok_or_else(|| {
            CollabError::with_reason(
                C::Unauthorized,
                "no redaction port is configured; nothing is released",
                "no-redactor",
            )
        })
    }

    /// The text a stored preview holds: masked, well formed and capped; empty without a redactor, so a secret is never stored
    /// just because redaction was missing.
    fn preview(&self, text: &str) -> String {
        match &self.ports.redact {
            Some(r) => preview_cap(&r.text(text), super::limits::SPAN_PREVIEW_CHARS),
            None => String::new(),
        }
    }

    fn redact_trace(&self, t: CollabTrace) -> R<CollabTrace> {
        let r = self.redactor()?;
        let spans = t
            .spans
            .into_iter()
            .map(|s| CollabSpan {
                input_preview: r.text(&s.input_preview),
                output_preview: r.text(&s.output_preview),
                // An empty stored error reads as none, as `s.error ? ... : null` does.
                error: s
                    .error
                    .as_deref()
                    .filter(|e| !e.is_empty())
                    .map(|e| r.text(e)),
                ..s
            })
            .collect();
        Ok(CollabTrace { spans, ..t })
    }

    fn redact_task(&self, t: DelegateTask) -> R<DelegateTask> {
        let r = self.redactor()?;
        Ok(DelegateTask {
            task: r.text(&t.task),
            acceptance_criteria: r.text(&t.acceptance_criteria),
            result: t.result.as_deref().map(|x| {
                if x.is_empty() {
                    String::new()
                } else {
                    r.text(x)
                }
            }),
            error: t.error.as_deref().map(|x| {
                if x.is_empty() {
                    String::new()
                } else {
                    r.text(x)
                }
            }),
            ..t
        })
    }

    // ---- projects ------------------------------------------------------------------------------------------------

    /// `createProject`.
    pub fn create_project(
        &self,
        principal: &Principal,
        name: &str,
        settings: Option<&J>,
    ) -> R<Project> {
        let id = self.store.id("prj");
        self.authz(principal, "project.write", &Self::project_res(&id))?;
        let p = self
            .store
            .create_project(name, &principal.user_id, settings, Some(&id))?;
        self.fire(
            "project.created",
            &p.id,
            None,
            None,
            json!({ "name": p.name, "owner": p.owner }),
        );
        Ok(p)
    }

    /// `updateProject`.
    pub fn update_project(&self, principal: &Principal, id: &str, name: &str) -> R<Project> {
        self.authz(principal, "project.manage", &Self::project_res(id))?;
        self.store.update_project(id, name)
    }

    /// `getProject`.
    pub fn get_project(&self, principal: &Principal, id: &str) -> R<Project> {
        self.authz(principal, "project.read", &Self::project_res(id))?;
        self.visible_project(principal, id, "project")
    }

    /// `listProjects`: only what the caller may see and read.
    pub fn list_projects(&self, principal: &Principal) -> R<Vec<Project>> {
        let mut out = Vec::new();
        for p in self.store.list_projects()? {
            if Self::visible(principal, &p)
                && self
                    .ports
                    .authorize
                    .authorize(principal, "project.read", &Self::project_res(&p.id))
                    .allow
            {
                out.push(p);
            }
        }
        Ok(out)
    }

    /// `archiveProject`.
    pub fn archive_project(&self, principal: &Principal, id: &str) -> R<Project> {
        self.authz(principal, "project.manage", &Self::project_res(id))?;
        let p = self.store.archive_project(id)?;
        self.fire("project.archived", id, None, None, json!({}));
        Ok(p)
    }

    /// `addMember`.
    pub fn add_member(
        &self,
        principal: &Principal,
        project_id: &str,
        user_id: &str,
        role: &str,
    ) -> R<Project> {
        self.authz(principal, "project.manage", &Self::project_res(project_id))?;
        let p = self.store.add_member(project_id, user_id, role)?;
        self.fire(
            "project.member.added",
            project_id,
            None,
            None,
            json!({ "userId": user_id, "role": role }),
        );
        Ok(p)
    }

    /// `removeMember`.
    pub fn remove_member(
        &self,
        principal: &Principal,
        project_id: &str,
        user_id: &str,
    ) -> R<Project> {
        self.authz(principal, "project.manage", &Self::project_res(project_id))?;
        let p = self.store.remove_member(project_id, user_id)?;
        self.fire(
            "project.member.removed",
            project_id,
            None,
            None,
            json!({ "userId": user_id }),
        );
        Ok(p)
    }

    /// `addAgent`: an A2A agent needs an Owner person.
    pub fn add_agent(&self, principal: &Principal, project_id: &str, agent_id: &str) -> R<Project> {
        self.require_a2a_owner(principal, agent_id)?;
        self.authz(principal, "project.write", &Self::project_res(project_id))?;
        let p = self.store.add_agent(project_id, agent_id)?;
        self.fire(
            "project.agent.added",
            project_id,
            None,
            None,
            json!({ "agentId": agent_id }),
        );
        Ok(p)
    }

    /// `removeAgent`.
    pub fn remove_agent(
        &self,
        principal: &Principal,
        project_id: &str,
        agent_id: &str,
    ) -> R<Project> {
        self.authz(principal, "project.write", &Self::project_res(project_id))?;
        let p = self.store.remove_agent(project_id, agent_id)?;
        self.fire(
            "project.agent.removed",
            project_id,
            None,
            None,
            json!({ "agentId": agent_id }),
        );
        Ok(p)
    }

    /// `limits(principal, projectId)`.
    pub fn limits(
        &self,
        principal: &Principal,
        project_id: &str,
    ) -> R<super::limits::CollabLimits> {
        self.get_project(principal, project_id)?;
        self.store.limits(project_id)
    }

    // ---- reads (redacted) ----------------------------------------------------------------------------------------

    /// `getTask`.
    pub fn get_task(&self, principal: &Principal, id: &str) -> R<DelegateTask> {
        let Some(t) = self.store.get_task(id)? else {
            return Err(CollabError::with_reason(
                C::NotFound,
                format!("task {id} not found"),
                "task",
            ));
        };
        self.authz(principal, "project.read", &Self::project_res(&t.project_id))?;
        self.visible_project(principal, &t.project_id, "task")?;
        self.redact_task(t)
    }

    /// `getTrace`.
    pub fn get_trace(&self, principal: &Principal, trace_id: &str) -> R<CollabTrace> {
        let Some(t) = self.store.get_trace(trace_id)? else {
            return Err(CollabError::with_reason(
                C::NotFound,
                format!("trace {trace_id} not found"),
                "trace",
            ));
        };
        self.authz(principal, "project.read", &Self::project_res(&t.project_id))?;
        self.visible_project(principal, &t.project_id, "trace")?;
        self.redact_trace(t)
    }

    /// `listTraces`.
    pub fn list_traces(&self, principal: &Principal, project_id: &str) -> R<Vec<CollabTrace>> {
        self.authz(principal, "project.read", &Self::project_res(project_id))?;
        self.visible_project(principal, project_id, "project")?;
        self.store
            .list_traces(project_id)?
            .into_iter()
            .map(|t| self.redact_trace(t))
            .collect()
    }

    /// `exportTrace`.
    pub fn export_trace(&self, principal: &Principal, trace_id: &str) -> R<String> {
        Ok(self.get_trace(principal, trace_id)?.to_value().to_string())
    }

    // ---- chains --------------------------------------------------------------------------------------------------

    fn begin_chain(&self, project: &Project, root_agent: &str) -> R<Chain> {
        let trace_id = self.ids.trace_id();
        let root_span_id = self.ids.span_id();
        self.store
            .insert_trace(&trace_id, &project.id, root_agent, &root_span_id, None)?;
        let chain = Chain {
            trace_id: trace_id.clone(),
            project_id: project.id.clone(),
            root_span_id,
            started_at: self.store.now(),
            fanout: 0,
            read_starts: HashMap::new(),
            pair_counts: HashMap::new(),
            tokens_used: 0,
            aborted: false,
            ended: false,
        };
        self.st().chains.insert(trace_id, chain.clone());
        Ok(chain)
    }

    fn get_chain(&self, trace_id: Option<&str>, project: &Project, root_agent: &str) -> R<Chain> {
        let Some(trace_id) = trace_id.filter(|t| !t.is_empty()) else {
            return self.begin_chain(project, root_agent);
        };
        let not_found = || {
            CollabError::with_reason(C::NotFound, format!("trace {trace_id} not found"), "trace")
        };
        if let Some(existing) = self.st().chains.get(trace_id).cloned() {
            // A trace belongs to one project: another project's live chain is reported as missing, never joined.
            if existing.project_id != project.id {
                return Err(not_found());
            }
            return Ok(existing);
        }
        let persisted = self
            .store
            .get_trace(trace_id)?
            .filter(|t| t.project_id == project.id)
            .ok_or_else(not_found)?;
        let live: Vec<&CollabSpan> = persisted
            .spans
            .iter()
            .filter(|s| s.kind != "guardrail")
            .collect();
        let key = J::Arr(vec![J::s(&persisted.root_agent), J::Null]).stringify();
        let revived = Chain {
            trace_id: trace_id.to_owned(),
            project_id: project.id.clone(),
            root_span_id: persisted.root_span_id.clone(),
            started_at: persisted.created_at,
            fanout: live.len() as i64,
            read_starts: HashMap::from([(key, live.len() as i64)]),
            pair_counts: HashMap::new(),
            tokens_used: persisted
                .spans
                .iter()
                .map(|s| s.input_tokens + s.output_tokens)
                .sum(),
            aborted: false,
            ended: persisted.ended_at.is_some(),
        };
        self.st()
            .chains
            .insert(trace_id.to_owned(), revived.clone());
        Ok(revived)
    }

    fn with_chain<T>(&self, trace_id: &str, f: impl FnOnce(&mut Chain) -> T) -> Option<T> {
        self.st().chains.get_mut(trace_id).map(f)
    }

    /// `openChain`: the shared turn trace, created before any worker preparation.
    pub fn open_chain(
        &self,
        principal: &Principal,
        project_id: &str,
        from_agent: &str,
    ) -> R<String> {
        self.authz(principal, "project.write", &Self::project_res(project_id))?;
        self.authz(principal, "agent.use", &Self::agent_res(from_agent))?;
        let project = self.live_project(project_id)?;
        if !project.agents.iter().any(|a| a == from_agent) {
            return Err(CollabError::new(
                C::Unauthorized,
                "project agent assignment required",
            ));
        }
        Ok(self.begin_chain(&project, from_agent)?.trace_id)
    }

    /// `finishChain`: ends an idle chain with the status its spans imply.
    pub fn finish_chain(&self, principal: &Principal, trace_id: &str) -> R<()> {
        let trace = self.get_trace(principal, trace_id)?;
        let live = self.st().chains.get(trace_id).is_some_and(|c| !c.ended);
        if !live {
            return Ok(());
        }
        let has = |s: &str| trace.spans.iter().any(|x| x.status == s);
        let status = if has("failed") || has("refused") {
            "failed"
        } else if has("partial") {
            "partial"
        } else if has("cancelled") {
            "cancelled"
        } else {
            "succeeded"
        };
        self.end_chain(trace_id, status)
    }

    fn end_chain(&self, trace_id: &str, status: &str) -> R<()> {
        if self.with_chain(trace_id, |c| std::mem::replace(&mut c.ended, true)) == Some(false) {
            self.store.finish_trace(trace_id, status)?;
        }
        Ok(())
    }

    /// `cancelChain`: sets the shared abort flag a running turn polls, cancels open tasks and running spans, ends the trace.
    pub fn cancel_chain(&self, principal: &Principal, trace_id: &str) -> R<()> {
        let Some(t) = self.store.get_trace(trace_id)? else {
            return Err(CollabError::with_reason(
                C::NotFound,
                format!("trace {trace_id} not found"),
                "trace",
            ));
        };
        self.authz(
            principal,
            "project.write",
            &Self::project_res(&t.project_id),
        )?;
        if self.with_chain(trace_id, |c| c.aborted = true).is_none() {
            self.store.cancel_open_tasks(trace_id)?;
            return Ok(());
        }
        self.store.cancel_open_tasks(trace_id)?;
        for s in t.spans.iter().filter(|s| s.status == "running") {
            self.store.finish_span(
                &s.span_id,
                &super::store::SpanPatch {
                    status: "cancelled".into(),
                    error: Some("aborted".into()),
                    ..Default::default()
                },
            )?;
        }
        self.end_chain(trace_id, "cancelled")
    }

    /// Whether the chain's abort flag is set: a running turn polls this between steps.
    pub fn is_aborted(&self, trace_id: &str) -> bool {
        self.st().chains.get(trace_id).is_some_and(|c| c.aborted)
    }

    // ---- admission -----------------------------------------------------------------------------------------------

    fn assert_agents(&self, project: &Project, from: &str, to: &str) -> R<bool> {
        let in_p = |id: &str| project.agents.iter().any(|a| a == id);
        let same = in_p(from) && in_p(to);
        for id in [from, to] {
            let active = self
                .ports
                .directory
                .get(id)
                .is_some_and(|i| i.state == super::types::AgentState::Active);
            if !active {
                return Err(CollabError::guardrail(
                    format!("agent {id} is not an active consult/delegate target"),
                    GuardrailReason::AgentInactive,
                ));
            }
        }
        Ok(same)
    }

    fn refuse(
        &self,
        chain: &Chain,
        agent_id: &str,
        parent: Option<&str>,
        reason: GuardrailReason,
        detail: &str,
    ) -> CollabError {
        let span_id = self.ids.span_id();
        let recorded = self
            .store
            .insert_span(
                &span_id,
                &chain.trace_id,
                parent,
                agent_id,
                "guardrail",
                Some("refused"),
                Some(&self.preview(detail)),
            )
            .and_then(|()| {
                self.store.finish_span(
                    &span_id,
                    &super::store::SpanPatch {
                        status: "refused".into(),
                        error: Some(reason.as_str().into()),
                        guardrail: Some(reason.as_str().into()),
                        output_preview: Some(self.preview(detail)),
                        ..Default::default()
                    },
                )
            });
        if let Err(e) = recorded {
            return e;
        }
        self.fire(
            "guardrail.refused",
            &chain.project_id,
            Some(&chain.trace_id),
            Some(agent_id),
            json!({ "reason": reason.as_str() }),
        );
        CollabError::guardrail(detail.to_owned(), reason)
    }

    fn turn_key(from: &str, task_id: Option<&str>) -> String {
        J::Arr(vec![J::s(from), task_id.map_or(J::Null, J::s)]).stringify()
    }

    /// The admission of a consult or a delegation up to and including the guardrails and the budget check. A refused call
    /// leaves a `guardrail` span and an event, never a started run. Returns the chain and the project.
    pub fn admit(&self, i: &AdmitInput<'_>) -> R<(String, Project)> {
        let (chain, project, _) = self.admit_inner(i)?;
        Ok((chain.trace_id, project))
    }

    fn admit_inner(&self, i: &AdmitInput<'_>) -> R<(Chain, Project, Vec<String>)> {
        self.require_a2a_owner(i.principal, i.to_agent)?;
        if js_trim(i.text).is_empty() {
            let (what, reason) = if i.consult {
                ("question", "question")
            } else {
                ("task", "task")
            };
            return Err(CollabError::with_reason(
                C::Invalid,
                format!("{what} is required"),
                reason,
            ));
        }
        self.authz(
            i.principal,
            "project.write",
            &Self::project_res(i.project_id),
        )?;
        let project = self.live_project(i.project_id)?;
        self.authz(i.principal, "agent.use", &Self::agent_res(i.from_agent))?;
        self.authz(i.principal, "agent.use", &Self::agent_res(i.to_agent))?;
        let path = i
            .path
            .clone()
            .unwrap_or_else(|| vec![i.from_agent.to_owned()]);
        let chain = self.get_chain(i.trace_id, &project, i.from_agent)?;
        let next_tokens = estimate_tokens(i.text) + estimate_tokens(i.extra);
        let turn_key = Self::turn_key(i.from_agent, i.task_id);
        // `guard`: limits, agents, guardrails with the settings narrowed from the limits, then the budget port.
        let limits = self.store.limits(&project.id)?;
        let same_project = self.assert_agents(&project, i.from_agent, i.to_agent)?;
        let pk = pair_key(&turn_key, i.to_agent);
        let mut settings = project.settings.clone();
        settings.max_depth = limits.read_helpers_depth;
        settings.max_fanout = limits.read_helpers_per_turn;
        settings.max_pair_per_turn = limits.consults_per_pair_per_turn;
        let decision = evaluate_guardrails(&GuardrailInput {
            call_class: Some(i.call_class),
            consult: Some(i.consult),
            settings,
            from_agent: i.from_agent.to_owned(),
            to_agent: i.to_agent.to_owned(),
            path: path.clone(),
            fanout: chain.read_starts.get(&turn_key).copied().unwrap_or(0),
            pair_count: chain.pair_counts.get(&pk).copied().unwrap_or(0),
            now: self.store.now(),
            chain_started_at: chain.started_at,
            last_repeat_at: self.store.last_repeat(&repeat_key(
                i.from_agent,
                i.to_agent,
                i.text,
            ))?,
            same_project,
            tokens_used: chain.tokens_used,
            next_tokens,
        });
        if let Some(reason) = decision {
            return Err(self.refuse(
                &chain,
                i.to_agent,
                i.parent_span_id,
                reason,
                &format!("guardrail {}", reason.as_str()),
            ));
        }
        let allowed = self.ports.budget.check(&BudgetCheck {
            tokens: next_tokens,
            project_id: project.id.clone(),
            agent_id: i.to_agent.to_owned(),
            chain_id: chain.trace_id.clone(),
        });
        if !allowed {
            let reason = super::ports::BUDGET_REFUSAL;
            return Err(self.refuse(
                &chain,
                i.to_agent,
                i.parent_span_id,
                reason,
                &format!("guardrail {}", reason.as_str()),
            ));
        }
        Ok((chain, project, path))
    }

    /// The start of a consult: admission, the counters, the repeat memory, the span and `consult.started`.
    pub fn start_consult(&self, i: &AdmitInput<'_>) -> R<ConsultStart> {
        let (chain, project, path) = self.admit_inner(i)?;
        let turn_key = Self::turn_key(i.from_agent, i.task_id);
        let first = self
            .with_chain(&chain.trace_id, |c| {
                c.fanout += 1;
                *c.read_starts.entry(turn_key.clone()).or_insert(0) += 1;
                *c.pair_counts
                    .entry(pair_key(&turn_key, i.to_agent))
                    .or_insert(0) += 1;
                c.fanout == 1
            })
            .unwrap_or(false);
        self.store.remember_repeat(
            &repeat_key(i.from_agent, i.to_agent, i.text),
            self.store.now(),
        )?;
        let span_id = if first {
            chain.root_span_id.clone()
        } else {
            self.ids.span_id()
        };
        let mut child = path;
        child.push(i.to_agent.to_owned());
        self.store.insert_span(
            &span_id,
            &chain.trace_id,
            i.parent_span_id,
            i.to_agent,
            "consult",
            None,
            Some(&self.preview(i.text)),
        )?;
        self.fire(
            "consult.started",
            &project.id,
            Some(&chain.trace_id),
            Some(i.to_agent),
            json!({ "fromAgent": i.from_agent, "spanId": span_id }),
        );
        Ok(ConsultStart {
            trace_id: chain.trace_id,
            span_id,
            path: child,
        })
    }

    /// The end of a consult: the span, the tokens, the budget record and `consult.finished`.
    pub fn finish_consult(
        &self,
        start: &ConsultStart,
        project_id: &str,
        to_agent: &str,
        outcome: &ConsultOutcome,
    ) -> R<()> {
        let (status, event_status) = match outcome {
            ConsultOutcome::Answered {
                text,
                partial,
                input_tokens,
                output_tokens,
            } => {
                let used = input_tokens + output_tokens;
                self.with_chain(&start.trace_id, |c| c.tokens_used += used);
                self.ports.budget.record(&BudgetCheck {
                    tokens: used,
                    project_id: project_id.to_owned(),
                    agent_id: to_agent.to_owned(),
                    chain_id: start.trace_id.clone(),
                });
                self.store.finish_span(
                    &start.span_id,
                    &super::store::SpanPatch {
                        status: if *partial { "partial" } else { "succeeded" }.into(),
                        output_preview: Some(self.preview(text)),
                        input_tokens: Some(*input_tokens),
                        output_tokens: Some(*output_tokens),
                        ..Default::default()
                    },
                )?;
                ("succeeded", "succeeded")
            }
            ConsultOutcome::Aborted => {
                self.store.finish_span(
                    &start.span_id,
                    &super::store::SpanPatch {
                        status: "cancelled".into(),
                        error: Some("aborted".into()),
                        output_preview: Some(String::new()),
                        ..Default::default()
                    },
                )?;
                ("cancelled", "cancelled")
            }
            ConsultOutcome::Failed(message) => {
                self.store.finish_span(
                    &start.span_id,
                    &super::store::SpanPatch {
                        status: "failed".into(),
                        // The stored error goes through the same masking as a preview: a failure text can carry what the
                        // run saw.
                        error: Some(
                            self.ports
                                .redact
                                .as_ref()
                                .map_or_else(String::new, |r| r.text(message)),
                        ),
                        output_preview: Some(String::new()),
                        ..Default::default()
                    },
                )?;
                ("failed", "failed")
            }
        };
        let _ = status;
        self.fire(
            "consult.finished",
            project_id,
            Some(&start.trace_id),
            Some(to_agent),
            json!({ "spanId": start.span_id, "status": event_status }),
        );
        Ok(())
    }

    // ---- writer slots --------------------------------------------------------------------------------------------

    /// `reserveWriter`: synchronous trusted admission of one writer, shared across all turns using this service.
    pub fn reserve_writer(&self, w: &WriterIdentity<'_>) -> R<WriterReservation> {
        self.require_a2a_owner(w.principal, w.to_agent)?;
        self.authz(
            w.principal,
            "project.write",
            &Self::project_res(w.project_id),
        )?;
        let project = self.live_project(w.project_id)?;
        self.authz(w.principal, "agent.use", &Self::agent_res(w.from_agent))?;
        self.authz(w.principal, "agent.use", &Self::agent_res(w.to_agent))?;
        self.assert_agents(&project, w.from_agent, w.to_agent)?;
        let limits = self.store.limits(&project.id)?;
        let local = !self.is_a2a_agent(w.to_agent);
        let capacity = if local {
            self.ports
                .capacity
                .as_ref()
                .map(|f| writer_capacity(limits.writers_per_project, &f(), 0))
        } else {
            None
        };
        let (held, local_reserved) = {
            let s = self.st();
            (
                s.writers.get(&project.id).copied().unwrap_or(0),
                s.local_reserved,
            )
        };
        let full = held >= limits.writers_per_project
            || capacity.is_some_and(|c| (local_reserved as f64) >= c.slots);
        if full {
            let chain = self.get_chain(w.trace_id, &project, w.from_agent)?;
            return Err(self.refuse(
                &chain,
                w.to_agent,
                w.parent_span_id,
                GuardrailReason::Fanout,
                "project writer slots full",
            ));
        }
        let mut s = self.st();
        s.next_reservation += 1;
        let id = s.next_reservation;
        s.reservations.insert(
            id,
            Reservation {
                project_id: project.id.clone(),
                local,
                released: false,
            },
        );
        *s.writers.entry(project.id).or_insert(0) += 1;
        if local {
            s.local_reserved += 1;
        }
        Ok(WriterReservation(id))
    }

    /// `WriterReservation.release()`: a second release does nothing.
    pub fn release_writer(&self, r: WriterReservation) {
        let mut s = self.st();
        let Some(res) = s.reservations.get_mut(&r.0) else {
            return;
        };
        if res.released {
            return;
        }
        res.released = true;
        let (project_id, local) = (res.project_id.clone(), res.local);
        if let Some(n) = s.writers.get_mut(&project_id) {
            *n -= 1;
        }
        if local {
            s.local_reserved -= 1;
        }
    }
}
