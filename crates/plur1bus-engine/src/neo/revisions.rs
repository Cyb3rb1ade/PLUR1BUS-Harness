//! Actual C4 revision writer: locked source authorization, durable audit, then queue publication.
//! Runtime composition must supply a human-operation policy to CaptureJournal. No wire grant,
//! confirmation, or ProcessEngine/Core activation is inferred by constructing this native adapter.
use super::{
    capture_journal::CaptureJournal,
    derived_fields::{bool_field, field, set, str_field, text},
    revision_io as io, revision_plan as plan,
};
use crate::{
    context::RequestContext,
    contract::{AgentContext, Cancel, EngineError, HostServices, Principal, StoreError},
    store::directory::TrustedDirectory,
    text::json::TolerantJsonValue as Json,
};
use chrono::{SecondsFormat, TimeZone, Utc};
use std::sync::Arc;
use uuid::Uuid;

#[cfg(feature = "testkit")]
type Observer = Arc<dyn Fn(&str) -> Result<(), EngineError> + Send + Sync>;

/// Closed human C4 actions. Keep/drop deliberately do not schedule embeddings, as in Node.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Action {
    /// Resolve by retaining the card.
    Keep,
    /// Resolve by reducing its salience.
    Drop,
    /// Explicit memory promotion.
    Promote,
    /// Explicit memory demotion.
    Demote,
    /// Exclude from embeddings.
    Prune,
    /// Mark the Neo card deleted; not a primary-memory forget operation.
    Tombstone,
}
impl Action {
    /// Parse exact supported commands.
    pub fn parse(value: &str) -> Option<Self> {
        [
            Self::Keep,
            Self::Drop,
            Self::Promote,
            Self::Demote,
            Self::Prune,
            Self::Tombstone,
        ]
        .into_iter()
        .find(|action| action.as_str() == value)
    }
    /// Node command spelling.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Keep => "keep",
            Self::Drop => "drop",
            Self::Promote => "promote",
            Self::Demote => "demote",
            Self::Prune => "prune",
            Self::Tombstone => "tombstone",
        }
    }
    pub(super) const fn status(self) -> super::status::Status {
        use super::status::Status;
        match self {
            Self::Keep | Self::Promote => Status::Promoted,
            Self::Drop | Self::Demote => Status::Demoted,
            Self::Prune => Status::Pruned,
            Self::Tombstone => Status::Tombstoned,
        }
    }
    pub(super) const fn curation(self) -> bool {
        matches!(self, Self::Keep | Self::Drop)
    }
}
/// Native compare-and-set request. The snapshot is evidence to compare, never an ACL grant.
/// Keep this exact request for retries. A changed revision requires a fresh explicit decision.
pub struct RevisionRequest {
    /// Stable operation identity, retained with the last receipt in this workspace.
    pub operation_id: Uuid,
    /// Complete expected current source, including its original authority fields.
    pub expected: Json,
    /// Closed requested transition.
    pub action: Action,
}
/// Persisted revision and source type.
#[derive(Debug)]
pub struct RevisionResult {
    /// Exact revised metadata, including unchanged source authority and opaque UTF-16 fields.
    pub record: Json,
    /// `behavior` or `candidates`.
    pub store: String,
}
/// C4 operation adapter; each call retains and revalidates the actual original caller.
pub struct RevisionStore {
    journal: Arc<CaptureJournal>,
    host: Arc<dyn HostServices>,
    #[cfg(feature = "testkit")]
    observer: Option<Observer>,
}
impl RevisionStore {
    /// No files are created and no authority is granted here.
    pub fn new(journal: Arc<CaptureJournal>, host: Arc<dyn HostServices>) -> Self {
        Self {
            journal,
            host,
            #[cfg(feature = "testkit")]
            observer: None,
        }
    }
    /// Open the human-operation component and finish its original callers' prepared revisions.
    /// The supplied journal must enforce the human-operation policy, not automatic capture's.
    /// A malformed or currently unauthorized active plan refuses opening without a new grant.
    pub fn open(
        journal: Arc<CaptureJournal>,
        host: Arc<dyn HostServices>,
    ) -> Result<Self, EngineError> {
        let store = Self::new(journal, host);
        store.recover_pending(&Cancel::never())?;
        Ok(store)
    }
    /// Fully preflight a bounded read-only inventory before resuming any original caller.
    /// Returns the number of pending operations actually completed, with no identifying output.
    pub fn recover_pending(&self, cancel: &Cancel) -> Result<usize, EngineError> {
        let cancel =
            cancel.limited_to(std::time::Instant::now() + std::time::Duration::from_secs(300));
        let callers = self.journal.revision_callers(&cancel)?;
        let mut completed = 0;
        for caller in callers {
            if self
                .recover(&caller.principal, &caller.agent, &cancel)?
                .is_some()
            {
                completed += 1;
            }
        }
        Ok(completed)
    }
    /// Fault injection after durable stages, never a production environment switch.
    #[cfg(feature = "testkit")]
    pub fn with_observer(mut self, observer: Observer) -> Self {
        self.observer = Some(observer);
        self
    }
    fn observe(&self, _stage: &str) -> Result<(), EngineError> {
        #[cfg(feature = "testkit")]
        if let Some(observer) = &self.observer {
            observer(_stage)?;
        }
        Ok(())
    }
    /// Apply under shared native and Node writer leases. A completed identical request is
    /// idempotent while its source still matches; older requests fail the source CAS after a
    /// later operation. One bounded pending/last receipt is retained, without a growing ledger.
    pub fn apply(
        &self,
        principal: &Principal,
        agent: &AgentContext,
        request: &RevisionRequest,
        cancel: &Cancel,
    ) -> Result<RevisionResult, EngineError> {
        self.execute(
            principal,
            agent,
            Some(request),
            plan::AuditMode::Tool,
            cancel,
        )?
        .ok_or(StoreError::Corrupt.into())
    }
    /// Human curation facade semantics: keep/drop only, unresolved visible source, mandatory
    /// `engine.memory.curation` audit durable before revision. Version-2 receipts preserve this
    /// order on recovery; existing version-1 tool receipts keep their original meaning.
    /// This native adapter still requires the original caller and a human-operation journal policy.
    pub fn apply_curation(
        &self,
        principal: &Principal,
        agent: &AgentContext,
        request: &RevisionRequest,
        cancel: &Cancel,
    ) -> Result<RevisionResult, EngineError> {
        self.execute(
            principal,
            agent,
            Some(request),
            plan::AuditMode::CurationFacade,
            cancel,
        )?
        .ok_or(StoreError::Corrupt.into())
    }
    /// Resume this exact original caller's pending operation without a new decision or clock.
    /// This explicit recovery API is not automatic ProcessEngine/Core startup composition.
    pub fn recover(
        &self,
        principal: &Principal,
        agent: &AgentContext,
        cancel: &Cancel,
    ) -> Result<Option<RevisionResult>, EngineError> {
        self.execute(principal, agent, None, plan::AuditMode::Tool, cancel)
    }
    fn execute(
        &self,
        principal: &Principal,
        agent: &AgentContext,
        request: Option<&RevisionRequest>,
        mode: plan::AuditMode,
        cancel: &Cancel,
    ) -> Result<Option<RevisionResult>, EngineError> {
        cancel.check()?;
        let ctx = RequestContext::build(principal, agent, self.host.as_ref())?;
        let caller = super::caller::encode(principal, agent)?;
        if let Some(request) = request {
            plan::validate_mode(request, &ctx, mode, cancel)?;
        }
        self.journal.with_operation_writer(
            principal,
            agent,
            &ctx,
            cancel,
            &|| Ok(()),
            |dir, proof, _, check| {
                // A prepared embedding mutation must finish before its source is revised.
                super::embedding_publication::guard_other_pending(dir, "", cancel)?;
                let workspace = TrustedDirectory::open(std::path::Path::new(
                    &str_field(proof, "workspaceDirectory")?.to_utf8_lossy(),
                ))?;
                let old = io::state(dir, cancel)?;
                let state = match (&old, request) {
                    (None, None) => return Ok(None),
                    (Some(old), None) if bool_field(old, "complete")? => return Ok(None),
                    (Some(old), _)
                        if !bool_field(old, "complete")?
                            || request.is_some_and(|r| {
                                field(old, "operation").ok()
                                    == Some(&text(&r.operation_id.to_string()))
                            }) =>
                    {
                        if field(old, "ownership")? != proof || field(old, "caller")? != &caller {
                            return Err(StoreError::InvalidInput.into());
                        }
                        if let Some(request) = request {
                            plan::matches(old, request, mode)?;
                        }
                        old.clone()
                    }
                    (_, Some(request)) => {
                        check()?;
                        let now = Utc
                            .timestamp_millis_opt(self.host.now_ms())
                            .single()
                            .ok_or(StoreError::InvalidInput)?
                            .to_rfc3339_opts(SecondsFormat::Millis, true);
                        plan::prepare(
                            &plan::Preparation {
                                mode,
                                dir,
                                workspace: &workspace,
                                proof,
                                caller: &caller,
                                ctx: &ctx,
                                cancel,
                            },
                            request,
                            &now,
                        )?
                    }
                    _ => return Err(StoreError::Corrupt.into()),
                };
                let original = super::caller::decode(field(&state, "caller")?)?;
                if self.journal.authorize_caller(&original, proof, cancel)? != ctx {
                    return Err(StoreError::InvalidInput.into());
                }
                let check = || -> Result<(), EngineError> {
                    check()?;
                    workspace.assert_unchanged()?;
                    if self.journal.authorize_caller(&original, proof, cancel)? != ctx {
                        return Err(StoreError::InvalidInput.into());
                    }
                    Ok(())
                };
                let result = plan::validate(dir, proof, &ctx, &state, cancel)?;
                let audit_dir = workspace.create_child(".adaptive-learning")?;
                io::preflight(dir, &audit_dir, &state, cancel)?;
                check()?;
                if old.as_ref() != Some(&state) {
                    io::save(dir, &state)?;
                }
                self.observe("prepared")?;
                let order = if plan::audit_mode(&state)? == plan::AuditMode::CurationFacade {
                    [(1, "audit"), (0, "revision"), (2, "queue")]
                } else {
                    [(0, "revision"), (1, "audit"), (2, "queue")]
                };
                for (index, stage) in order {
                    check()?;
                    let _ = plan::validate(dir, proof, &ctx, &state, cancel)?;
                    io::publish(dir, &audit_dir, &state, index, cancel, &check)?;
                    self.observe(stage)?;
                }
                check()?;
                io::indices(dir, cancel, &check)?;
                let mut done = state;
                set(&mut done, "complete", Json::Bool(true))?;
                check()?;
                io::save(dir, &done)?;
                self.observe("complete")?;
                Ok(Some(result))
            },
        )
    }
}
