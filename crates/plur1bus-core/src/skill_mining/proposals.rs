//! Proposal-only mining service over a scoped registry and an additive queue.

use super::evidence::Proof;
use super::miner::{mine, Candidate, Sessions, Settings, Tool};
use super::review::{scoped_person, validate, Authority, Backend};
use super::{Scope, R};
use crate::budget::Clock;
use crate::collab::{CollabError, CollabErrorCode};
use crate::logs::methods::AbortSignal;
use crate::rbac::{
    authorize::authorize,
    types::{AuthorizeContext, Principal, Resource},
};
use serde::Serialize;
use serde_json::Value;

/// Whether inactive proposals can be reviewed.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// An additive queue is available from the host.
    pub available: bool,
    /// Availability in the vocabulary exposed by the host.
    pub state: &'static str,
    /// Default activation of mined artifacts, always false.
    pub active_by_default: bool,
    /// A person must review a proposal, always true.
    pub human_review_required: bool,
}

/// Proposal IDs and pre-existing candidates discovered during this run.
#[derive(Debug, Default, Serialize)]
pub struct Published {
    /// IDs of proposals recorded by the destination.
    pub ids: Vec<String>,
    /// Count of existing scoped workflow hashes.
    pub duplicates: usize,
}

/// Trusted inputs for an exact mining scope.
pub struct Request<'a> {
    /// Known owner, agent and project scope.
    pub scope: &'a Scope,
    /// Authenticated caller requesting the job.
    pub who: &'a Principal,
    /// Session and event limits.
    pub settings: Settings,
    /// Caller cancellation.
    pub abort: &'a AbortSignal,
}

/// The source, authenticated registry and pending proposal boundary.
pub struct Ports<'a> {
    /// Live scope resolver.
    pub authority: &'a dyn Authority,
    /// Trusted time for RBAC.
    pub clock: &'a dyn Clock,
    /// Historical session metadata source.
    pub sessions: &'a dyn Sessions,
    /// Trusted finalized execution ledger.
    pub proof: &'a dyn Proof,
    /// Current tool catalog from the registered host.
    pub tools: &'a [Tool],
    /// Additive proposal contract.
    pub backend: &'a mut dyn Backend,
}

/// Stable system-job name for the eventual host registration.
pub const JOB_NAME: &str = "skills.mine";

/// The read-only invocation state of the mining job.
pub fn status(backend: &dyn Backend) -> Status {
    let available = backend.ready();
    Status {
        available,
        state: if available {
            "ready"
        } else {
            "engine-unavailable"
        },
        active_by_default: false,
        human_review_required: true,
    }
}

/// Validate that job arguments do not supply the host-owned scope.
pub fn validate_arguments(args: &Value) -> R<()> {
    if args.is_null() || args.as_object().is_some_and(serde_json::Map::is_empty) {
        Ok(())
    } else {
        Err(CollabError::new(
            CollabErrorCode::Invalid,
            "mining scope is host-owned",
        ))
    }
}

fn check(request: &Request<'_>, ports: &Ports<'_>) -> R<()> {
    if request.abort.is_aborted() {
        return Err(CollabError::new(
            CollabErrorCode::Aborted,
            "mining cancelled",
        ));
    }
    let now = ports.clock.now();
    let live = scoped_person(request.scope, request.who, ports.authority, now)?;
    let context = AuthorizeContext {
        now: Some(now as f64),
    };
    if [request.who, &live]
        .into_iter()
        .all(|p| authorize(Some(p), "jobs.run", &Resource::System, &context).is_allow())
    {
        Ok(())
    } else {
        Err(CollabError::new(
            CollabErrorCode::Unauthorized,
            "mining requires current job rights",
        ))
    }
}

fn ready(ports: &Ports<'_>) -> R<()> {
    if ports.backend.ready() {
        return Ok(());
    }
    Err(CollabError::with_reason(
        CollabErrorCode::Conflict,
        "skill proposal contract unavailable",
        "skill-proposal-contract-unavailable",
    ))
}

/// Return review-only workflows for the authenticated scope.
pub fn preview(request: &Request<'_>, ports: &Ports<'_>) -> R<Vec<Candidate>> {
    check(request, ports)?;
    let items = mine(
        ports.sessions,
        request.scope,
        ports.tools,
        ports.proof,
        request.settings,
    )?;
    check(request, ports)?;
    Ok(items)
}

/// Propose bounded, inert workflows to the existing approval queue.
pub fn propose(request: &Request<'_>, ports: &mut Ports<'_>) -> R<Published> {
    check(request, ports)?;
    ready(ports)?;
    let mut done = Published::default();
    for candidate in preview(request, ports)? {
        check(request, ports)?;
        ready(ports)?;
        let existing = ports
            .backend
            .find(request.scope, &candidate.workflow_hash)?;
        check(request, ports)?;
        if let Some(existing) = existing {
            if &existing.scope != request.scope
                || existing.candidate.workflow_hash != candidate.workflow_hash
                || !super::text_id(&existing.id, 256)
            {
                return Err(CollabError::new(
                    CollabErrorCode::Storage,
                    "invalid skill proposal deduplication receipt",
                ));
            }
            done.duplicates += 1;
            continue;
        }
        let receipt = ports.backend.propose(request.scope, &candidate)?;
        check(request, ports)?;
        if receipt.status != super::review::State::Pending
            || receipt.candidate != candidate
            || done.ids.contains(&receipt.id)
            || validate(&receipt, request.scope, &receipt.id).is_err()
        {
            return Err(CollabError::new(
                CollabErrorCode::Storage,
                "proposal queue did not retain human review",
            ));
        }
        done.ids.push(receipt.id);
    }
    Ok(done)
}

#[cfg(test)]
#[path = "proposal_vectors.rs"]
mod vectors;
