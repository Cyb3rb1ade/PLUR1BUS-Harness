//! Private Lance acquisition and the immutable selection-to-merge boundary.
use super::*;
use crate::{
    capture::normal_candidates::{self, Thresholds},
    store::tombstone::{TombstoneContext, TombstoneRegistry},
};
/// Only caller-visible outcome identifiers; no raw query diagnostics or foreign row counts.
#[derive(Debug, PartialEq)]
pub enum NormalCandidateKind {
    /// A committed fingerprint prevents silent recreation; no provider work is needed.
    Forgotten,
    /// First safe duplicate after private authority, lexical and validity checks.
    Duplicate {
        /// Current authorized row ID.
        id: String,
        /// Native-distance score.
        score: f64,
    },
    /// Highest eligible merge-band source, to be revalidated before model disclosure.
    Merge {
        /// Current authorized row ID.
        id: String,
        /// Native-distance score.
        score: f64,
    },
    /// The caller still needs the separately scoped ordinary-store path.
    Separate,
}
/// Opaque original admission. It grants no write permission and is not a wire credential.
/// Holds physical anchors until consumed/dropped; never serialize this as a client-supplied plan.
pub struct NormalCandidatePlan {
    kind: NormalCandidateKind,
    pub(super) source: Option<Record>,
    params: Json,
    vector: Vec<f32>,
    pub(super) assessed_at: i64,
    principal: Value,
    agent: Value,
    context: RequestContext,
    config: Value,
    identity: VectorSpaceIdentity,
    store: Arc<Store>,
    physical: (PathBuf, (u64, u64)),
    workspace: TrustedDirectory,
    base: TrustedDirectory,
    state: TrustedDirectory,
    pub(super) proof: Option<(String, String)>,
}
impl NormalCandidatePlan {
    /// Snapshot outcome only; merge_selected rechecks the original authority and source.
    pub fn kind(&self) -> &NormalCandidateKind {
        &self.kind
    }
    /// Actual input vector for the future ordinary-store path, never an authorization proof.
    pub fn input_vector(&self) -> &[f32] {
        &self.vector
    }
    pub(super) fn check(
        &self,
        native: &NativeMerge,
        principal: &Principal,
        agent: &AgentContext,
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        cancel.check()?;
        native.reader.context.assert_open()?;
        self.workspace.assert_unchanged()?;
        self.base.assert_unchanged()?;
        self.state.assert_unchanged()?;
        let host = native.reader.context.host();
        if self.principal
            != serde_json::to_value(principal).map_err(|_| StoreError::InvalidInput)?
            || self.agent != serde_json::to_value(agent).map_err(|_| StoreError::InvalidInput)?
            || self.context != RequestContext::build(principal, agent, host)?
            || self.config
                != serde_json::to_value(host.config()).map_err(|_| StoreError::InvalidInput)?
            || native.reader.base != self.base.path()
            || host.state_dir() != self.state.path()
            || host.workspace_dir(&self.context.agent_id)?.as_deref() != Some(self.workspace.path())
            || self.store.physical_binding()? != self.physical
            || native
                .selected_store(&self.context, &self.identity)?
                .physical_binding()?
                != self.physical
        {
            return Err(StoreError::InvalidInput.into());
        }
        Ok(())
    }
    fn read<T>(
        &self,
        native: &NativeMerge,
        principal: &Principal,
        agent: &AgentContext,
        cancel: &Cancel,
        action: impl FnOnce(&dyn Fn() -> Result<(), EngineError>) -> Result<T, EngineError>,
    ) -> Result<(T, String, String), EngineError> {
        let _gate = native.reader.context.mutation()?;
        native.journal.with_merge_writer(
            principal,
            agent,
            &self.context,
            cancel,
            &|| self.check(native, principal, agent, cancel),
            |dir, proof, binding, check| {
                CaptureJournal::guard_non_merge_pending(dir, cancel)?;
                super::super::super::conflict_application_state::guard_pending(dir, cancel)?;
                state::guard_pending(dir, cancel)?;
                let proof = write_json(proof);
                if self
                    .proof
                    .as_ref()
                    .is_some_and(|old| old != &(proof.clone(), binding.into()))
                {
                    return Err(StoreError::InvalidInput.into());
                }
                let result = action(check)?;
                check()?;
                Ok((result, proof, binding.into()))
            },
        )
    }
    fn forgotten(&self, text: &str) -> Result<bool, EngineError> {
        Ok(
            TombstoneRegistry::new(self.base.path(), self.context.agent_id.as_str())?
                .find_blocking_readonly(
                    text,
                    TombstoneContext {
                        agent_id: self.context.agent_id.as_str(),
                        scope: "agent-private",
                        workspace_identity: &self.context.workspace_key,
                        owner_user_id: &self.context.owner_user_id,
                    },
                )?
                .is_some(),
        )
    }
}
impl NativeMerge {
    /// Embed one admitted private input, then acquire current visible nearest rows before 10/5 caps.
    /// This prepares selection; it does not store a separate new row or perform post-store effects.
    pub fn select_normal(
        &self,
        params: &Json,
        principal: &Principal,
        agent: &AgentContext,
        cancel: &Cancel,
    ) -> Result<NormalCandidatePlan, EngineError> {
        cancel.check()?;
        let op = self.reader.context.enter(principal, agent)?;
        let ctx = &op.context;
        let host = self.reader.context.host();
        let config = serde_json::to_value(host.config()).map_err(|_| StoreError::InvalidInput)?;
        let now = host.now_ms();
        let assessed = assess(
            params,
            StoreOwner {
                agent_id: ctx.agent_id.as_str(),
                owner_user_id: &ctx.owner_user_id,
                workspace_key: &ctx.workspace_key,
            },
            now,
            cancel,
        )?;
        let identity = self.reader.embedding_identity().clone();
        if !identity
            .dimension
            .as_u64()
            .is_some_and(|n| n > 0 && n <= 32768)
        {
            return Err(StoreError::InvalidInput.into());
        }
        let store = self.selected_store(ctx, &identity)?;
        let mut plan = NormalCandidatePlan {
            kind: NormalCandidateKind::Separate,
            source: None,
            params: params.clone(),
            vector: vec![],
            assessed_at: now,
            principal: serde_json::to_value(principal).map_err(|_| StoreError::InvalidInput)?,
            agent: serde_json::to_value(agent).map_err(|_| StoreError::InvalidInput)?,
            context: ctx.clone(),
            config,
            identity,
            physical: store.physical_binding()?,
            store,
            workspace: TrustedDirectory::open(&self.reader.context.destructive_workspace(ctx)?)?,
            base: TrustedDirectory::open(&self.reader.base)?,
            state: TrustedDirectory::open(host.state_dir())?,
            proof: None,
        };
        let (forgotten, proof, binding) = plan.read(self, principal, agent, cancel, |check| {
            check()?;
            plan.forgotten(assessed.text())
        })?;
        plan.proof = Some((proof, binding));
        if forgotten {
            plan.kind = NormalCandidateKind::Forgotten;
            return Ok(plan);
        }
        let result = self.reader.embedding_provider().embed(
            &[assessed.text().into()],
            EmbedKind::Passage,
            cancel,
        );
        let (forgotten, _, _) = plan.read(self, principal, agent, cancel, |check| {
            check()?;
            plan.forgotten(assessed.text())
        })?;
        if forgotten {
            plan.kind = NormalCandidateKind::Forgotten;
            return Ok(plan);
        }
        let mut vectors = result?;
        if vectors.len() != 1 {
            return Err(StoreError::InvalidInput.into());
        }
        plan.vector = vectors.pop().ok_or(StoreError::InvalidInput)?;
        if plan.vector.is_empty()
            || plan.vector.len() > 32768
            || plan.identity.dimension.as_u64() != Some(plan.vector.len() as u64)
            || plan.vector.iter().any(|v| !v.is_finite())
        {
            return Err(StoreError::InvalidInput.into());
        }
        let ((kind, source), _, _) = plan.read(self, principal, agent, cancel, |check| {
            self.query_normal(&plan, cancel, check)
        })?;
        plan.kind = kind;
        plan.source = source;
        Ok(plan)
    }
    fn query_normal(
        &self,
        plan: &NormalCandidatePlan,
        cancel: &Cancel,
        check: &dyn Fn() -> Result<(), EngineError>,
    ) -> Result<(NormalCandidateKind, Option<Record>), EngineError> {
        let ctx = &plan.context;
        let host = self.reader.context.host();
        let cfg =
            crate::config::effective_config(&plan.config).map_err(|_| StoreError::InvalidInput)?;
        let params = &plan.params;
        let assessed = assess(
            params,
            StoreOwner {
                agent_id: ctx.agent_id.as_str(),
                owner_user_id: &ctx.owner_user_id,
                workspace_key: &ctx.workspace_key,
            },
            plan.assessed_at,
            cancel,
        )?;
        if plan.forgotten(assessed.text())? {
            return Ok((NormalCandidateKind::Forgotten, None));
        }
        let maximum = (64 * 1024 * 1024 / (plan.vector.len() * 4 + 128)).min(50_000);
        let mut limit = 10usize;
        let selected = loop {
            check()?;
            let found = plan.store.search_private_normal_candidates(
                &plan.vector,
                limit,
                ctx.agent_id.as_str(),
                &ctx.owner_user_id,
                &ctx.workspace_key,
            )?;
            let exhausted = found.len() < limit;
            let mut selected = Vec::new();
            let mut selected_bytes = 0usize;
            for scored in found {
                check()?;
                if !scored.distance.is_finite() || scored.distance < 0. {
                    return Err(StoreError::Corrupt.into());
                }
                let actual = plan
                    .store
                    .get_record(&scored.id)?
                    .ok_or(StoreError::InvalidInput)?;
                state::bounded_row(&actual.row, cancel)?;
                if scored.vector != actual.row.vector {
                    return Err(StoreError::InvalidInput.into());
                }
                let row = &actual.row;
                if actual.sharing.is_some()
                    || row.agent_id != ctx.agent_id.as_str()
                    || row.stored_by != ctx.agent_id.as_str()
                    || row.owner_user_id != ctx.owner_user_id
                    || row.workspace_key != ctx.workspace_key
                    || row.scope != "agent-private"
                    || row.status != "active"
                    || !self.reader.visible(&actual, ctx, host.now_ms())?
                {
                    continue;
                }
                selected_bytes += serde_json::to_vec(&actual.row)
                    .map_err(|_| StoreError::InvalidInput)?
                    .len();
                if selected_bytes > 64 * 1024 * 1024 {
                    return Err(StoreError::Unavailable.into());
                }
                selected.push((actual, scored.distance));
                if selected.len() == 10 {
                    break;
                }
            }
            if selected.len() == 10 || exhausted {
                break selected;
            }
            if limit == maximum {
                return Err(StoreError::Unavailable.into());
            }
            limit = (limit * 4).min(maximum);
        };
        let mut rows = Vec::new();
        for (record, distance) in &selected {
            let mut value =
                serde_json::to_value(&record.row).map_err(|_| StoreError::InvalidInput)?;
            value
                .as_object_mut()
                .ok_or(StoreError::InvalidInput)?
                .remove("vector");
            value["_distance"] = serde_json::json!(f64::from(*distance));
            rows.push(parse_json(&value.to_string()).map_err(|_| StoreError::InvalidInput)?);
        }
        let thresholds = Thresholds {
            duplicate: cfg["duplicateThreshold"].as_f64().unwrap_or(0.95),
            merge: cfg["merging"]["threshold"].as_f64().unwrap_or(0.7),
        };
        let selection = normal_candidates::select(
            &rows,
            &JsString::from(assessed.text()),
            params,
            thresholds,
            cancel,
        )?;
        let duplicate = selection.safe_duplicate != Json::Null;
        let chosen = if duplicate {
            selection.safe_duplicate
        } else if cfg["merging"]["enabled"] != false
            && cfg["merging"]["autoApply"] == true
            && host.llm().is_some()
        {
            selection.merge
        } else {
            Json::Null
        };
        if chosen == Json::Null {
            return Ok((NormalCandidateKind::Separate, None));
        }
        let value: Value =
            serde_json::from_str(&write_json(&chosen)).map_err(|_| StoreError::InvalidInput)?;
        let id = value["entry"]["id"]
            .as_str()
            .ok_or(StoreError::InvalidInput)?
            .to_owned();
        let score = value["score"].as_f64().ok_or(StoreError::InvalidInput)?;
        let record = selected
            .into_iter()
            .find(|(r, _)| r.row.id == id)
            .ok_or(StoreError::Corrupt)?
            .0;
        check()?;
        Ok((
            if duplicate {
                NormalCandidateKind::Duplicate { id, score }
            } else {
                NormalCandidateKind::Merge { id, score }
            },
            Some(Record::from(record)),
        ))
    }
    /// Only the original immutable selection can enter inference; source/config changes fail closed.
    pub fn merge_selected(
        &self,
        plan: &NormalCandidatePlan,
        principal: &Principal,
        agent: &AgentContext,
        cancel: &Cancel,
    ) -> Result<Option<MergeResult>, EngineError> {
        let _op = self.reader.context.enter(principal, agent)?;
        plan.check(self, principal, agent, cancel)?;
        plan.read(self, principal, agent, cancel, |check| check())?;
        let NormalCandidateKind::Merge { id, .. } = &plan.kind else {
            return Ok(None);
        };
        self.normal_run(
            NormalInput {
                source_id: id,
                params: &plan.params,
                selected: Some(plan),
            },
            principal,
            agent,
            cancel,
        )
    }
}

#[path = "normal_insert.rs"]
pub(in crate::ops::durable_merge) mod insert;

#[path = "normal_duplicate.rs"]
pub(in crate::ops::durable_merge) mod duplicate;
