//! Human-only proposal review using content-bound, one-use approval.

use super::miner::Candidate;
use super::{text_id, tool_version, valid_scope, Scope, R};
use crate::approvals::service::{Answer, Ask};
use crate::budget::{Clock, IdSource};
use crate::collab::{CollabError, CollabErrorCode};
use crate::logs::methods::AbortSignal;
use crate::policy::{
    capabilities::{GrantScope, Risk},
    decide::{surface_may_decide, Flags},
};
use crate::rbac::{
    audit::{AuditEvent, AuditSink},
    authorize::authorize,
    types::{AuthorizeContext, Principal, PrincipalKind, Resource, Role},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Approval lifecycle of an inert proposal.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    /// Awaiting explicit human review.
    Pending,
    /// Review accepted, still inactive.
    Accepted,
    /// Review refused.
    Rejected,
}

/// A scoped snapshot from the additive proposal contract.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct Proposal {
    /// Current proposal ID.
    pub id: String,
    /// Proven review scope.
    pub scope: Scope,
    /// Snapshot's review state.
    pub status: State,
    /// Inactive candidate to review.
    pub candidate: Candidate,
}

/// Explicit human review choice.
#[derive(Clone, Copy)]
pub enum Decision {
    /// Confirm the proposal review.
    Accept,
    /// Reject the proposed workflow.
    Reject,
}

/// Proposal-only capabilities, without activation or installation.
pub trait Backend {
    /// Whether the real additive proposal contract is available.
    fn ready(&self) -> bool;
    /// Get an idempotency hit for this scope and workflow hash, including a rejected proposal.
    /// A rejection is durable for the same candidate and must prevent proposing it again.
    fn find(&mut self, scope: &Scope, hash: &str) -> R<Option<Proposal>>;
    /// Propose an inactive candidate once for this scope and stable hash.
    fn propose(&mut self, scope: &Scope, candidate: &Candidate) -> R<Proposal>;
    /// Read an immutable snapshot by scoped ID.
    fn get(&mut self, scope: &Scope, id: &str) -> R<Proposal>;
    /// Change only pending status after atomically comparing the full candidate hash.
    fn decide(&mut self, scope: &Scope, id: &str, expected_hash: &str, decision: Decision)
        -> R<()>;
}

/// Existing human approval service through a testable foreground interaction.
pub trait Approval {
    /// Ask a person using the existing approval semantics.
    fn ask(&mut self, request: &Ask, abort: &AbortSignal) -> R<Answer>;
    /// Bind and consume this exact previously approved request.
    fn begin(&mut self, answer: &Answer, request: &Ask) -> bool;
}

/// Scoped proposal authority from the host registry.
pub trait Authority {
    /// Resolve a current authenticated account, including narrowed rights.
    fn current(&self, id: &str) -> Option<Principal>;
    /// Independent proof of live scope and registry membership.
    fn allows(&self, scope: &Scope, person: &Principal) -> bool;
}

/// One explicit authorized review attempt.
pub struct Request<'a> {
    /// Trusted owner and agent scope.
    pub scope: &'a Scope,
    /// Authenticated requesting person.
    pub who: &'a Principal,
    /// Scoped proposal identity.
    pub id: &'a str,
    /// Requested review action.
    pub decision: Decision,
    /// Trusted origin surface.
    pub surface: u8,
    /// Caller cancellation.
    pub abort: &'a AbortSignal,
}

/// Review service dependencies.
pub struct Ports<'a> {
    /// Live authenticated scope.
    pub authority: &'a dyn Authority,
    /// Existing additive proposal contract.
    pub backend: &'a mut dyn Backend,
    /// Existing human approval service.
    pub approval: &'a mut dyn Approval,
    /// Host clock.
    pub clock: &'a dyn Clock,
    /// Unique approval call IDs.
    pub ids: &'a dyn IdSource,
    /// Metadata-only audit sink.
    pub audit: &'a mut dyn AuditSink,
}

const TOOL: &str = "skills.proposals.review";
const CAPABILITY: &str = "fs.write";
const SURFACE: u8 = 3;

fn refused(reason: &'static str) -> CollabError {
    CollabError::with_reason(
        CollabErrorCode::Unauthorized,
        "skill proposal review refused",
        reason,
    )
}

pub(super) fn scoped_person(
    scope: &Scope,
    who: &Principal,
    authority: &dyn Authority,
    at: i64,
) -> R<Principal> {
    let resource = Resource::Agent {
        agent_id: scope.agent_id.clone(),
    };
    let context = AuthorizeContext {
        now: Some(at as f64),
    };
    let check = |p: &Principal| {
        p.user_id == who.user_id
            && p.kind == Some(PrincipalKind::Person)
            && authorize(Some(p), "agent.manage", &resource, &context).is_allow()
            && authority.allows(scope, p)
    };
    if !valid_scope(scope) || !check(who) {
        return Err(refused("scope-unavailable"));
    }
    authority
        .current(&who.user_id)
        .filter(check)
        .ok_or_else(|| refused("scope-unavailable"))
}

fn reviewer(request: &Request<'_>, ports: &Ports<'_>) -> R<()> {
    if request.abort.is_aborted() || request.surface > SURFACE {
        return Err(refused("review-interrupted"));
    }
    let live = scoped_person(
        request.scope,
        request.who,
        ports.authority,
        ports.clock.now(),
    )?;
    if !matches!(request.who.role, Role::Owner | Role::Admin)
        || !matches!(live.role, Role::Owner | Role::Admin)
    {
        return Err(refused("reviewer-role"));
    }
    if !ports.backend.ready() {
        return Err(CollabError::with_reason(
            CollabErrorCode::Conflict,
            "skill proposal contract unavailable",
            "engine-unavailable",
        ));
    }
    Ok(())
}

pub(super) fn validate(proposal: &Proposal, scope: &Scope, id: &str) -> R<()> {
    if !text_id(id, 256)
        || proposal.id != id
        || &proposal.scope != scope
        || proposal.status != State::Pending
    {
        return Err(refused("proposal-not-pending"));
    }
    let c = &proposal.candidate;
    if c.schema != "plur1bus.skill-candidate/1"
        || c.kind != "skill"
        || c.author != "agent"
        || c.enabled
        || !tool_version(&c.workflow_hash)
        || c.name
            .strip_prefix("mined-workflow-")
            .is_none_or(|name| c.workflow_hash.get(..16) != Some(name))
        || c.skill_md.is_empty()
        || c.skill_md.len() > 65_536
        || !(2..=200).contains(&c.session_ids.len())
        || c.session_ids.iter().any(|id| !text_id(id, 128))
        || c.session_ids
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len()
            != c.session_ids.len()
    {
        return Err(CollabError::new(
            CollabErrorCode::Storage,
            "invalid or active skill proposal",
        ));
    }
    Ok(())
}

fn hash(value: &Value) -> R<String> {
    use sha2::{Digest, Sha256};
    let text = crate::prompt::canonical_json(value)
        .map_err(|_| CollabError::new(CollabErrorCode::Invalid, "invalid proposal data"))?;
    Ok(format!("{:x}", Sha256::digest(text.as_bytes())))
}

/// Exact content hash presented to the human reviewer.
pub fn proposal_hash(proposal: &Proposal) -> R<String> {
    hash(&json!(proposal))
}

impl Decision {
    fn as_str(self) -> &'static str {
        match self {
            Self::Accept => "accept",
            Self::Reject => "reject",
        }
    }
}

fn ask(
    request: &Request<'_>,
    proposal: &Proposal,
    expected_hash: &str,
    ids: &dyn IdSource,
) -> R<Ask> {
    let call = ids.next_id();
    if !text_id(&call, 256)
        || !surface_may_decide(
            CAPABILITY,
            Risk::High,
            Flags::of(&Value::Null),
            SURFACE,
            GrantScope::Once,
        )
    {
        return Err(refused("approval-surface"));
    }
    let args = json!({"decision":request.decision.as_str(),"proposalId":request.id,"scope":request.scope,
        "contentHash":expected_hash,"enabled":false,"skillMd":proposal.candidate.skill_md});
    let action = hash(&args)?;
    Ok(Ask {
        request: json!({"capability":CAPABILITY,"tool":TOOL,"effect":"local-write","risk":"high","reversible":true,
            "flags":{"outsideRoots":false,"denyListHit":false},"actionHash":action,"grantOptions":[{"scope":"once","requiredSurface":SURFACE}],
            "requiredSurface":SURFACE,"tainted":false,"taintSuspended":false,"originSurface":request.surface}),
        call_id: call,
        tool: TOOL.into(),
        args,
        agent_id: request.scope.agent_id.clone(),
        principal: request.who.user_id.clone(),
        session_id: None,
        park: false,
        aborted: false,
        subject_kind: Some("person".into()),
        turn_id: None,
        task_id: None,
        project_id: None,
        targets: None,
        access: Some("write".into()),
        reason: None,
        diff: None,
        recurring: None,
        public_peer_trust: None,
    })
}

/// Read the checked, inactive proposal intended for this reviewer.
pub fn preview(request: &Request<'_>, ports: &mut Ports<'_>) -> R<Proposal> {
    reviewer(request, ports)?;
    let proposal = ports.backend.get(request.scope, request.id)?;
    validate(&proposal, request.scope, request.id)?;
    reviewer(request, ports)?;
    Ok(proposal)
}

/// Request approval, revalidate the exact proposal, then submit its review.
pub fn decide(request: &Request<'_>, ports: &mut Ports<'_>) -> R<()> {
    let proposal = preview(request, ports)?;
    let expected = proposal_hash(&proposal)?;
    let ask = ask(request, &proposal, &expected, ports.ids)?;
    let answer = ports.approval.ask(&ask, request.abort)?;
    reviewer(request, ports)?;
    if !answer.approved || answer.parked || answer.scope != Some(GrantScope::Once) {
        return Err(refused("approval-required"));
    }
    let fresh = ports.backend.get(request.scope, request.id)?;
    validate(&fresh, request.scope, request.id)?;
    if proposal_hash(&fresh)? != expected {
        return Err(refused("proposal-changed"));
    }
    reviewer(request, ports)?;
    ports
        .audit
        .append(&AuditEvent {
            at: ports.clock.now(),
            user: request.who.user_id.clone(),
            host: String::new(),
            action: TOOL.into(),
            target: request.id.into(),
            detail: vec![
                ("contentHash".into(), json!(expected)),
                ("decision".into(), json!(request.decision.as_str())),
            ],
        })
        .map_err(|_| refused("audit-unavailable"))?;
    if !ports.approval.begin(&answer, &ask) {
        return Err(refused("approval-unavailable"));
    }
    reviewer(request, ports)?;
    ports
        .backend
        .decide(request.scope, request.id, &expected, request.decision)
}

#[cfg(test)]
#[path = "review_vectors.rs"]
mod vectors;
