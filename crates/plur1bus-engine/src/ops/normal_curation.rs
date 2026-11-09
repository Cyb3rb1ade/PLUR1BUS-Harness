//! Original ordinary-primary receipt owns its curation publication; no arbitrary event input.
use super::*;
use crate::{capture::normal_store::StoreOutcome, ops::conflict_file as file};
use insert_state::CurationReceipt;
/// Acknowledges only the ordinary memory.stored curation entry, not knowledge or interference.
#[derive(Debug)]
pub struct StoreCurationResult {
    /// Original ordinary-primary operation/memory ID.
    pub memory_id: String,
    /// The retained curation intent was reused.
    pub replayed: bool,
}
pub(super) struct Files {
    directory: TrustedDirectory,
    pub(super) frozen: CurationReceipt,
    event: Value,
}
fn expected(
    saved: &SavedInsert,
    plan: &NormalCandidatePlan,
    now_ms: i64,
    cancel: &Cancel,
) -> Result<String, EngineError> {
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
    // Promotion is only a pure proposal here; this component never stages knowledge work.
    let cfg =
        crate::config::effective_config(&plan.config).map_err(|_| StoreError::InvalidInput)?;
    Ok(assessed
        .effects(
            StoreOutcome::Stored { id: &saved.row.id },
            now_ms,
            cfg["schicht15"]["minImportance"].as_f64().unwrap_or(0.7),
            cancel,
        )?
        .into_external()?
        .curation_json)
}
impl Files {
    pub(super) fn prepare(
        saved: &SavedInsert,
        plan: &NormalCandidatePlan,
        now_ms: i64,
        cancel: &Cancel,
    ) -> Result<Self, EngineError> {
        let event_json = expected(saved, plan, now_ms, cancel)?;
        let directory = plan.workspace.create_child(".adaptive-learning")?;
        directory.restrict_private()?;
        let frozen = CurationReceipt {
            now_ms,
            directory: directory_binding(&directory),
            event_json,
            complete: false,
        };
        Self::restore(saved, plan, &frozen, cancel)
    }
    pub(super) fn restore(
        saved: &SavedInsert,
        plan: &NormalCandidatePlan,
        frozen: &CurationReceipt,
        cancel: &Cancel,
    ) -> Result<Self, EngineError> {
        if frozen.event_json != expected(saved, plan, frozen.now_ms, cancel)? {
            return Err(StoreError::Corrupt.into());
        }
        let directory = plan.workspace.open_child(".adaptive-learning")?;
        if directory_binding(&directory) != frozen.directory {
            return Err(StoreError::UntrustedPath.into());
        }
        let event = serde_json::from_str(&frozen.event_json).map_err(|_| StoreError::Corrupt)?;
        Ok(Self {
            directory,
            frozen: frozen.clone(),
            event,
        })
    }
    pub(super) fn overflow(
        plan: &NormalCandidatePlan,
        frozen: CurationReceipt,
    ) -> Result<Self, EngineError> {
        let directory = plan.workspace.open_child(".adaptive-learning")?;
        if directory_binding(&directory) != frozen.directory {
            return Err(StoreError::UntrustedPath.into());
        }
        let event: Value =
            serde_json::from_str(&frozen.event_json).map_err(|_| StoreError::Corrupt)?;
        if event["event"] != "knowledge_pending.overflow" {
            return Err(StoreError::Corrupt.into());
        }
        Ok(Self {
            directory,
            frozen,
            event,
        })
    }
    pub(super) fn check(&self) -> Result<(), EngineError> {
        Ok(self.directory.assert_unchanged()?)
    }
    fn matches(&self, row: &Value) -> bool {
        row["event"] == self.event["event"]
            && row["agentId"] == self.event["agentId"]
            && row["memoryId"] == self.event["memoryId"]
    }
    fn inventory(&self, cancel: &Cancel) -> Result<(Option<Vec<u8>>, bool), EngineError> {
        let bytes = file::read(
            &self.directory,
            "curation-log.jsonl",
            file::MAX_BYTES,
            cancel,
        )?;
        let rows = file::records(bytes.as_deref().unwrap_or_default())?;
        let mut count = 0;
        for (row, _) in &rows {
            cancel.check()?;
            if self.matches(row) {
                if row != &self.event {
                    return Err(StoreError::Corrupt.into());
                }
                count += 1;
            }
        }
        if count > 1 {
            return Err(StoreError::Corrupt.into());
        }
        if count == 0
            && (rows.len() >= file::MAX_ROWS
                || bytes.as_ref().map_or(0, Vec::len) + self.frozen.event_json.len() + 1
                    > file::MAX_BYTES)
        {
            return Err(StoreError::Unavailable.into());
        }
        self.check()?;
        Ok((bytes, count == 1))
    }
    pub(super) fn validate(&self, complete: bool, cancel: &Cancel) -> Result<(), EngineError> {
        if complete && !self.inventory(cancel)?.1 {
            return Err(StoreError::Corrupt.into());
        }
        if !complete {
            self.inventory(cancel)?;
        }
        Ok(())
    }
    pub(super) fn publish(
        &self,
        cancel: &Cancel,
        check: &dyn Fn() -> Result<(), EngineError>,
    ) -> Result<(), EngineError> {
        check()?;
        let (old, present) = self.inventory(cancel)?;
        if present {
            return Ok(());
        }
        if self.frozen.complete {
            return Err(StoreError::Corrupt.into());
        }
        let mut bytes = old.clone().unwrap_or_default();
        bytes.extend_from_slice(self.frozen.event_json.as_bytes());
        bytes.push(b'\n');
        file::replace(
            &self.directory,
            "curation-log.jsonl",
            old.as_deref(),
            &bytes,
            cancel,
            check,
        )?;
        self.validate(true, cancel)
    }
}
impl NativeMerge {
    /// Publish the curation event from an existing complete primary intent and its original caller.
    /// Never creates a primary row, accepts arbitrary event text, or acknowledges other post-effects.
    pub fn publish_store_curation(
        &self,
        operation_id: Uuid,
        principal: &Principal,
        agent: &AgentContext,
        cancel: &Cancel,
    ) -> Result<StoreCurationResult, EngineError> {
        if operation_id.is_nil() {
            return Err(StoreError::InvalidInput.into());
        }
        let saved = {
            let op = self.reader.context.enter(principal, agent)?;
            let _gate = self.reader.context.mutation()?;
            self.journal.with_normal_store_writer(
                principal,
                agent,
                &op.context,
                cancel,
                &|| self.reader.context.assert_open(),
                |dir, _, binding, check| {
                    CaptureJournal::guard_non_merge_pending(dir, cancel)?;
                    crate::ops::durable_merge_state::guard_pending(dir, cancel)?;
                    crate::ops::conflict_application_state::guard_pending(dir, cancel)?;
                    let name = format!(
                        "native-normal-store-{}.json",
                        hash(format!("{binding}:{operation_id}").as_bytes())
                    );
                    let receipt = insert_state::receipts(dir, cancel)?
                        .into_iter()
                        .find(|(n, _, _)| n == &name)
                        .ok_or(StoreError::InvalidInput)?
                        .1;
                    if receipt.stage != 2 {
                        return Err(StoreError::InvalidInput.into());
                    }
                    let (saved, _, _) = restore_insert(&receipt.plan, cancel)?;
                    check()?;
                    Ok(saved)
                },
            )?
        };
        let plan = self.restore_insert_plan(&saved, principal, agent, cancel)?;
        let result = self.insert_selected(
            &plan,
            operation_id,
            principal,
            agent,
            cancel,
            InsertMode {
                existing_only: true,
                validate_only: false,
                curation: true,
                knowledge: false,
                publication: false,
            },
        )?;
        Ok(StoreCurationResult {
            memory_id: result.primary.memory_id,
            replayed: result.curation_replayed,
        })
    }
}
