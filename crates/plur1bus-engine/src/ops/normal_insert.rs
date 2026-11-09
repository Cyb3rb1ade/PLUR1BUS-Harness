//! Durable ordinary primary insertion. Post-store effects require their own later coordinator.
use super::*;
use crate::ops::normal_insert_state as insert_state;
use uuid::Uuid;

/// Primary persistence only; does not acknowledge curation, knowledge or interference effects.
#[derive(Debug)]
pub struct NormalStoreResult {
    /// Frozen original operation UUID, also the memory ID.
    pub memory_id: String,
    /// The retained durable intent was reused.
    pub replayed: bool,
}
#[derive(Clone, Copy, Default)]
struct InsertMode {
    existing_only: bool,
    validate_only: bool,
    curation: bool,
}
struct InsertResult {
    primary: NormalStoreResult,
    curation_replayed: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SavedInsert {
    version: u8,
    command: String,
    pub(crate) operation_id: Uuid,
    principal: Value,
    agent: Value,
    params: String,
    assessed_at: i64,
    prepared_at: i64,
    row: MemoryRow,
    identity: VectorSpaceIdentity,
    config_hash: String,
    store_binding: (PathBuf, (u64, u64)),
    state_binding: (PathBuf, (u64, u64)),
    registry_binding: (PathBuf, (u64, u64)),
    workspace_binding: (PathBuf, (u64, u64)),
}
pub(crate) type RestoredInsert = (SavedInsert, Principal, AgentContext);
pub(crate) fn restore_insert(
    value: &Value,
    cancel: &Cancel,
) -> Result<RestoredInsert, EngineError> {
    let saved: SavedInsert =
        serde_json::from_value(value.clone()).map_err(|_| StoreError::Corrupt)?;
    state::bounded_row(&saved.row, cancel)?;
    if saved.version != 1
        || saved.command != "memory-store-insert"
        || saved.operation_id.is_nil()
        || saved.row.id != saved.operation_id.to_string()
        || serde_json::to_value(&saved).map_err(|_| StoreError::Corrupt)? != *value
    {
        return Err(StoreError::Corrupt.into());
    }
    let principal =
        serde_json::from_value(saved.principal.clone()).map_err(|_| StoreError::Corrupt)?;
    let agent = serde_json::from_value(saved.agent.clone()).map_err(|_| StoreError::Corrupt)?;
    Ok((saved, principal, agent))
}
fn digest(config: &Value) -> Result<String, EngineError> {
    Ok(hash(
        &serde_json::to_vec(config).map_err(|_| StoreError::InvalidInput)?,
    ))
}
fn directory_binding(dir: &TrustedDirectory) -> (PathBuf, (u64, u64)) {
    (dir.path().to_owned(), dir.identity_parts())
}
fn prepare(
    plan: &NormalCandidatePlan,
    id: Uuid,
    assessed_at: i64,
    prepared_at: i64,
    vector: &[f32],
    cancel: &Cancel,
) -> Result<MemoryRow, EngineError> {
    let ctx = &plan.context;
    let assessed = assess(
        &plan.params,
        StoreOwner {
            agent_id: ctx.agent_id.as_str(),
            owner_user_id: &ctx.owner_user_id,
            workspace_key: &ctx.workspace_key,
        },
        assessed_at,
        cancel,
    )?;
    let cfg =
        crate::config::effective_config(&plan.config).map_err(|_| StoreError::InvalidInput)?;
    let encoding = StoreEncoding {
        summary_max_words: cfg["summaryMaxWords"]
            .as_u64()
            .unwrap_or(150)
            .try_into()
            .map_err(|_| StoreError::InvalidInput)?,
        half_life_overrides: parse_json(&cfg["recall"]["halfLifeDaysMap"].to_string())
            .map_err(|_| StoreError::InvalidInput)?,
        flashbulb: cfg["memoryDynamics"]["flashbulbEncoding"] == true,
    };
    if plan.identity.dimension.as_u64() != Some(vector.len() as u64) {
        return Err(StoreError::InvalidInput.into());
    }
    let vector = parse_json(&serde_json::to_string(vector).map_err(|_| StoreError::InvalidInput)?)
        .map_err(|_| StoreError::InvalidInput)?;
    let row = assessed
        .ordinary(&id, &vector, prepared_at, &encoding, cancel)?
        .into_row()?;
    state::bounded_row(&row, cancel)?;
    Ok(crate::store::row::persisted_projection(&row)?)
}
impl SavedInsert {
    fn check(&self, plan: &NormalCandidatePlan, cancel: &Cancel) -> Result<(), EngineError> {
        if self.principal != plan.principal
            || self.agent != plan.agent
            || self.params != write_json(&plan.params)
            || self.config_hash != digest(&plan.config)?
            || self.store_binding != plan.physical
            || self.state_binding != directory_binding(&plan.state)
            || self.registry_binding != directory_binding(&plan.base)
            || self.workspace_binding != directory_binding(&plan.workspace)
            || try_identity_id(&self.identity)? != try_identity_id(&plan.identity)?
        {
            return Err(StoreError::InvalidInput.into());
        }
        let expected = prepare(
            plan,
            self.operation_id,
            self.assessed_at,
            self.prepared_at,
            &self.row.vector,
            cancel,
        )?;
        if !(Record {
            row: expected,
            sharing: None,
        })
        .same(&MemoryRecord {
            row: self.row.clone(),
            sharing: None,
        })? {
            return Err(StoreError::Corrupt.into());
        }
        Ok(())
    }
}
impl NativeMerge {
    /// Save an admitted separate input, or conservatively retain an unmerged source and save separately.
    /// The caller retains the operation UUID across retries. This acknowledges only primary storage.
    pub fn store_selected(
        &self,
        plan: &NormalCandidatePlan,
        operation_id: Uuid,
        principal: &Principal,
        agent: &AgentContext,
        cancel: &Cancel,
    ) -> Result<NormalStoreResult, EngineError> {
        self.insert_selected(
            plan,
            operation_id,
            principal,
            agent,
            cancel,
            InsertMode::default(),
        )
        .map(|r| r.primary)
    }
    fn insert_selected(
        &self,
        plan: &NormalCandidatePlan,
        operation_id: Uuid,
        principal: &Principal,
        agent: &AgentContext,
        cancel: &Cancel,
        mode: InsertMode,
    ) -> Result<InsertResult, EngineError> {
        cancel.check()?;
        if operation_id.is_nil() {
            return Err(StoreError::InvalidInput.into());
        }
        let _op = self.reader.context.enter(principal, agent)?;
        plan.check(self, principal, agent, cancel)?;
        let _gate = self.reader.context.mutation()?;
        self.journal.with_normal_store_writer(
            principal,
            agent,
            &plan.context,
            cancel,
            &|| plan.check(self, principal, agent, cancel),
            |dir, proof, binding, check| {
                CaptureJournal::guard_non_merge_pending(dir, cancel)?;
                crate::ops::durable_merge_state::guard_pending(dir, cancel)?;
                crate::ops::conflict_application_state::guard_pending(dir, cancel)?;
                let proof_text = write_json(proof);
                if plan
                    .proof
                    .as_ref()
                    .is_some_and(|p| p != &(proof_text.clone(), binding.into()))
                {
                    return Err(StoreError::InvalidInput.into());
                }
                let proof: Value =
                    serde_json::from_str(&proof_text).map_err(|_| StoreError::Corrupt)?;
                let name = format!(
                    "native-normal-store-{}.json",
                    hash(format!("{binding}:{operation_id}").as_bytes())
                );
                let mut inventory = insert_state::receipts(dir, cancel)?;
                if inventory
                    .iter()
                    .any(|(file, r, _)| file != &name && r.pending())
                {
                    return Err(StoreError::Busy.into());
                }
                let old = inventory
                    .iter()
                    .position(|(file, _, _)| file == &name)
                    .map(|i| inventory.remove(i));
                let replayed = old.is_some();
                if mode.existing_only && !replayed {
                    return Err(StoreError::Corrupt.into());
                }
                let (saved, mut receipt, mut bytes) = if let Some((_, r, b)) = old {
                    let (saved, _, _) = restore_insert(&r.plan, cancel)?;
                    if saved.operation_id != operation_id || r.proof != proof {
                        return Err(StoreError::Corrupt.into());
                    }
                    saved.check(plan, cancel)?;
                    (saved, r, Some(b))
                } else {
                    if !matches!(
                        plan.kind,
                        NormalCandidateKind::Separate | NormalCandidateKind::Merge { .. }
                    ) {
                        return Err(StoreError::InvalidInput.into());
                    }
                    let (kind, source) = self.query_normal(plan, cancel, check)?;
                    let same = match (&source, &plan.source) {
                        (None, None) => true,
                        (Some(a), Some(b)) => a.same(&b.record())?,
                        _ => false,
                    };
                    if kind != plan.kind || !same {
                        return Err(StoreError::Busy.into());
                    }
                    if plan.store.get_record(&operation_id.to_string())?.is_some() {
                        return Err(StoreError::InvalidInput.into());
                    }
                    let prepared_at = self.reader.context.host().now_ms();
                    let row = prepare(
                        plan,
                        operation_id,
                        plan.assessed_at,
                        prepared_at,
                        &plan.vector,
                        cancel,
                    )?;
                    let saved = SavedInsert {
                        version: 1,
                        command: "memory-store-insert".into(),
                        operation_id,
                        principal: plan.principal.clone(),
                        agent: plan.agent.clone(),
                        params: write_json(&plan.params),
                        assessed_at: plan.assessed_at,
                        prepared_at,
                        row,
                        identity: plan.identity.clone(),
                        config_hash: digest(&plan.config)?,
                        store_binding: plan.physical.clone(),
                        state_binding: directory_binding(&plan.state),
                        registry_binding: directory_binding(&plan.base),
                        workspace_binding: directory_binding(&plan.workspace),
                    };
                    let value = serde_json::to_value(&saved).map_err(|_| StoreError::Corrupt)?;
                    let fingerprint = format!(
                        "sha256:{}",
                        hash(&serde_json::to_vec(&value).map_err(|_| StoreError::Corrupt)?)
                    );
                    (
                        saved,
                        insert_state::Receipt {
                            version: 1,
                            plan: value,
                            fingerprint,
                            proof,
                            stage: 0,
                            curation: None,
                        },
                        None,
                    )
                };
                let row = Record {
                    row: saved.row.clone(),
                    sharing: None,
                };
                let preflight = |stage: u8| -> Result<(), EngineError> {
                    check()?;
                    self.private(&row.record(), &plan.context)?;
                    match plan.store.get_record(&row.row.id)? {
                        Some(actual) if !row.same(&actual)? => {
                            return Err(StoreError::InvalidInput.into())
                        }
                        None if stage > 0 => return Err(StoreError::Corrupt.into()),
                        _ => (),
                    }
                    check()
                };
                preflight(receipt.stage)?;
                if mode.curation && receipt.stage != 2 {
                    return Err(StoreError::InvalidInput.into());
                }
                let curation_replayed = receipt.curation.is_some();
                let publication = match &receipt.curation {
                    Some(frozen) => Some(curation::Files::restore(&saved, plan, frozen, cancel)?),
                    None if mode.curation => Some(curation::Files::prepare(
                        &saved,
                        plan,
                        self.reader.context.host().now_ms(),
                        cancel,
                    )?),
                    None => None,
                };
                if let Some(files) = &publication {
                    files.validate(
                        receipt.curation.as_ref().is_some_and(|r| r.complete),
                        cancel,
                    )?;
                }
                let result = || InsertResult {
                    primary: NormalStoreResult {
                        memory_id: row.row.id.clone(),
                        replayed,
                    },
                    curation_replayed,
                };
                if mode.validate_only {
                    return Ok(result());
                }
                if bytes.is_none() {
                    bytes = Some(insert_state::save(
                        dir,
                        &name,
                        None,
                        &receipt,
                        cancel,
                        &|| preflight(0),
                    )?);
                }
                self.observe("normal-prepared")?;
                if plan.store.get_record(&row.row.id)?.is_none() {
                    preflight(0)?;
                    plan.store.upsert(std::slice::from_ref(&row.row))?;
                }
                self.observe("normal-row-write")?;
                for (stage, label) in [(1, "normal-verified"), (2, "normal-complete")] {
                    preflight(stage)?;
                    if receipt.stage < stage {
                        receipt.stage = stage;
                        bytes = Some(insert_state::save(
                            dir,
                            &name,
                            bytes.as_deref(),
                            &receipt,
                            cancel,
                            &|| preflight(stage),
                        )?);
                    }
                    self.observe(label)?;
                }
                preflight(2)?;
                if let Some(files) = publication {
                    let checked = || {
                        preflight(2)?;
                        files.check()?;
                        files.validate(files.frozen.complete, cancel)?;
                        Ok(())
                    };
                    if receipt.curation.is_none() {
                        receipt.curation = Some(files.frozen.clone());
                        bytes = Some(insert_state::save(
                            dir,
                            &name,
                            bytes.as_deref(),
                            &receipt,
                            cancel,
                            &checked,
                        )?);
                    }
                    self.observe("normal-curation-prepared")?;
                    files.publish(cancel, &checked)?;
                    self.observe("normal-curation-write")?;
                    if !receipt.curation.as_ref().is_some_and(|r| r.complete) {
                        receipt
                            .curation
                            .as_mut()
                            .ok_or(StoreError::Corrupt)?
                            .complete = true;
                        insert_state::save(
                            dir,
                            &name,
                            bytes.as_deref(),
                            &receipt,
                            cancel,
                            &|| {
                                checked()?;
                                files.validate(true, cancel)
                            },
                        )?;
                    }
                    self.observe("normal-curation-complete")?;
                    checked()?;
                    files.validate(true, cancel)?;
                }
                Ok(result())
            },
        )
    }
    pub(crate) fn recover_insert(
        &self,
        saved: &SavedInsert,
        principal: &Principal,
        agent: &AgentContext,
        cancel: &Cancel,
        validate_only: bool,
    ) -> Result<NormalStoreResult, EngineError> {
        let plan = self.restore_insert_plan(saved, principal, agent, cancel)?;
        self.insert_selected(
            &plan,
            saved.operation_id,
            principal,
            agent,
            cancel,
            InsertMode {
                existing_only: true,
                validate_only,
                curation: false,
            },
        )
        .map(|r| r.primary)
    }
    fn restore_insert_plan(
        &self,
        saved: &SavedInsert,
        principal: &Principal,
        agent: &AgentContext,
        cancel: &Cancel,
    ) -> Result<NormalCandidatePlan, EngineError> {
        let context = RequestContext::build(principal, agent, self.reader.context.host())?;
        let store = self.selected_store(&context, &saved.identity)?;
        let plan = NormalCandidatePlan {
            kind: NormalCandidateKind::Separate,
            source: None,
            params: parse_json(&saved.params).map_err(|_| StoreError::Corrupt)?,
            vector: saved.row.vector.clone(),
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
        saved.check(&plan, cancel)?;
        Ok(plan)
    }
}
#[path = "normal_curation.rs"]
pub(in crate::ops::durable_merge) mod curation;
