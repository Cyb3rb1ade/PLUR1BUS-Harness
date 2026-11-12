//! Explicit share authorization and source-consistent, identity-routed copies.
use super::{
    context::error,
    memory::{valid_id, MemoryReader},
    write::MemoryWriter,
};
use crate::{
    context::RequestContext,
    contract::{
        AgentContext, Cancel, EngineError, MemoryOpErrorCode, MemoryRow, MemoryShareResult,
        MemoryShareTarget, Principal, ShareOptions, StoreError,
    },
    embedding::{EmbedKind, EmbeddingProvider},
    recall::{acl, lifecycle::is_recall_entry_live},
    store::{
        identity::identity_id, shared_row::ShareMetadata, tombstone::TombstoneRegistry, Store,
    },
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;
/// Host-owned workspace/user destinations, resolved only from the proved request.
pub trait SharedStores: Send + Sync {
    /// Platform support is checked before looking up the requested card.
    fn supported(&self) -> bool;
    /// Non-secret platform reason attached to an unsupported proposal acceptance.
    fn unsupported_reason(&self) -> &str {
        "platform"
    }
    /// Lease the current writable shared generation, with sharing columns already migrated.
    fn target(
        &self,
        context: &RequestContext,
        scope: MemoryShareTarget,
    ) -> Result<Arc<Store>, StoreError>;
}
/// Explicit share dependencies; no provider is selected by vector width alone.
pub struct ShareServices {
    /// Same-context read sources for the anti-oracle shared-copy lookup.
    pub reader: Arc<MemoryReader>,
    /// Configured target pools.
    pub stores: Arc<dyn SharedStores>,
    /// Active and retained identity providers, first used only for a legacy target without metadata.
    pub providers: Vec<Arc<dyn EmbeddingProvider>>,
}
/// One implementation of the shared-card sensitivity gate for human and admin callers.
#[must_use]
pub fn sensitive(row: &MemoryRow) -> bool {
    const CATEGORIES: &[&str] = &[
        "access/password",
        "account",
        "birthday",
        "credential",
        "health",
        "money",
        "money/account",
        "password",
        "person",
        "relationship",
        "secret",
    ];
    row.memory_class == "core"
        || row.never_forget.as_f64() == Some(1.)
        || CATEGORIES.contains(&crate::text::js::js_to_lower_case(&row.category).as_str())
        || CATEGORIES.contains(&crate::text::js::js_to_lower_case(&row.type_).as_str())
        || row.importance.as_f64().is_some_and(|n| n >= 0.9)
}
fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
/// Exact Node share key, independent of the random copy UUID.
#[must_use]
pub fn idempotency_key(
    scope: MemoryShareTarget,
    principal: &str,
    agent: &str,
    row: &MemoryRow,
) -> String {
    let text = if row.text.is_empty() {
        &row.summary
    } else {
        &row.text
    };
    digest(&format!(
        "explicit_share\0{scope}\0{principal}\0{agent}\0{}\0{}",
        row.id,
        digest(text)
    ))
}
fn fingerprint(row: &MemoryRow) -> Value {
    json!([
        row.id,
        row.text,
        row.summary,
        row.category,
        row.type_,
        null,
        null,
        null,
        row.importance,
        null,
        row.memory_class,
        row.never_forget,
        row.scope,
        row.agent_id,
        row.stored_by,
        row.owner_user_id,
        row.workspace_id,
        row.workspace_key,
        row.status,
        row.expires_at
    ])
}
fn storage(_: StoreError) -> EngineError {
    error(MemoryOpErrorCode::Storage)
}
impl MemoryWriter {
    /// Add explicit sharing without changing the frozen MemoryOps/RPC signatures.
    #[must_use]
    pub fn with_sharing(mut self, services: ShareServices) -> Self {
        self.sharing = Some(services);
        self
    }
    /// Share an owned live card after explicit foreground authorization.
    pub fn share(
        &self,
        id: &str,
        target: MemoryShareTarget,
        principal: &Principal,
        agent: &AgentContext,
        options: &ShareOptions,
    ) -> Result<MemoryShareResult, EngineError> {
        self.share_at(
            id,
            target,
            principal,
            agent,
            options,
            self.context.host().now_ms(),
        )
    }
    /// Share using one captured operation clock; the source is rechecked after embeddings.
    pub fn share_at(
        &self,
        id: &str,
        target: MemoryShareTarget,
        principal: &Principal,
        agent: &AgentContext,
        options: &ShareOptions,
        now: i64,
    ) -> Result<MemoryShareResult, EngineError> {
        let operation = self.context.enter(principal, agent)?;
        let _mutation = self.context.mutation()?;
        self.share_locked(id, target, &operation.context, options, now)
    }
    // The caller holds the lifecycle guard and common mutation lock throughout a refresh.
    pub(super) fn share_locked(
        &self,
        id: &str,
        target: MemoryShareTarget,
        ctx: &RequestContext,
        options: &ShareOptions,
        now: i64,
    ) -> Result<MemoryShareResult, EngineError> {
        self.context.destructive_workspace(ctx)?;
        let target_principal = match target {
            MemoryShareTarget::Workspace => &ctx.workspace_key,
            MemoryShareTarget::User => &ctx.owner_user_id,
        };
        if ctx.trust() != "proved" || target_principal.is_empty() {
            return Err(error(MemoryOpErrorCode::Denied));
        }
        let services = self
            .sharing
            .as_ref()
            .ok_or_else(|| error(MemoryOpErrorCode::Storage))?;
        if !services.stores.supported() {
            return Err(error(MemoryOpErrorCode::Unsupported));
        }
        if !valid_id(id) {
            return Err(error(MemoryOpErrorCode::InvalidInput));
        }
        let private = self.stores.existing_private(ctx).map_err(storage)?;
        let record = private
            .as_ref()
            .map(|store| store.get_record(id))
            .transpose()
            .map_err(storage)?
            .flatten();
        let Some(record) = record.filter(|record| {
            acl::allowed(&record.row, ctx).is_ok() && is_recall_entry_live(&record.row, now, None)
        }) else {
            services.reader.find_visible_record(id, ctx, now)?;
            return Err(error(MemoryOpErrorCode::Denied));
        };
        let source = record.row;
        if record
            .sharing
            .as_ref()
            .is_some_and(|share| !share.source_memory_id.is_empty())
        {
            return Err(error(MemoryOpErrorCode::Denied));
        }
        if [&source.agent_id, &source.stored_by]
            .iter()
            .any(|owner| !owner.is_empty() && owner.as_str() != ctx.agent_id.as_str())
        {
            return Err(error(MemoryOpErrorCode::NotFound));
        }
        if sensitive(&source) && options.allow_sensitive != Some(true) {
            return Err(error(MemoryOpErrorCode::ApprovalRequired));
        }
        let registry =
            TombstoneRegistry::new(&self.base, ctx.agent_id.as_str()).map_err(storage)?;
        if registry
            .find_by_origin(id, false)
            .map_err(storage)?
            .is_some()
        {
            return Err(error(MemoryOpErrorCode::NotFound));
        }
        let target_store = services.stores.target(ctx, target).map_err(storage)?;
        let expected = target_store
            .identity()
            .map(identity_id)
            .transpose()
            .map_err(storage)?;
        let provider = services
            .providers
            .iter()
            .find(|provider| {
                expected
                    .as_ref()
                    .is_none_or(|id| identity_id(provider.identity()).as_ref() == Ok(id))
            })
            .ok_or_else(|| error(MemoryOpErrorCode::EmbedderUnavailable))?;
        let text = if source.text.is_empty() {
            &source.summary
        } else {
            &source.text
        };
        let vectors = provider
            .embed(
                std::slice::from_ref(text),
                EmbedKind::Passage,
                &Cancel::never(),
            )
            .map_err(|_| error(MemoryOpErrorCode::Storage))?;
        if vectors.len() != 1 {
            return Err(error(MemoryOpErrorCode::EmbeddingIdentityMismatch));
        }
        let vector = vectors
            .into_iter()
            .next()
            .ok_or_else(|| error(MemoryOpErrorCode::EmbeddingIdentityMismatch))?;
        if target_store
            .identity()
            .is_some_and(|identity| identity.dimension.as_u64() != Some(vector.len() as u64))
            || vector.iter().any(|n| !n.is_finite())
        {
            return Err(error(MemoryOpErrorCode::EmbeddingIdentityMismatch));
        }
        let private = private.ok_or_else(|| error(MemoryOpErrorCode::NotFound))?;
        let current = private
            .get(id)
            .map_err(storage)?
            .ok_or_else(|| error(MemoryOpErrorCode::Storage))?;
        if fingerprint(&current) != fingerprint(&source) {
            return Err(error(MemoryOpErrorCode::Conflict));
        }
        if !is_recall_entry_live(&current, now, None) || acl::allowed(&current, ctx).is_err() {
            return Err(error(MemoryOpErrorCode::NotFound));
        }
        self.context.assert_open()?;
        let key = idempotency_key(target, target_principal, ctx.agent_id.as_str(), &source);
        let existing = target_store.shared_by_key(&key).map_err(storage)?;
        if existing.len() > 1 {
            return Err(error(MemoryOpErrorCode::Storage));
        }
        let shared_id = if let Some(existing) = existing.first() {
            existing.row.id.clone()
        } else {
            let mut copy = source.clone();
            copy.id = uuid::Uuid::new_v4().to_string();
            copy.vector = vector;
            copy.scope = target.to_string();
            copy.status = "active".into();
            copy.agent_id = ctx.agent_id.to_string();
            copy.stored_by = copy.agent_id.clone();
            copy.workspace_id = if target == MemoryShareTarget::Workspace {
                target_principal.clone()
            } else {
                String::new()
            };
            copy.workspace_key = copy.workspace_id.clone();
            copy.owner_user_id = if target == MemoryShareTarget::User {
                target_principal.clone()
            } else {
                String::new()
            };
            copy.previous_version.clear();
            copy.superseded_by.clear();
            // The order is Node's JSON.stringify object order, part of the stored provenance string.
            let provenance=format!("{{\"schemaVersion\":1,\"action\":\"explicit_share\",\"targetScope\":{},\"targetPrincipalHash\":{},\"sourceMemoryId\":{},\"sourceAgentId\":{},\"sharedAt\":{now}}}",json!(target.to_string()),json!(digest(target_principal)),json!(source.id),json!(ctx.agent_id.as_str()));
            let sharing = ShareMetadata {
                source_memory_id: source.id.clone(),
                source_agent_id: ctx.agent_id.to_string(),
                share_idempotency_key: key.clone(),
                share_provenance: provenance,
            };
            self.context.assert_open()?;
            target_store
                .upsert_shared(&[(copy.clone(), sharing)], &self.base)
                .map_err(storage)?;
            let saved = target_store
                .get_record(&copy.id)
                .map_err(storage)?
                .ok_or_else(|| error(MemoryOpErrorCode::Storage))?;
            if saved
                .sharing
                .as_ref()
                .is_none_or(|s| s.share_idempotency_key != key)
            {
                return Err(error(MemoryOpErrorCode::Storage));
            }
            copy.id
        };
        serde_json::from_value(json!({"sourceId":id,"sharedId":shared_id,"target":target}))
            .map_err(|_| error(MemoryOpErrorCode::Storage))
    }
}
