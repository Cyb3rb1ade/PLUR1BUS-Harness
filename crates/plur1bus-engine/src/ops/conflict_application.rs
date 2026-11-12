//! Confirmed primary safeUpdate with a durable frozen plan and exact before/after replay.
use super::*;
use crate::{ops::conflict_application_state as state, store::RowPatch, text::json::write_json};
/// Trusted native host adapter. The runtime must supply an actual explicit-confirmation verifier.
/// It must check purpose, exact fingerprint/operation/caller, proof and expiry, and permit an
/// idempotent retry of the same grant if receipt publication failed. No default allow exists.
/// Verification is bounded/local because the component holds its writer leases during this call.
pub trait ConfirmationVerifier: Send + Sync {
    /// A recommendation, a boolean flag or knowledge of the fingerprint alone is never a proof.
    fn verify(&self, request: &ConfirmationCheck<'_>, cancel: &Cancel) -> Result<(), EngineError>;
}
/// Exact original binding presented to the trusted verifier; deliberately not Debug/Serialize.
pub struct ConfirmationCheck<'a> {
    /// Fixed purpose, never selected by model output.
    pub command: &'static str,
    /// Original application operation.
    pub operation_id: uuid::Uuid,
    /// Complete reviewed immutable plan binding.
    pub fingerprint: &'a str,
    /// Original authenticated caller, including chat/account.
    pub principal: &'a Principal,
    /// Original execution context.
    pub agent: &'a AgentContext,
    /// Explicit host proof, never saved in a receipt or diagnostic.
    pub proof: &'a str,
    /// Current host timestamp for strict grant expiry checks.
    pub now_ms: i64,
}
/// An explicit proof and trusted verifier, required only before the durable confirmed receipt.
pub struct ApplicationAuthorization<'a> {
    /// Real native host confirmation service; fixtures can provide an offline fake.
    pub verifier: &'a dyn ConfirmationVerifier,
    /// Explicit proof, limited to 4096 bytes, not an automatically created permission.
    pub proof: &'a str,
}
/// Durable primary version-chain result. Optional Neo graph effects are a separate integration.
#[derive(Debug)]
pub struct ApplicationResult {
    /// Superseded private source.
    pub old_id: String,
    /// Exact frozen durable successor.
    pub new_id: String,
    /// An already confirmed receipt was resumed, without invoking a new grant.
    pub replayed: bool,
}
impl ConflictLedger {
    /// Deterministic test-only failure cuts after durable stages.
    #[cfg(feature = "testkit")]
    pub fn with_application_observer(mut self, observer: ApplicationObserver) -> Self {
        self.application_observer = Some(observer);
        self
    }
    fn observe_application(&self, stage: &str) -> Result<(), EngineError> {
        #[cfg(feature = "testkit")]
        if let Some(observer) = &self.application_observer {
            return observer(stage);
        }
        let _ = stage;
        Ok(())
    }
    /// Verify explicit approval, persist its exact plan, then commit successor before superseding.
    /// Errors may follow partial durable writes. Retain the original plan and retry it unchanged.
    /// A saved confirmed receipt permits exact replay only under the same currently authorized caller.
    pub fn apply_application(
        &self,
        plan: &ApplicationPlan,
        authorization: Option<&ApplicationAuthorization<'_>>,
        principal: &Principal,
        agent: &AgentContext,
        cancel: &Cancel,
    ) -> Result<ApplicationResult, EngineError> {
        self.settle_application(plan, authorization, principal, agent, cancel, false)
    }
    pub(super) fn settle_application(
        &self,
        plan: &ApplicationPlan,
        authorization: Option<&ApplicationAuthorization<'_>>,
        principal: &Principal,
        agent: &AgentContext,
        cancel: &Cancel,
        validate_only: bool,
    ) -> Result<ApplicationResult, EngineError> {
        if serde_json::to_value(principal).map_err(|_| StoreError::Corrupt)? != plan.principal
            || serde_json::to_value(agent).map_err(|_| StoreError::Corrupt)? != plan.agent
            || plan.digest()? != plan.fingerprint
        {
            return Err(StoreError::InvalidInput.into());
        }
        self.transaction_with_journal(
            principal,
            agent,
            cancel,
            |workspace, dir, proof, binding, ctx, check| {
                CaptureJournal::guard_non_application_pending(dir, cancel)?;
                let name = format!(
                    "native-conflict-application-{}.json",
                    hash(format!("{binding}:{}", plan.operation_id).as_bytes())
                );
                let mut inventory = state::receipts(dir, cancel)?;
                if inventory
                    .iter()
                    .any(|(file, receipt, _)| file != &name && !receipt.complete)
                {
                    return Err(StoreError::Busy.into());
                }
                let old = inventory
                    .iter()
                    .position(|(file, _, _)| file == &name)
                    .map(|i| inventory.remove(i));
                let replayed = old.is_some();
                let proof: Value =
                    serde_json::from_str(&write_json(proof)).map_err(|_| StoreError::Corrupt)?;
                let (mut receipt, old_bytes) = match old {
                    Some((_, receipt, bytes)) => {
                        if receipt.plan != plan.payload()
                            || receipt.fingerprint != plan.fingerprint
                            || receipt.proof != proof
                        {
                            return Err(StoreError::InvalidInput.into());
                        }
                        (receipt, Some(bytes))
                    }
                    None => (
                        state::Receipt {
                            version: 1,
                            plan: plan.payload(),
                            fingerprint: plan.fingerprint.clone(),
                            proof,
                            complete: false,
                        },
                        None,
                    ),
                };
                let store = self.application_replay_store(plan, ctx)?;
                let preflight = |complete| -> Result<(), EngineError> {
                    check()?;
                    self.application_references(plan, workspace, ctx, cancel)?;
                    self.application_rows(plan, &store, ctx, complete)?;
                    check()
                };
                preflight(receipt.complete)?;
                if validate_only {
                    if !replayed {
                        return Err(StoreError::Corrupt.into());
                    }
                    return Ok(ApplicationResult {
                        old_id: plan.sources.existing.row.id.clone(),
                        new_id: plan.successor.id.clone(),
                        replayed,
                    });
                }
                let before_confirmation = || -> Result<(), EngineError> {
                    preflight(false)?;
                    let current = store
                        .get_record(&plan.sources.existing.row.id)?
                        .ok_or(StoreError::InvalidInput)?;
                    if !same(&current, &plan.sources.existing)?
                        || store.get_record(&plan.successor.id)?.is_some()
                    {
                        return Err(StoreError::InvalidInput.into());
                    }
                    Ok(())
                };
                if !replayed {
                    before_confirmation()?;
                    let auth = authorization.ok_or(StoreError::InvalidInput)?;
                    if auth.proof.is_empty() || auth.proof.len() > 4096 {
                        return Err(StoreError::InvalidInput.into());
                    }
                    auth.verifier.verify(
                        &ConfirmationCheck {
                            command: "conflict-apply",
                            operation_id: plan.operation_id,
                            fingerprint: &plan.fingerprint,
                            principal,
                            agent,
                            proof: auth.proof,
                            now_ms: self.reader.context.host().now_ms(),
                        },
                        cancel,
                    )?;
                    before_confirmation()?;
                }
                let mut bytes = match old_bytes {
                    Some(bytes) => bytes,
                    None => state::save(dir, &name, None, &receipt, cancel, &before_confirmation)?,
                };
                self.observe_application("confirmed")?;
                if store.get_record(&plan.successor.id)?.is_none() {
                    preflight(false)?;
                    store.upsert(std::slice::from_ref(&plan.successor))?;
                }
                preflight(receipt.complete)?;
                self.observe_application("successor")?;
                let current = store
                    .get_record(&plan.sources.existing.row.id)?
                    .ok_or(StoreError::InvalidInput)?;
                if same(&current, &plan.sources.existing)? {
                    preflight(false)?;
                    store.patch(
                        &plan.sources.existing.row.id,
                        &RowPatch {
                            status: Some("superseded".into()),
                            superseded_by: Some(plan.successor.id.clone()),
                            updated_at: Some(plan.now as f64),
                            ..Default::default()
                        },
                    )?;
                }
                preflight(true)?;
                self.observe_application("superseded")?;
                if !receipt.complete {
                    receipt.complete = true;
                    bytes = state::save(dir, &name, Some(&bytes), &receipt, cancel, &|| {
                        preflight(true)
                    })?;
                }
                let _ = bytes;
                self.observe_application("complete")?;
                preflight(true)?;
                Ok(ApplicationResult {
                    old_id: plan.sources.existing.row.id.clone(),
                    new_id: plan.successor.id.clone(),
                    replayed,
                })
            },
        )
    }
    fn application_replay_store(
        &self,
        plan: &ApplicationPlan,
        ctx: &RequestContext,
    ) -> Result<Arc<Store>, EngineError> {
        let before = &plan.sources.existing;
        safe_update::authorize(&before.row, ctx)?;
        if before.row.scope != "agent-private"
            || before.row.agent_id != ctx.agent_id.as_str()
            || before.row.stored_by != ctx.agent_id.as_str()
            || before.row.owner_user_id != ctx.owner_user_id
            || before.row.workspace_key != ctx.workspace_key
            || before.sharing.is_some()
            || !self
                .reader
                .visible(before, ctx, self.reader.context.host().now_ms())?
        {
            return Err(StoreError::InvalidInput.into());
        }
        let identity = try_identity_id(&plan.identity)?;
        if identity != try_identity_id(self.reader.embedding_identity())? {
            return Err(StoreError::InvalidInput.into());
        }
        let mut selected: Option<Arc<Store>> = None;
        for source in self.reader.stores.sources(ctx)? {
            if source.kind != SourceKind::Private
                || source.store.get_record(&before.row.id)?.is_none()
            {
                continue;
            }
            if try_identity_id(source.store.identity().ok_or(StoreError::InvalidInput)?)?
                != identity
                || selected
                    .as_ref()
                    .is_some_and(|s| !Arc::ptr_eq(s, &source.store))
            {
                return Err(StoreError::InvalidInput.into());
            }
            selected = Some(source.store);
        }
        selected.ok_or_else(|| StoreError::InvalidInput.into())
    }
    fn application_references(
        &self,
        plan: &ApplicationPlan,
        workspace: &TrustedDirectory,
        ctx: &RequestContext,
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        let dir = workspace.open_child(".adaptive-learning")?;
        let observed =
            io::read(&dir, LOG, io::MAX_BYTES, cancel)?.ok_or(StoreError::InvalidInput)?;
        if !io::records(&observed)?
            .iter()
            .any(|(row, _)| owned(row, ctx) && row == &plan.proposal["original"])
        {
            return Err(StoreError::InvalidInput.into());
        }
        let bytes = io::read(&dir, "conflict-resolved.jsonl", io::MAX_BYTES, cancel)?
            .ok_or(StoreError::InvalidInput)?;
        let rows = io::records(&bytes)?;
        let current = rows.iter().rev().find(|(row, _)| {
            owned(row, ctx)
                && row["recommendation"] == "apply_via_safe_reconsolidation"
                && row["dryRun"] == false
                && (row["original"]["newMemoryId"] == plan.sources.new.row.id
                    || row["original"]["existingMemoryId"] == plan.sources.new.row.id)
        });
        if current.is_none_or(|(row, _)| row != &plan.proposal) {
            return Err(StoreError::InvalidInput.into());
        }
        dir.assert_unchanged()?;
        Ok(())
    }
    fn application_rows(
        &self,
        plan: &ApplicationPlan,
        store: &Store,
        ctx: &RequestContext,
        complete: bool,
    ) -> Result<(), EngineError> {
        let now = self.reader.context.host().now_ms();
        let new = self
            .reader
            .find_visible_record(&plan.sources.new.row.id, ctx, now)?;
        if !same(&new, &plan.sources.new)?
            || !self.reader.visible(&plan.sources.existing, ctx, now)?
        {
            return Err(StoreError::InvalidInput.into());
        }
        // Recheck route/model as well as data around every durable publication.
        self.application_replay_store(plan, ctx)?;
        let current = store
            .get_record(&plan.sources.existing.row.id)?
            .ok_or(StoreError::InvalidInput)?;
        let mut after = plan.sources.existing.row.clone();
        after.status = "superseded".into();
        after.superseded_by = plan.successor.id.clone();
        after.updated_at = serde_json::Number::from(plan.now);
        let superseded = same(
            &current,
            &MemoryRecord {
                row: crate::store::row::persisted_projection(&after)?,
                sharing: None,
            },
        )?;
        if !superseded && (complete || !same(&current, &plan.sources.existing)?) {
            return Err(StoreError::InvalidInput.into());
        }
        match store.get_record(&plan.successor.id)? {
            None if !superseded && !complete => (),
            Some(actual)
                if same(
                    &actual,
                    &MemoryRecord {
                        row: plan.successor.clone(),
                        sharing: None,
                    },
                )? && self.reader.visible(&actual, ctx, now)? => {}
            _ => return Err(StoreError::InvalidInput.into()),
        }
        Ok(())
    }
}
fn same(a: &MemoryRecord, b: &MemoryRecord) -> Result<bool, EngineError> {
    Ok(a.sharing == b.sharing
        && serde_json::to_value(&a.row).map_err(|_| StoreError::Corrupt)?
            == serde_json::to_value(&b.row).map_err(|_| StoreError::Corrupt)?)
}
