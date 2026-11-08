//! Human foreground mutations. Archive and deletion registry precede success.
use super::{
    archive,
    context::{error, OperationContext},
    memory::valid_id,
};
use crate::{
    context::RequestContext,
    contract::{
        AgentContext, EngineError, MemoryForgetResult, MemoryOpErrorCode, MemoryRow, Principal,
        StoreError,
    },
    recall::{acl, lifecycle::is_recall_entry_live},
    store::{
        tombstone::{content_fingerprint, TombstoneRegistry},
        RowPatch, Store,
    },
    text::json::parse_json,
};
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc};

/// Existing writable store lookup. Forget must not create an absent table.
pub trait MutationStores: Send + Sync {
    /// Lease the active private store only after caller validation.
    fn existing_private(&self, context: &RequestContext) -> Result<Option<Arc<Store>>, StoreError>;
}
/// Foreground write primitives; the full MemoryOps facade is composed separately.
pub struct MemoryWriter {
    pub(super) context: Arc<OperationContext>,
    pub(super) stores: Arc<dyn MutationStores>,
    pub(super) base: PathBuf,
    pub(super) corrections: Option<super::correction::CorrectionServices>,
    pub(super) sharing: Option<super::sharing::ShareServices>,
}
impl MemoryWriter {
    /// Compose existing store lookup, common mutation/lifecycle gate and stable registry root.
    pub fn new(
        context: Arc<OperationContext>,
        stores: Arc<dyn MutationStores>,
        base: PathBuf,
    ) -> Self {
        Self {
            context,
            stores,
            base,
            corrections: None,
            sharing: None,
        }
    }
    /// Forget an owned private-pool card with the host clock.
    pub fn forget(
        &self,
        id: &str,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<MemoryForgetResult, EngineError> {
        self.forget_at(id, principal, agent, self.context.host().now_ms())
    }
    /// Archive and tombstone at a captured operation time, or repair an interrupted prior forget.
    pub fn forget_at(
        &self,
        id: &str,
        principal: &Principal,
        agent: &AgentContext,
        now: i64,
    ) -> Result<MemoryForgetResult, EngineError> {
        let operation = self.context.enter(principal, agent)?;
        let ctx = &operation.context;
        let workspace = self.context.destructive_workspace(ctx)?;
        if !valid_id(id) {
            return Err(error(MemoryOpErrorCode::InvalidInput));
        }
        let _mutation = self.context.mutation()?;
        let store = self
            .stores
            .existing_private(ctx)
            .map_err(|_| error(MemoryOpErrorCode::Storage))?;
        let row = store
            .as_ref()
            .map(|store| store.get(id))
            .transpose()
            .map_err(|_| error(MemoryOpErrorCode::Storage))?
            .flatten()
            .filter(|row| {
                acl::allowed(row, ctx).is_ok()
                    && (row.status == "deleted" || is_recall_entry_live(row, now, None))
            });
        let Some(row) = row else {
            let card = self.require_shared(id, ctx, now)?;
            return self.retract_locked(&card, ctx, now, "MemoryOps.forget");
        };
        let store = store.ok_or_else(|| error(MemoryOpErrorCode::NotFound))?;
        let registry = TombstoneRegistry::new(&self.base, ctx.agent_id.as_str())
            .map_err(|_| error(MemoryOpErrorCode::Storage))?;
        let deleted = row.status == "deleted";
        let mut already_committed = false;
        let archive_path;
        let mut tombstone;
        if deleted {
            archive_path = String::new();
            if let Some(existing) = registry
                .find_by_origin(id, true)
                .map_err(|_| error(MemoryOpErrorCode::Storage))?
            {
                tombstone =
                    super::json_fields::project(&existing, &["tombstoneId", "canonicalOriginId"]);
                already_committed = true;
            } else {
                tombstone = build_tombstone(&row, ctx, "", now)?;
                append(&registry, &tombstone)?;
            }
        } else {
            archive_path = archive::archive(
                &row,
                ctx.agent_id.as_str(),
                self.context.host().state_dir(),
                now,
            )?
            .to_string_lossy()
            .into_owned();
            tombstone = build_tombstone(&row, ctx, &archive_path, now)?;
            tombstone["status"] = json!("attempted");
            append(&registry, &tombstone)?;
            if store
                .patch(
                    id,
                    &RowPatch {
                        status: Some("deleted".into()),
                        epistemic_status: Some("invalidated".into()),
                        ..RowPatch::default()
                    },
                )
                .is_err()
            {
                tombstone["status"] = json!("failed");
                append(&registry, &tombstone)?;
                archive::audit(
                    &workspace,
                    &json!({"event":"memory.deleted","source":"telegram_forget","agentId":ctx.agent_id,"memoryId":id,"via":"id","archivePath":archive_path,"tombstoneId":tombstone["tombstoneId"],"result":"failed","errorClass":"Error","timestamp":archive::iso(now)?}),
                )?;
                return Err(error(MemoryOpErrorCode::Storage));
            }
            tombstone["status"] = json!("committed");
            append(&registry, &tombstone)?;
        }
        archive::audit(
            &workspace,
            &json!({"event":"memory.deleted","source":"telegram_forget","agentId":ctx.agent_id,"memoryId":id,"canonicalOriginId":tombstone["canonicalOriginId"],"via":"id","archivePath":archive_path,"tombstoneId":tombstone["tombstoneId"],"result":if already_committed { "already_tombstoned" } else { "committed" },"timestamp":archive::iso(now)?}),
        )?;
        serde_json::from_value(json!({"id":id,"archived":!deleted,"tombstoneId":tombstone["tombstoneId"],"alreadyForgotten":deleted})).map_err(|_|error(MemoryOpErrorCode::Storage))
    }
}
fn append(registry: &TombstoneRegistry, value: &Value) -> Result<(), EngineError> {
    let value = parse_json(&value.to_string()).map_err(|_| error(MemoryOpErrorCode::Storage))?;
    registry
        .append(&value)
        .map_err(|_| error(MemoryOpErrorCode::Storage))?;
    Ok(())
}
fn build_tombstone(
    row: &MemoryRow,
    ctx: &RequestContext,
    archive: &str,
    now: i64,
) -> Result<Value, EngineError> {
    // Node's human adapter projects out sourceTurnId/evidenceQuote/previousVersion;
    // retain that exact record shape, rather than manufacturing extra provenance.
    Ok(
        json!({"schemaVersion":1,"tombstoneId":uuid::Uuid::new_v4().to_string(),"memoryId":row.id,"canonicalOriginId":row.id,"agentId":ctx.agent_id,"scope":row.scope,"workspaceId":if row.workspace_id.is_empty() { &row.workspace_key } else { &row.workspace_id },"workspaceKey":row.workspace_key,"ownerUserId":row.owner_user_id,"storedBy":row.stored_by,"deletedAt":archive::iso(now)?,"actor":if ctx.owner_user_id.is_empty() { format!("principal:{}",ctx.agent_id.as_str()) } else { ctx.owner_user_id.clone() },"actorType":"human","reason":"MemoryOps.forget","sourceOp":"forget","archiveRef":archive,"previousVersion":"","contentFingerprint":content_fingerprint(if row.text.is_empty(){ &row.summary }else{ &row.text }),"sourceFingerprint":"","refs":{},"status":"committed"}),
    )
}
