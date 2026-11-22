//! Authenticated learning review and explicit, receipt-based memory effects.

use serde_json::json;

use super::review::evidence_view;
use super::runner::load_evidence;
use super::store::{Decision, LearnStore, Reconcile};
use super::{
    admits, array, current, digest, equals, readable, string, target_valid, Source, Target,
};
use crate::budget::Clock;
use crate::collab::{CollabError, CollabErrorCode};
use crate::identity::principals::derive_user_principal;
use crate::rbac::{
    audit::{AuditEvent, AuditSink},
    authorize::authorize,
    types::{AuthorizeContext, MemoryAgentScope, Principal, PrincipalKind, Resource},
};
use crate::toolcall::json::V;

type R<T> = Result<T, CollabError>;

/// Explicit selection for a stale record.
#[derive(Clone, Copy)]
pub enum StaleChoice {
    /// Keep the record and correct its text.
    Correct,
    /// Retire the record.
    Forget,
}

/// One explicit human decision on the current revision.
#[derive(Clone, Copy)]
pub struct ReviewRequest<'a> {
    /// Finding identifier.
    pub id: &'a str,
    /// Content hash returned by the most recent authorized review.
    pub content_hash: &'a str,
    /// Rejection or consent to the scoped effect.
    pub decision: Decision,
    /// Explicit action for a stale finding.
    pub stale_action: Option<StaleChoice>,
}

/// Existing record read through the ordinary scoped memory boundary.
pub struct ShownCard {
    /// Actual destination storage scope.
    pub scope: String,
    /// Sharing owner when the card requires a proposal.
    pub shared_by: Option<String>,
}

/// Data for exactly one explicitly authorized effect.
pub enum Effect<'a> {
    /// Import a new private memory.
    Import {
        /// Owner-reviewed text.
        text: &'a str,
        /// Stable import identity for this finding revision.
        idempotency_key: &'a str,
    },
    /// Correct text in one current record.
    Correct {
        /// Current record.
        id: &'a str,
        /// Owner-reviewed replacement.
        text: &'a str,
    },
    /// Retire one current record.
    Forget {
        /// Current record to retire.
        id: &'a str,
    },
    /// Submit a correction proposal across the existing sharing boundary.
    Propose {
        /// Current shared record.
        id: &'a str,
        /// Owner-reviewed proposed replacement.
        text: &'a str,
    },
    /// Roll back one previously confirmed import.
    Rollback {
        /// Previously confirmed import identity.
        id: &'a str,
    },
}

/// Minimal durable confirmation from the actual destination.
pub struct EffectReceipt {
    /// Agent within the current target.
    pub agent_id: String,
    /// Durable import, proposal, record, tombstone or rollback identity.
    pub id: String,
    /// Number of applied or already linked effects.
    pub changed: usize,
}

/// Whether an effect can currently be retried.
pub enum EffectFailure {
    /// Public policy definitively refused the request before applying.
    Refused,
    /// The boundary did not give conclusive evidence about whether it applied.
    Unknown,
}

/// The existing scoped public memory boundary, as a port with no native wiring.
pub trait Memory {
    /// Read a current card with the checked identity.
    fn show(&mut self, who: &Principal, agent: &str, id: &str) -> R<Option<ShownCard>>;
    /// Apply one explicit operation through the existing grants and approval path.
    fn apply(
        &mut self,
        who: &Principal,
        agent: &str,
        effect: Effect<'_>,
    ) -> Result<EffectReceipt, EffectFailure>;
}

/// Confirmed delivery of one specific artifact to the skill bridge.
pub struct HandoffReceipt {
    /// Current finding identity.
    pub finding: String,
    /// Expected content hash.
    pub hash: String,
    /// Durable identity returned by the bridge.
    pub receipt: String,
}

/// Optional future skill bridge. Submissions are idempotent by key.
pub trait Handoff {
    /// Whether the bridge is available.
    fn available(&self) -> bool;
    /// Submit only this private procedural finding with a stable key.
    fn submit(&mut self, finding: &V, key: &str) -> R<HandoffReceipt>;
}

/// Scoped review dependencies.
pub struct Service<'a> {
    /// Private learning ledger.
    pub store: &'a LearnStore,
    /// Authoritative current evidence and access.
    pub source: &'a dyn Source,
    /// Trusted clock.
    pub clock: &'a dyn Clock,
    /// Existing scoped memory boundary.
    pub memory: &'a mut dyn Memory,
    /// Metadata-only audit sink.
    pub audit: &'a mut dyn AuditSink,
}

fn denied() -> CollabError {
    CollabError::with_reason(
        CollabErrorCode::Unauthorized,
        "learning review is unavailable",
        "learn-access",
    )
}

fn unavailable(reason: &'static str) -> CollabError {
    CollabError::with_reason(
        CollabErrorCode::Conflict,
        "learning action is unavailable",
        reason,
    )
}

fn field(v: &V, key: &str) -> R<String> {
    string(v, key).map_err(|_| denied())
}

fn valid_id(key: &str) -> bool {
    !key.is_empty() && key.len() <= 256 && !key.chars().any(char::is_control)
}

struct ActiveRights<'a> {
    source: &'a dyn Source,
    clock: &'a dyn Clock,
}
impl ActiveRights<'_> {
    fn live(&self, target: &Target) -> Option<Principal> {
        self.source
            .current_person(&target.owner)
            .and_then(|p| current(self.source, target, &p, self.clock.now()).ok())
    }

    fn session_row(&self, target: &Target, id: &str) -> Option<V> {
        let live = self.live(target)?;
        let row = self.source.session(id).ok().flatten()?;
        let owner = derive_user_principal(&target.owner).ok()?;
        if !equals(&row, "id", id)
            || !admits(target, &owner, &row)
            || !readable(self.source, target, &live, &live, &row, self.clock.now()).ok()?
        {
            return None;
        }
        Some(row)
    }
}
impl Reconcile for ActiveRights<'_> {
    fn target(&self, target: &Target) -> bool {
        self.live(target).is_some()
    }
    fn session(&self, target: &Target, id: &str) -> bool {
        self.session_row(target, id).is_some()
    }
    fn evidence(&self, target: &Target, reference: &V) -> bool {
        let Ok(id) = field(reference, "sessionId") else {
            return false;
        };
        let Some(row) = self.session_row(target, &id) else {
            return false;
        };
        ["owner", "agentId"].iter().all(|key| {
            row.get(key)
                .zip(reference.get(key))
                .is_some_and(|(a, b)| a.deep_equal(b))
        })
    }
}

struct Reviewed {
    finding: V,
    target: Target,
    live: Principal,
    evidence: Vec<V>,
}

fn target(finding: &V) -> R<Target> {
    let value = finding.get("target").ok_or_else(denied)?;
    let target: Target = serde_json::from_str(&value.stringify()).map_err(|_| denied())?;
    if !target_valid(&target) {
        return Err(denied());
    }
    Ok(target)
}

fn can_write(who: &Principal, target: &Target, effect: &Effect<'_>, now: i64) -> bool {
    let scope = if target.scope == "project" {
        MemoryAgentScope::Workspace
    } else {
        MemoryAgentScope::AgentPrivate
    };
    let memory = match scope {
        MemoryAgentScope::Workspace => "memory.workspace.write",
        MemoryAgentScope::AgentPrivate => "memory.agent-private.write",
    };
    let ctx = AuthorizeContext {
        now: Some(now as f64),
    };
    let rights = authorize(
        Some(who),
        memory,
        &Resource::MemoryAgent {
            scope,
            agent_id: target.agent_id.clone(),
        },
        &ctx,
    )
    .is_allow();
    rights
        && match effect {
            Effect::Import { .. } | Effect::Rollback { .. } => {
                authorize(Some(who), "imports.manage", &Resource::System, &ctx).is_allow()
            }
            Effect::Forget { .. } => authorize(
                Some(who),
                "memory.forget",
                &Resource::Agent {
                    agent_id: target.agent_id.clone(),
                },
                &ctx,
            )
            .is_allow(),
            _ => true,
        }
}

impl Effect<'_> {
    fn operation(&self) -> (&'static str, &'static str) {
        match self {
            Self::Import { .. } => ("memory.importText.apply", "runId"),
            Self::Correct { .. } => ("memory.correct", "id"),
            Self::Forget { .. } => ("memory.forget", "tombstoneId"),
            Self::Propose { .. } => ("memory.propose", "proposalId"),
            Self::Rollback { .. } => ("memory.importText.rollback", "runId"),
        }
    }

    fn receipt_matches(&self, receipt: &EffectReceipt, target: &Target) -> bool {
        if receipt.agent_id != target.agent_id || !valid_id(&receipt.id) || receipt.changed != 1 {
            return false;
        }
        match self {
            Self::Correct { id, .. } | Self::Rollback { id } => receipt.id == *id,
            _ => true,
        }
    }
}

impl Service<'_> {
    /// Submit one approved procedural record to the configured bridge.
    pub fn handoff(&mut self, id: &str, who: &Principal, port: &mut dyn Handoff) -> R<bool> {
        if !port.available() {
            return Ok(false);
        }
        let read = self.authorized_finding(id, who)?;
        if !equals(&read.finding, "kind", "procedural")
            || !equals(&read.finding, "status", "waiting-h3")
        {
            return Ok(false);
        }
        let hash = digest(&read.finding);
        if self.store.handoff_exists(id, &hash)? {
            return Ok(false);
        }
        let key = format!("learn:{id}:{hash}");
        self.audit_decision(who, &read.target, id, "learning.handoff")?;
        let receipt = port.submit(&read.finding, &key)?;
        if receipt.finding != id || receipt.hash != hash || !valid_id(&receipt.receipt) {
            return Err(unavailable("handoff-unconfirmed"));
        }
        let current = self.authorized_finding(id, who)?;
        if digest(&current.finding) != hash {
            return Err(unavailable("finding-changed"));
        }
        self.store.record_handoff(id, &hash, &receipt.receipt)
    }

    /// Read the live owner's counterfactual calibration without evidence text.
    pub fn calibration(&self, target: &Target, who: &Principal) -> R<V> {
        current(self.source, target, who, self.clock.now()).map_err(|_| denied())?;
        super::config::calibration(self.store, &target.owner, &["small".into(), "large".into()])
    }

    fn authorized_finding(&self, id: &str, who: &Principal) -> R<Reviewed> {
        if who.kind != Some(PrincipalKind::Person) {
            return Err(denied());
        }
        let finding = self
            .store
            .finding(id)?
            .ok_or_else(|| unavailable("finding-not-found"))?;
        let target = target(&finding)?;
        if who.user_id != target.owner {
            return Err(denied());
        }
        let live = current(self.source, &target, who, self.clock.now()).map_err(|_| denied())?;
        let evidence = if target.scope == "installation" && finding.get("toolPattern").is_some() {
            let rights = ActiveRights {
                source: self.source,
                clock: self.clock,
            };
            if !array(&finding, "evidence")
                .map_err(|_| denied())?
                .iter()
                .all(|r| rights.evidence(&target, r))
            {
                return Err(denied());
            }
            Vec::new()
        } else {
            let sessions = load_evidence(&target, who, self.source, self.clock, &finding, &[])
                .map_err(|_| denied())?;
            evidence_view(&finding, &sessions).map_err(|_| denied())?
        };
        current(self.source, &target, who, self.clock.now()).map_err(|_| denied())?;
        Ok(Reviewed {
            finding,
            target,
            live,
            evidence,
        })
    }

    /// Reconcile stored learning material against current authorization and source identity.
    pub fn reconcile(&self, checkpoint_days: i64) -> R<()> {
        self.store.reconcile(
            self.clock.now(),
            checkpoint_days,
            &ActiveRights {
                source: self.source,
                clock: self.clock,
            },
        )
    }

    /// Read a finding after checking its live evidence, with its optimistic revision hash.
    pub fn get(&self, id: &str, who: &Principal) -> R<V> {
        let reviewed = self.authorized_finding(id, who)?;
        let f = reviewed.finding;
        let revision = f.get("revision").and_then(V::as_f64).ok_or_else(denied)? as i64;
        Ok(V::obj([
            ("contentHash", V::s(&digest(&f))),
            ("finding", f),
            ("evidence", V::Arr(reviewed.evidence)),
            ("prediction", self.store.prediction(id)?.unwrap_or(V::Null)),
            (
                "action",
                self.store.action(id, revision)?.unwrap_or(V::Null),
            ),
        ]))
    }

    /// Return only content-free, reauthorized finding summaries for this target.
    pub fn list(&self, target: &Target, who: &Principal, offset: usize) -> R<V> {
        current(self.source, target, who, self.clock.now()).map_err(|_| denied())?;
        let rows = self.store.target_findings(target, 51, offset)?;
        let more = rows.len() > 50;
        let mut items = Vec::new();
        for row in rows.into_iter().take(50) {
            let id = field(&row, "id")?;
            let Ok(read) = self.authorized_finding(&id, who) else {
                continue;
            };
            if read.target != *target {
                continue;
            }
            let mut projection = crate::toolcall::json::Obj::new();
            for key in [
                "id",
                "kind",
                "change",
                "status",
                "score",
                "desiredTier",
                "skeptic",
                "prevalence",
                "revision",
            ] {
                if let Some(value) = read.finding.get(key) {
                    projection.set(key, value.clone());
                }
            }
            items.push(V::Obj(projection));
        }
        Ok(V::obj([
            ("items", V::Arr(items)),
            (
                "nextOffset",
                if more {
                    V::Num((offset + 50) as f64)
                } else {
                    V::Null
                },
            ),
        ]))
    }

    /// Commit an explicit authenticated review and any confirmed receipt.
    pub fn decide(&mut self, request: ReviewRequest<'_>, who: &Principal) -> R<V> {
        if who.kind != Some(PrincipalKind::Person) {
            return Err(denied());
        }
        let before = self
            .store
            .finding(request.id)?
            .ok_or_else(|| unavailable("finding-not-found"))?;
        if target(&before)?.owner != who.user_id {
            return Err(denied());
        }
        self.reconcile(7)?;
        let reviewed = self.authorized_finding(request.id, who)?;
        let f = &reviewed.finding;
        let target = &reviewed.target;
        if digest(f) != request.content_hash {
            return Err(unavailable("finding-changed"));
        }
        if equals(f, "kind", "procedural") {
            return Err(unavailable("waiting-h3"));
        }
        if !equals(f, "kind", "knowledge") || !equals(f, "status", "pending") {
            return Err(unavailable("finding-not-pending"));
        }
        let revision = f.get("revision").and_then(V::as_f64).ok_or_else(denied)? as i64;
        if self
            .store
            .action(request.id, revision)?
            .is_some_and(|a| !equals(&a, "state", "refused"))
        {
            return Err(unavailable("action-awaits-reconciliation"));
        }
        if request.decision == Decision::Rejected {
            self.audit_decision(who, target, request.id, "rejected")?;
            self.store.decide(
                request.id,
                &who.user_id,
                request.content_hash,
                Decision::Rejected,
                self.clock.now(),
                &V::obj([]),
            )?;
            return Ok(V::obj([("status", V::s("rejected"))]));
        }
        let text = field(f, "text")?;
        let change = field(f, "change")?;
        let key = format!("learn-{}-{revision}", request.id);
        let effect;
        let id;
        if change == "add" {
            if target.scope != "agent" {
                return Err(unavailable("unsupported-target"));
            }
            if crate::js::js_trim(&text).is_empty() {
                return Err(denied());
            }
            effect = Effect::Import {
                text: &text,
                idempotency_key: &key,
            };
        } else {
            id = field(f, "memoryId").map_err(|_| unavailable("memory-id-required"))?;
            let shown = self
                .memory
                .show(&reviewed.live, &target.agent_id, &id)?
                .ok_or_else(denied)?;
            let expected = if target.scope == "project" {
                "workspace"
            } else {
                "agent-private"
            };
            if shown.scope != expected {
                return Err(denied());
            }
            let choice = match change.as_str() {
                "correct" => StaleChoice::Correct,
                "stale" => request
                    .stale_action
                    .ok_or_else(|| unavailable("stale-choice-required"))?,
                "duplicate" | "retire" => StaleChoice::Forget,
                _ => return Err(denied()),
            };
            effect = match (shown.shared_by.is_some(), choice) {
                (true, _) => Effect::Propose {
                    id: &id,
                    text: &text,
                },
                (false, StaleChoice::Correct) => Effect::Correct {
                    id: &id,
                    text: &text,
                },
                (false, StaleChoice::Forget) => Effect::Forget { id: &id },
            };
        }
        let fresh = self.authorized_finding(request.id, who)?;
        if digest(&fresh.finding) != request.content_hash {
            return Err(unavailable("finding-changed"));
        }
        let now = self.clock.now();
        if !can_write(who, target, &effect, now) || !can_write(&fresh.live, target, &effect, now) {
            return Err(denied());
        }
        let (operation, receipt_key) = effect.operation();
        self.audit_decision(who, target, request.id, operation)?;
        self.store
            .start_action(request.id, &who.user_id, request.content_hash)?;
        let result = match self.memory.apply(&fresh.live, &target.agent_id, effect) {
            Ok(result) => result,
            Err(EffectFailure::Refused) => {
                self.store
                    .refuse_action(request.id, &who.user_id, request.content_hash)?;
                return Err(unavailable("effect-refused"));
            }
            Err(EffectFailure::Unknown) => return Err(unavailable("action-awaits-reconciliation")),
        };
        let still = self.authorized_finding(request.id, who)?;
        if digest(&still.finding) != request.content_hash {
            return Err(unavailable("finding-changed"));
        }
        let effect_matches = result.agent_id == target.agent_id
            && valid_id(&result.id)
            && result.changed == 1
            && (operation != "memory.correct" || equals(f, "memoryId", &result.id));
        if !effect_matches {
            return Err(unavailable(if operation == "memory.importText.apply" {
                "import-not-applied"
            } else {
                "action-awaits-reconciliation"
            }));
        }
        let receipt = V::obj([
            ("operation", V::s(operation)),
            (receipt_key, V::s(&result.id)),
        ]);
        self.store.decide(
            request.id,
            &who.user_id,
            request.content_hash,
            Decision::Accepted,
            self.clock.now(),
            &receipt,
        )?;
        Ok(V::obj([("status", V::s("accepted")), ("receipt", receipt)]))
    }

    fn audit_decision(
        &mut self,
        who: &Principal,
        target: &Target,
        id: &str,
        operation: &str,
    ) -> R<()> {
        self.audit
            .append(&AuditEvent {
                at: self.clock.now(),
                user: who.user_id.clone(),
                host: String::new(),
                action: "learning.review".into(),
                target: target.agent_id.clone(),
                detail: vec![
                    ("findingId".into(), json!(id)),
                    ("operation".into(), json!(operation)),
                ],
            })
            .map_err(|_| denied())
    }

    /// Roll back a confirmed import through the existing scoped boundary.
    pub fn rollback(&mut self, id: &str, who: &Principal) -> R<V> {
        let review = self.authorized_finding(id, who)?;
        let revision = review
            .finding
            .get("revision")
            .and_then(V::as_f64)
            .ok_or_else(denied)? as i64;
        let action = self
            .store
            .action(id, revision)?
            .filter(|a| equals(a, "state", "completed"))
            .ok_or_else(|| unavailable("rollback-unavailable"))?;
        let receipt = action
            .get("receipt")
            .filter(|r| equals(r, "operation", "memory.importText.apply"))
            .ok_or_else(|| unavailable("rollback-unavailable"))?;
        let run = field(receipt, "runId")?;
        let effect = Effect::Rollback { id: &run };
        if !valid_id(&run)
            || !can_write(who, &review.target, &effect, self.clock.now())
            || !can_write(&review.live, &review.target, &effect, self.clock.now())
        {
            return Err(denied());
        }
        self.audit_decision(who, &review.target, id, "memory.importText.rollback")?;
        let result = self
            .memory
            .apply(
                &review.live,
                &review.target.agent_id,
                Effect::Rollback { id: &run },
            )
            .map_err(|_| unavailable("rollback-unavailable"))?;
        if !effect.receipt_matches(&result, &review.target) {
            return Err(unavailable("rollback-unavailable"));
        }
        current(self.source, &review.target, who, self.clock.now()).map_err(|_| denied())?;
        Ok(V::obj([
            ("runId", V::s(&result.id)),
            ("changed", V::Num(result.changed as f64)),
        ]))
    }
}

#[cfg(test)]
#[path = "service_vectors.rs"]
mod vectors;
