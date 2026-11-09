//! Original-caller duplicate rejection: one audit occurrence per operation, no new memory row.
use super::*;
use crate::{
    capture::normal_store::StoreOutcome,
    ops::{curation_occurrence::Files, normal_duplicate_state as duplicate_state},
};
use uuid::Uuid;
/// Acknowledges only an original-operation duplicate-rejection audit occurrence.
#[derive(Debug)]
pub struct DuplicateStoreResult {
    /// Existing authorized duplicate memory ID, never the operation UUID as a new row.
    pub memory_id: String,
    /// This operation already had a retained durable intent.
    pub replayed: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SavedDuplicate {
    version: u8,
    command: String,
    pub(crate) operation_id: Uuid,
    principal: Value,
    agent: Value,
    params: String,
    assessed_at: i64,
    now_ms: i64,
    source: Record,
    score: f64,
    vector: Vec<f32>,
    identity: VectorSpaceIdentity,
    config_hash: String,
    store_binding: (PathBuf, (u64, u64)),
    state_binding: (PathBuf, (u64, u64)),
    registry_binding: (PathBuf, (u64, u64)),
    workspace_binding: (PathBuf, (u64, u64)),
}
pub(crate) type RestoredDuplicate = (SavedDuplicate, Principal, AgentContext);
pub(crate) fn restore_duplicate(
    value: &Value,
    cancel: &Cancel,
) -> Result<RestoredDuplicate, EngineError> {
    let saved: SavedDuplicate =
        serde_json::from_value(value.clone()).map_err(|_| StoreError::Corrupt)?;
    state::bounded_row(&saved.source.row, cancel)?;
    if saved.version != 1
        || saved.command != "memory-store-duplicate"
        || saved.operation_id.is_nil()
        || !saved.score.is_finite()
        || saved.vector.is_empty()
        || saved.vector.len() > 32768
        || saved.vector.iter().any(|v| !v.is_finite())
        || saved.identity.dimension.as_u64() != Some(saved.vector.len() as u64)
        || serde_json::to_value(&saved).map_err(|_| StoreError::Corrupt)? != *value
    {
        return Err(StoreError::Corrupt.into());
    }
    let p = serde_json::from_value(saved.principal.clone()).map_err(|_| StoreError::Corrupt)?;
    let a = serde_json::from_value(saved.agent.clone()).map_err(|_| StoreError::Corrupt)?;
    Ok((saved, p, a))
}
fn binding(dir: &TrustedDirectory) -> (PathBuf, (u64, u64)) {
    (dir.path().to_owned(), dir.identity_parts())
}
fn digest(value: &Value) -> Result<String, EngineError> {
    Ok(hash(
        &serde_json::to_vec(value).map_err(|_| StoreError::Corrupt)?,
    ))
}
impl SavedDuplicate {
    fn prepare(plan: &NormalCandidatePlan, id: Uuid, now: i64) -> Result<Self, EngineError> {
        let NormalCandidateKind::Duplicate {
            id: source_id,
            score,
        } = &plan.kind
        else {
            return Err(StoreError::InvalidInput.into());
        };
        let source = plan.source.clone().ok_or(StoreError::InvalidInput)?;
        if source.row.id != *source_id {
            return Err(StoreError::InvalidInput.into());
        }
        Ok(Self {
            version: 1,
            command: "memory-store-duplicate".into(),
            operation_id: id,
            principal: plan.principal.clone(),
            agent: plan.agent.clone(),
            params: write_json(&plan.params),
            assessed_at: plan.assessed_at,
            now_ms: now,
            source,
            score: *score,
            vector: plan.vector.clone(),
            identity: plan.identity.clone(),
            config_hash: digest(&plan.config)?,
            store_binding: plan.physical.clone(),
            state_binding: binding(&plan.state),
            registry_binding: binding(&plan.base),
            workspace_binding: binding(&plan.workspace),
        })
    }
    fn check(&self, plan: &NormalCandidatePlan) -> Result<(), EngineError> {
        let same_source = plan
            .source
            .as_ref()
            .map(|r| r.same(&self.source.record()))
            .transpose()?
            .unwrap_or(false);
        if self.principal != plan.principal
            || self.agent != plan.agent
            || self.params != write_json(&plan.params)
            || self.config_hash != digest(&plan.config)?
            || self.store_binding != plan.physical
            || self.state_binding != binding(&plan.state)
            || self.registry_binding != binding(&plan.base)
            || self.workspace_binding != binding(&plan.workspace)
            || try_identity_id(&self.identity)? != try_identity_id(&plan.identity)?
            || plan.kind
                != (NormalCandidateKind::Duplicate {
                    id: self.source.row.id.clone(),
                    score: self.score,
                })
            || !same_source
        {
            return Err(StoreError::InvalidInput.into());
        }
        Ok(())
    }
    fn event(&self, plan: &NormalCandidatePlan, cancel: &Cancel) -> Result<String, EngineError> {
        let ctx = &plan.context;
        let assessed = assess(
            &plan.params,
            StoreOwner {
                agent_id: ctx.agent_id.as_str(),
                owner_user_id: &ctx.owner_user_id,
                workspace_key: &ctx.workspace_key,
            },
            self.assessed_at,
            cancel,
        )?;
        let cfg =
            crate::config::effective_config(&plan.config).map_err(|_| StoreError::InvalidInput)?;
        Ok(assessed
            .effects(
                StoreOutcome::Duplicate {
                    id: &self.source.row.id,
                    score: self.score,
                },
                self.now_ms,
                cfg["schicht15"]["minImportance"].as_f64().unwrap_or(0.7),
                cancel,
            )?
            .into_external()?
            .curation_json)
    }
}
#[derive(Clone, Copy, PartialEq)]
enum Mode {
    AllowNew,
    ValidateExisting,
    ApplyExisting,
}
impl NativeMerge {
    /// Publish one original-operation duplicate rejection from an already admitted private selection.
    /// Distinct operations against the same memory have distinct audit occurrences, even with identical text.
    pub fn reject_selected_duplicate(
        &self,
        plan: &NormalCandidatePlan,
        operation_id: Uuid,
        principal: &Principal,
        agent: &AgentContext,
        cancel: &Cancel,
    ) -> Result<DuplicateStoreResult, EngineError> {
        self.duplicate_selected(plan, operation_id, principal, agent, cancel, Mode::AllowNew)
    }
    fn duplicate_selected(
        &self,
        plan: &NormalCandidatePlan,
        operation_id: Uuid,
        principal: &Principal,
        agent: &AgentContext,
        cancel: &Cancel,
        mode: Mode,
    ) -> Result<DuplicateStoreResult, EngineError> {
        cancel.check()?;
        if operation_id.is_nil() || !matches!(plan.kind, NormalCandidateKind::Duplicate { .. }) {
            return Err(StoreError::InvalidInput.into());
        }
        let _op = self.reader.context.enter(principal, agent)?;
        plan.check(self, principal, agent, cancel)?;
        let _gate = self.reader.context.mutation()?;
        self.journal.with_normal_duplicate_writer(
            principal,
            agent,
            &plan.context,
            cancel,
            &|| plan.check(self, principal, agent, cancel),
            |dir, proof, binding_id, check| {
                CaptureJournal::guard_non_merge_pending(dir, cancel)?;
                state::guard_pending(dir, cancel)?;
                crate::ops::conflict_application_state::guard_pending(dir, cancel)?;
                let proof_text = write_json(proof);
                if plan
                    .proof
                    .as_ref()
                    .is_some_and(|p| p != &(proof_text.clone(), binding_id.into()))
                {
                    return Err(StoreError::InvalidInput.into());
                }
                let proof: Value =
                    serde_json::from_str(&proof_text).map_err(|_| StoreError::Corrupt)?;
                let name = format!(
                    "native-normal-duplicate-{}.json",
                    hash(format!("{binding_id}:{operation_id}").as_bytes())
                );
                let mut inventory = duplicate_state::receipts(dir, cancel)?;
                if inventory.iter().any(|(n, r, _)| n != &name && !r.complete) {
                    return Err(StoreError::Busy.into());
                }
                let old = inventory
                    .iter()
                    .position(|(n, _, _)| n == &name)
                    .map(|i| inventory.remove(i));
                let replayed = old.is_some();
                if !replayed && mode != Mode::AllowNew {
                    return Err(StoreError::Corrupt.into());
                }
                let (saved, mut receipt, mut bytes, files) = if let Some((_, receipt, bytes)) = old
                {
                    let (saved, _, _) = restore_duplicate(&receipt.plan, cancel)?;
                    if saved.operation_id != operation_id || receipt.proof != proof {
                        return Err(StoreError::Corrupt.into());
                    }
                    saved.check(plan)?;
                    let files = Files::restore(
                        &plan.workspace,
                        &receipt.publication,
                        &saved.event(plan, cancel)?,
                        receipt.complete,
                        cancel,
                    )?;
                    (saved, receipt, Some(bytes), files)
                } else {
                    let (kind, source) = self.query_normal(plan, cancel, check)?;
                    let original = plan.source.as_ref().ok_or(StoreError::InvalidInput)?;
                    let same_source = source
                        .as_ref()
                        .map(|r| r.same(&original.record()))
                        .transpose()?
                        .unwrap_or(false);
                    if kind != plan.kind || !same_source {
                        return Err(StoreError::Busy.into());
                    }
                    let saved = SavedDuplicate::prepare(
                        plan,
                        operation_id,
                        self.reader.context.host().now_ms(),
                    )?;
                    let files =
                        Files::prepare(&plan.workspace, saved.event(plan, cancel)?, cancel)?;
                    let value = serde_json::to_value(&saved).map_err(|_| StoreError::Corrupt)?;
                    let fingerprint = format!("sha256:{}", digest(&value)?);
                    let receipt = duplicate_state::Receipt {
                        version: 1,
                        plan: value,
                        fingerprint,
                        proof,
                        publication: files.snapshot.clone(),
                        complete: false,
                    };
                    (saved, receipt, None, files)
                };
                let was_complete = receipt.complete;
                let checked = || {
                    check()?;
                    self.private(&saved.source.record(), &plan.context)?;
                    let actual = plan
                        .store
                        .get_record(&saved.source.row.id)?
                        .ok_or(StoreError::InvalidInput)?;
                    self.private(&actual, &plan.context)?;
                    if !saved.source.same(&actual)? {
                        return Err(StoreError::InvalidInput.into());
                    }
                    let ctx = &plan.context;
                    let assessed = assess(
                        &plan.params,
                        StoreOwner {
                            agent_id: ctx.agent_id.as_str(),
                            owner_user_id: &ctx.owner_user_id,
                            workspace_key: &ctx.workspace_key,
                        },
                        saved.assessed_at,
                        cancel,
                    )?;
                    if plan.forgotten(assessed.text())? {
                        return Err(StoreError::InvalidInput.into());
                    }
                    files.validate(was_complete, cancel)?;
                    check()
                };
                checked()?;
                if mode == Mode::ValidateExisting {
                    return Ok(DuplicateStoreResult {
                        memory_id: saved.source.row.id,
                        replayed,
                    });
                }
                if bytes.is_none() {
                    bytes = Some(duplicate_state::save(
                        dir, &name, None, &receipt, cancel, &checked,
                    )?);
                }
                self.observe("normal-duplicate-prepared")?;
                files.publish(cancel, &checked)?;
                self.observe("normal-duplicate-write")?;
                if !receipt.complete {
                    receipt.complete = true;
                    duplicate_state::save(dir, &name, bytes.as_deref(), &receipt, cancel, &|| {
                        checked()?;
                        files.validate(true, cancel)
                    })?;
                }
                self.observe("normal-duplicate-complete")?;
                checked()?;
                files.validate(true, cancel)?;
                Ok(DuplicateStoreResult {
                    memory_id: saved.source.row.id,
                    replayed,
                })
            },
        )
    }
    pub(crate) fn recover_duplicate(
        &self,
        saved: &SavedDuplicate,
        principal: &Principal,
        agent: &AgentContext,
        cancel: &Cancel,
        validate_only: bool,
    ) -> Result<DuplicateStoreResult, EngineError> {
        let context = RequestContext::build(principal, agent, self.reader.context.host())?;
        let store = self.selected_store(&context, &saved.identity)?;
        let plan = NormalCandidatePlan {
            kind: NormalCandidateKind::Duplicate {
                id: saved.source.row.id.clone(),
                score: saved.score,
            },
            source: Some(saved.source.clone()),
            params: parse_json(&saved.params).map_err(|_| StoreError::Corrupt)?,
            vector: saved.vector.clone(),
            assessed_at: saved.assessed_at,
            principal: saved.principal.clone(),
            agent: saved.agent.clone(),
            config: serde_json::to_value(self.reader.context.host().config())
                .map_err(|_| StoreError::Corrupt)?,
            identity: saved.identity.clone(),
            physical: store.physical_binding()?,
            store,
            workspace: TrustedDirectory::open(
                &self.reader.context.destructive_workspace(&context)?,
            )?,
            base: TrustedDirectory::open(&self.reader.base)?,
            state: TrustedDirectory::open(self.reader.context.host().state_dir())?,
            context,
            proof: None,
        };
        saved.check(&plan)?;
        self.duplicate_selected(
            &plan,
            saved.operation_id,
            principal,
            agent,
            cancel,
            if validate_only {
                Mode::ValidateExisting
            } else {
                Mode::ApplyExisting
            },
        )
    }
}
