//! Original-caller foreground interference over actual private Lance rows.
//! A durable before/after plan precedes any patch. This is not ProcessEngine activation.
use super::{
    conflict_file as io, interference_state as state,
    memory::{valid_id, MemoryReader, SourceKind},
};
use crate::{
    capture::interference::{self, InterferenceOptions},
    context::{is_user_principal, RequestContext},
    contract::{AgentContext, Cancel, EngineError, MemoryScope, Principal, StoreError},
    neo::capture_journal::CaptureJournal,
    recall::score::distance_to_score,
    store::{directory::TrustedDirectory, shared_row::MemoryRecord, RowFilter, RowPatch, Store},
    text::json::{parse_json, write_json},
};
use serde_json::{json, Value};
use std::sync::Arc;
#[cfg(feature = "testkit")]
type Observer = Arc<dyn Fn(&str) -> Result<(), EngineError> + Send + Sync>;
/// Stable original operation and expected actual committed source.
pub struct InterferenceRequest {
    /// Keep this UUID for retries, including a failed partial application.
    pub operation_id: uuid::Uuid,
    /// Actual source snapshot; never an alternate authority.
    pub source: MemoryRecord,
    /// Validated bounded weakening parameters.
    pub options: InterferenceOptions,
}
/// Returned only once every planned row is verified and the receipt is complete.
#[derive(Debug)]
pub struct InterferenceResult {
    /// Total successfully settled planned effects, including already-applied retry effects.
    pub affected: usize,
    /// The exact original operation had a durable receipt before this invocation.
    pub replayed: bool,
}
/// Real-store adapter. Composition supplies its shared lifecycle and operation-specific policy.
pub struct NativeInterference {
    reader: Arc<MemoryReader>,
    journal: Arc<CaptureJournal>,
    #[cfg(feature = "testkit")]
    observer: Option<Observer>,
}
impl NativeInterference {
    /// Bind existing services without opening stores or changing configuration.
    pub fn new(reader: Arc<MemoryReader>, journal: Arc<CaptureJournal>) -> Self {
        Self {
            reader,
            journal,
            #[cfg(feature = "testkit")]
            observer: None,
        }
    }
    /// Deterministic crash-boundary seam; production builds contain no callback.
    #[cfg(feature = "testkit")]
    pub fn with_observer(mut self, observer: Observer) -> Self {
        self.observer = Some(observer);
        self
    }
    fn observe(&self, stage: &str) -> Result<(), EngineError> {
        #[cfg(feature = "testkit")]
        if let Some(observer) = &self.observer {
            return observer(stage);
        }
        let _ = stage;
        Ok(())
    }
    fn private(
        &self,
        row: &MemoryRecord,
        ctx: &RequestContext,
        now: i64,
    ) -> Result<bool, EngineError> {
        Ok(row.row.scope == "agent-private"
            && row.row.agent_id == ctx.agent_id.as_str()
            && row.row.stored_by == ctx.agent_id.as_str()
            && row.row.owner_user_id == ctx.owner_user_id
            && row.row.workspace_key == ctx.workspace_key
            && self.reader.visible(row, ctx, now)?)
    }
    fn store(
        &self,
        source: &MemoryRecord,
        ctx: &RequestContext,
        now: i64,
    ) -> Result<Arc<Store>, EngineError> {
        if !self.private(source, ctx, now)? {
            return Err(StoreError::InvalidInput.into());
        }
        let mut selected: Option<Arc<Store>> = None;
        for pool in self.reader.stores.sources(ctx)? {
            if pool.kind != SourceKind::Private {
                continue;
            }
            let Some(row) = pool.store.get_record(&source.row.id)? else {
                continue;
            };
            if !state::Record::from(source.clone()).same(&row)? {
                return Err(StoreError::InvalidInput.into());
            }
            if selected
                .as_ref()
                .is_some_and(|s| !Arc::ptr_eq(s, &pool.store))
            {
                return Err(StoreError::InvalidInput.into());
            }
            selected = Some(pool.store);
        }
        selected.ok_or_else(|| StoreError::InvalidInput.into())
    }
    fn current(
        &self,
        store: &Store,
        expected: &state::Record,
        ctx: &RequestContext,
        now: i64,
    ) -> Result<MemoryRecord, EngineError> {
        let current = store
            .get_record(&expected.row.id)?
            .ok_or(StoreError::InvalidInput)?;
        if !self.private(&current, ctx, now)? {
            return Err(StoreError::InvalidInput.into());
        }
        Ok(current)
    }
    /// Prepare before mutation and resume only exact before/after snapshots under original authority.
    /// An error may follow partial durable patches; retry the same request, never invent a new UUID.
    pub fn apply(
        &self,
        request: &InterferenceRequest,
        principal: &Principal,
        agent: &AgentContext,
        cancel: &Cancel,
    ) -> Result<InterferenceResult, EngineError> {
        self.settle(request, principal, agent, cancel, Mode::AllowNew)
    }
    fn settle(
        &self,
        request: &InterferenceRequest,
        principal: &Principal,
        agent: &AgentContext,
        cancel: &Cancel,
        mode: Mode,
    ) -> Result<InterferenceResult, EngineError> {
        cancel.check()?;
        if request.operation_id.is_nil() || !valid_id(&request.source.row.id) {
            return Err(StoreError::InvalidInput.into());
        }
        let operation = self.reader.context.enter(principal, agent)?;
        let ctx = &operation.context;
        if !is_user_principal(&ctx.owner_user_id) {
            return Err(StoreError::InvalidInput.into());
        }
        let workspace = TrustedDirectory::open(&self.reader.context.destructive_workspace(ctx)?)?;
        let base = TrustedDirectory::open(&self.reader.base)?;
        let _gate = self.reader.context.mutation()?;
        let check = || {
            cancel.check()?;
            self.reader.context.assert_open()?;
            workspace.assert_unchanged()?;
            base.assert_unchanged()?;
            if RequestContext::build(principal, agent, self.reader.context.host())? != *ctx
                || self
                    .reader
                    .context
                    .host()
                    .workspace_dir(&ctx.agent_id)?
                    .as_deref()
                    != Some(workspace.path())
            {
                return Err(StoreError::InvalidInput.into());
            }
            Ok(())
        };
        self.journal.with_operation_writer(
            principal,
            agent,
            ctx,
            cancel,
            &check,
            |dir, proof, binding, check| {
                let source = state::Record::from(request.source.clone());

                let store =
                    self.store(&request.source, ctx, self.reader.context.host().now_ms())?;

                let source_json = parse_json(
                    &serde_json::to_string(&source.row).map_err(|_| StoreError::Corrupt)?,
                )
                .map_err(|_| StoreError::Corrupt)?;

                let search = interference::search_request(&source_json, request.options, cancel)?;

                let options = json!({
                "enabled":request.options.enabled,
                "threshold":request.options.threshold,
                "multiplier":request.options.multiplier,
                "maxAffected":request.options.max_affected}
                );

                let digest = state::hash(
                    &serde_json::to_vec(&json!({
                    "source":source,
                    "options":options}
                    ))
                    .map_err(|_| StoreError::Corrupt)?,
                );

                let name = format!(
                    "native-interference-{}.json",
                    state::hash(format!("{binding}:{}", request.operation_id).as_bytes())
                );

                let (count, _) = state::inventory(dir, cancel)?;

                let old = io::read(dir, &name, state::MAX_STATE, cancel)?;

                let replayed = old.is_some();
                if !replayed && mode != Mode::AllowNew {
                    return Err(StoreError::Corrupt.into());
                }

                if !replayed
                    && state::receipts(dir, cancel)?
                        .iter()
                        .any(|(_, receipt, _)| !receipt.complete)
                {
                    return Err(StoreError::Busy.into());
                }
                if !replayed && count >= 512 {
                    return Err(StoreError::Unavailable.into());
                }

                let proof: Value =
                    serde_json::from_str(&write_json(proof)).map_err(|_| StoreError::Corrupt)?;

                let principal = serde_json::to_value(principal).map_err(|_| StoreError::Corrupt)?;

                let agent = serde_json::to_value(agent).map_err(|_| StoreError::Corrupt)?;

                let source_check = || {
                    check()?;

                    let current =
                        self.current(&store, &source, ctx, self.reader.context.host().now_ms())?;

                    if !source.same(&current)? {
                        return Err(StoreError::InvalidInput.into());
                    }
                    Ok(())
                };

                source_check()?;

                let mut receipt = if let Some(bytes) = &old {
                    let receipt: state::Receipt =
                        serde_json::from_slice(bytes).map_err(|_| StoreError::Corrupt)?;

                    if receipt.version != 1
                        || receipt.operation_id != request.operation_id
                        || serde_json::to_value(receipt.options).map_err(|_| StoreError::Corrupt)?
                            != options
                        || receipt.digest != digest
                        || receipt.proof != proof
                        || receipt.principal != principal
                        || receipt.agent != agent
                        || receipt.effects.len() > 64
                        || !receipt.source.same(&source.record())?
                    {
                        return Err(StoreError::InvalidInput.into());
                    }

                    receipt
                } else {
                    let mut candidates = Vec::new();

                    if let Some(search) = search {
                        let filter = RowFilter {
                            agent_id: Some(ctx.agent_id.as_str().into()),
                            owner_user_id: Some(ctx.owner_user_id.clone()),
                            workspace_id: Some(ctx.workspace_key.clone()),
                            scope: Some(MemoryScope::AgentPrivate),
                            status: Some("active".into()),
                            ..RowFilter::default()
                        };

                        for scored in store.search(&source.row.vector, search.limit, &filter)? {
                            source_check()?;

                            if !scored.distance.is_finite()
                                || distance_to_score(f64::from(scored.distance)) < search.threshold
                            {
                                continue;
                            }

                            let row = store
                                .get_record(&scored.row.id)?
                                .ok_or(StoreError::InvalidInput)?;

                            if !self.private(&row, ctx, self.reader.context.host().now_ms())? {
                                continue;
                            }

                            candidates.push(state::Record::from(row));
                        }
                    }

                    let inputs = candidates
                        .iter()
                        .map(|v| {
                            parse_json(
                                &serde_json::to_string(&v.row).map_err(|_| StoreError::Corrupt)?,
                            )
                            .map_err(|_| StoreError::Corrupt)
                        })
                        .collect::<Result<Vec<_>, _>>()?;

                    let planned = interference::plan(
                        &source_json,
                        &inputs,
                        self.reader.context.host().now_ms(),
                        request.options,
                        cancel,
                    )?;

                    let effects = planned
                        .into_iter()
                        .map(|effect| {
                            let before = candidates
                                .iter()
                                .find(|r| effect.id == r.row.id.as_str().into())
                                .ok_or(StoreError::Corrupt)?
                                .clone();

                            let mut after = before.clone();

                            after.row.memory_strength =
                                serde_json::Number::from_f64(effect.memory_strength)
                                    .ok_or(StoreError::Corrupt)?;

                            after.row.last_dynamics_at =
                                serde_json::Number::from_f64(effect.last_dynamics_at as f64)
                                    .ok_or(StoreError::Corrupt)?;

                            Ok(state::Effect { before, after })
                        })
                        .collect::<Result<Vec<_>, StoreError>>()?;

                    state::Receipt {
                        version: 1,
                        operation_id: request.operation_id,
                        options: request.options,
                        digest,
                        proof,
                        principal,
                        agent,
                        source: source.clone(),
                        effects,
                        complete: false,
                    }
                };

                let preflight = || -> Result<(), EngineError> {
                    source_check()?;

                    state::validate_effects(&receipt, &source_json, request.options, cancel)?;

                    let mut ids = std::collections::HashSet::new();

                    for effect in &receipt.effects {
                        if !valid_id(&effect.before.row.id)
                            || effect.before.row.id == source.row.id
                            || effect.before.row.id != effect.after.row.id
                            || !ids.insert(&effect.before.row.id)
                        {
                            return Err(StoreError::Corrupt.into());
                        }

                        let mut projected = effect.before.clone();
                        projected.row.memory_strength = effect.after.row.memory_strength.clone();
                        projected.row.last_dynamics_at = effect.after.row.last_dynamics_at.clone();

                        if !projected.same(&effect.after.record())? {
                            return Err(StoreError::Corrupt.into());
                        }

                        let current = self.current(
                            &store,
                            &effect.before,
                            ctx,
                            self.reader.context.host().now_ms(),
                        )?;

                        if !effect.before.same(&current)? && !effect.after.same(&current)? {
                            return Err(StoreError::InvalidInput.into());
                        }

                        if receipt.complete && !effect.after.same(&current)? {
                            return Err(StoreError::InvalidInput.into());
                        }
                    }
                    Ok(())
                };

                preflight()?;
                if mode == Mode::ValidateExisting {
                    return Ok(InterferenceResult {
                        affected: receipt.effects.len(),
                        replayed: true,
                    });
                }

                let mut bytes = match old {
                    Some(bytes) => bytes,
                    None => state::save(dir, &name, None, &receipt, cancel, &preflight)?,
                };

                self.observe("prepared")?;

                for effect in &receipt.effects {
                    source_check()?;

                    let current = self.current(
                        &store,
                        &effect.before,
                        ctx,
                        self.reader.context.host().now_ms(),
                    )?;

                    if effect.after.same(&current)? {
                        continue;
                    }

                    if !effect.before.same(&current)? {
                        return Err(StoreError::InvalidInput.into());
                    }

                    store.patch(
                        &effect.before.row.id,
                        &RowPatch {
                            memory_strength: effect.after.row.memory_strength.as_f64(),
                            last_dynamics_at: effect.after.row.last_dynamics_at.as_f64(),
                            ..RowPatch::default()
                        },
                    )?;

                    source_check()?;
                    self.observe("applied")?;
                }

                preflight()?;

                for effect in &receipt.effects {
                    if !effect.after.same(&self.current(
                        &store,
                        &effect.after,
                        ctx,
                        self.reader.context.host().now_ms(),
                    )?)? {
                        return Err(StoreError::InvalidInput.into());
                    }
                }

                if !receipt.complete {
                    receipt.complete = true;

                    bytes = state::save(dir, &name, Some(&bytes), &receipt, cancel, &source_check)?;
                }

                let _ = bytes;
                source_check()?;
                self.observe("complete")?;

                Ok(InterferenceResult {
                    affected: receipt.effects.len(),
                    replayed,
                })
            },
        )
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    AllowNew,
    ValidateExisting,
    ApplyExisting,
}

#[path = "interference_recovery.rs"]
mod recovery;
