//! Shared-copy changes reuse private correction and sharing under one operation guard.
use super::{archive, context::error, memory::valid_id, write::MemoryWriter};
use crate::{
    context::RequestContext,
    contract::{
        EngineError, ErrorId, MemoryForgetResult, MemoryOpError, MemoryOpErrorCode,
        MemoryShareTarget, ShareOptions,
    },
    recall::{acl, lifecycle::is_recall_entry_live},
    store::{shared_row::MemoryRecord, tombstone::TombstoneRegistry, RowPatch},
};
use serde_json::json;

pub(super) struct Refreshed {
    pub source_id: String,
    pub shared_id: String,
}
fn storage() -> EngineError {
    error(MemoryOpErrorCode::Storage)
}
fn target(record: &MemoryRecord) -> Result<MemoryShareTarget, EngineError> {
    match record.row.scope.as_str() {
        "workspace" => Ok(MemoryShareTarget::Workspace),
        "user" => Ok(MemoryShareTarget::User),
        _ => Err(error(MemoryOpErrorCode::NotFound)),
    }
}
fn recovery(source: &str, shared: &str, stale: Option<&str>) -> EngineError {
    let mut failure = MemoryOpError::new(MemoryOpErrorCode::Storage);
    for (name, value) in [
        ("sourceId", Some(source)),
        ("sharedId", Some(shared)),
        ("staleSharedId", stale),
    ] {
        if let (Some(name), Some(value)) = (ErrorId::new(name), value.and_then(ErrorId::new)) {
            failure = failure.with_detail(name, value);
        }
    }
    failure.into()
}
impl MemoryWriter {
    pub(super) fn require_shared(
        &self,
        id: &str,
        ctx: &RequestContext,
        now: i64,
    ) -> Result<MemoryRecord, EngineError> {
        let services = self
            .sharing
            .as_ref()
            .ok_or_else(|| error(MemoryOpErrorCode::NotFound))?;
        let record = services
            .reader
            .find_shared_record(id, ctx, now, false)
            .ok()
            .flatten()
            .ok_or_else(|| error(MemoryOpErrorCode::NotFound))?;
        if record
            .sharing
            .as_ref()
            .is_none_or(|sharing| sharing.source_agent_id != ctx.agent_id.as_str())
        {
            return Err(error(MemoryOpErrorCode::Denied));
        }
        Ok(record)
    }
    pub(super) fn retract_locked(
        &self,
        card: &MemoryRecord,
        ctx: &RequestContext,
        now: i64,
        reason: &str,
    ) -> Result<MemoryForgetResult, EngineError> {
        let scope = target(card)?;
        let workspace = self.context.destructive_workspace(ctx)?;
        self.context.assert_open()?;
        archive::shared(
            card,
            ctx.agent_id.as_str(),
            self.context.host().state_dir(),
            now,
        )?;
        let services = self.sharing.as_ref().ok_or_else(storage)?;
        let store = services.stores.target(ctx, scope).map_err(|_| storage())?;
        let current = store
            .get_record(&card.row.id)
            .map_err(|_| storage())?
            .ok_or_else(|| error(MemoryOpErrorCode::NotFound))?;
        // A replacement/rebound row cannot inherit the authorization of an earlier snapshot.
        if current.origin() != card.origin() || acl::allowed(&current.row, ctx).is_err() {
            return Err(error(MemoryOpErrorCode::NotFound));
        }
        let already = current.row.status == "deleted";
        if !already {
            self.context.assert_open()?;
            store
                .patch(
                    &card.row.id,
                    &RowPatch {
                        status: Some("deleted".into()),
                        epistemic_status: Some("invalidated".into()),
                        ..Default::default()
                    },
                )
                .map_err(|_| storage())?;
            let source = card
                .sharing
                .as_ref()
                .map(|s| s.source_memory_id.as_str())
                .unwrap_or("");
            archive::audit(
                &workspace,
                &json!({"op":"share-retract","id":card.row.id,"scope":card.row.scope,"sourceMemoryId":source,
                "actor":if ctx.owner_user_id.is_empty(){format!("principal:{}",ctx.agent_id.as_str())}else{ctx.owner_user_id.clone()},
                "at":archive::iso(now)?,"reason":reason}),
            )?;
        }
        serde_json::from_value(
            json!({"id":card.row.id,"archived":true,"tombstoneId":null,"alreadyForgotten":already}),
        )
        .map_err(|_| storage())
    }
    pub(super) fn refresh_locked(
        &self,
        card: &MemoryRecord,
        text: &str,
        ctx: &RequestContext,
        now: i64,
        reason: &str,
    ) -> Result<Refreshed, EngineError> {
        let share = card
            .sharing
            .as_ref()
            .ok_or_else(|| error(MemoryOpErrorCode::Conflict))?;
        if share.source_agent_id != ctx.agent_id.as_str() {
            return Err(error(MemoryOpErrorCode::Denied));
        }
        if !valid_id(&share.source_memory_id) {
            return Err(error(MemoryOpErrorCode::Conflict));
        }
        let private = self.stores.existing_private(ctx).map_err(|_| storage())?;
        let original = private
            .as_ref()
            .map(|store| store.get(&share.source_memory_id))
            .transpose()
            .map_err(|_| storage())?
            .flatten();
        let original = original
            .filter(|row| {
                row.scope == "agent-private"
                    && acl::allowed(row, ctx).is_ok()
                    && is_recall_entry_live(row, now, None)
            })
            .ok_or_else(|| error(MemoryOpErrorCode::Conflict))?;
        if TombstoneRegistry::new(&self.base, ctx.agent_id.as_str())
            .map_err(|_| storage())?
            .find_by_origin(&original.id, false)
            .map_err(|_| storage())?
            .is_some()
        {
            return Err(error(MemoryOpErrorCode::Conflict));
        }
        let corrected = self.correct_locked(&original.id, text, ctx, now)?;
        let options: ShareOptions =
            serde_json::from_value(json!({"allowSensitive":true})).map_err(|_| storage())?;
        let shared = self
            .share_locked(&corrected.id, target(card)?, ctx, &options, now)
            .map_err(|_| recovery(&corrected.id, &card.row.id, None))?;
        self.retract_locked(card, ctx, now, reason)
            .map_err(|_| recovery(&corrected.id, &shared.shared_id, Some(&card.row.id)))?;
        Ok(Refreshed {
            source_id: corrected.id,
            shared_id: shared.shared_id,
        })
    }
}
