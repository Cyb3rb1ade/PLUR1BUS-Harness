//! Foreground system-only ownership migration with durable intents and conservative reversal.
use super::{
    context::{error, OperationContext},
    import_primitives::field,
    rebind_ledger::{self, RebindLease, RebindLedger, RebindRecord},
};
use crate::{
    context::{harness_user_principal, principal_key, validated_identity, RequestContext},
    contract::{
        limits::{ACCOUNT_ID, CHANNEL_ID, USER_ID},
        AgentContext, Cancel, EngineError, MemoryOpErrorCode, MemoryRebindRequest,
        MemoryRebindResult, MemoryRow, MemoryScope, MemoryUnbindRequest, MemoryUnbindResult,
        Principal, StoreError, TurnOrigin,
    },
    store::{tombstone::TombstoneRegistry, RowFilter, RowPatch, Store},
    text::json::TolerantJsonValue as Json,
};
use serde_json::json;
use std::{collections::HashSet, path::PathBuf, sync::Arc, time::Duration};
fn storage<T>(_: T) -> EngineError {
    error(MemoryOpErrorCode::Storage)
}
fn live(row: &MemoryRow) -> bool {
    row.status.is_empty() || row.status == "active"
}
fn required(row: &Json, key: &str) -> Result<String, EngineError> {
    rebind_ledger::string(row, key)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| error(MemoryOpErrorCode::LedgerCorrupt))
}
/// Host-owned physical store routes, reached only after foreground/system admission.
pub trait RebindStores: Send + Sync {
    /// Non-creating authoritative read for preview.
    fn existing(&self, ctx: &RequestContext) -> Result<Option<Arc<Store>>, StoreError>;
    /// Writable authoritative store for this operator's agent.
    fn writable(&self, ctx: &RequestContext) -> Result<Arc<Store>, StoreError>;
    /// Change only ownership; `updatedAt` remains the unbind conflict baseline.
    fn patch_owner(&self, store: &Store, id: &str, owner: &str) -> Result<(), StoreError> {
        store.patch(
            id,
            &RowPatch {
                owner_user_id: Some(owner.to_owned()),
                ..Default::default()
            },
        )
    }
}
/// Identity migration owner. It does not advertise any engine capability itself.
pub struct Rebinder {
    context: Arc<OperationContext>,
    stores: Arc<dyn RebindStores>,
    ledger: RebindLedger,
    base: PathBuf,
}
impl Rebinder {
    /// Compose request guards, authoritative routes and the global rebind sidecar directory.
    pub fn new(
        context: Arc<OperationContext>,
        stores: Arc<dyn RebindStores>,
        base: PathBuf,
    ) -> Self {
        Self {
            context,
            stores,
            ledger: RebindLedger::new(&base),
            base,
        }
    }
    fn registry(&self, ctx: &RequestContext) -> Result<TombstoneRegistry, EngineError> {
        TombstoneRegistry::new(&self.base, ctx.agent_id.as_str()).map_err(storage)
    }
    fn check(&self, lease: &RebindLease, cancel: &Cancel) -> Result<(), EngineError> {
        cancel.check()?;
        self.context.assert_open()?;
        lease.assert_held()
    }
    fn matches(
        &self,
        store: Option<&Store>,
        owner: &str,
        registry: &TombstoneRegistry,
        cancel: &Cancel,
    ) -> Result<Vec<MemoryRow>, EngineError> {
        let Some(store) = store else {
            return Ok(vec![]);
        };
        let filter = RowFilter {
            scope: Some(MemoryScope::User),
            owner_user_id: Some(owner.to_owned()),
            status: Some("active".into()),
            ..Default::default()
        };
        let rows = store
            .scan(&filter, store.count(&filter).map_err(storage)?)
            .map_err(storage)?;
        let mut out = vec![];
        for row in rows {
            cancel.check()?;
            if rebind_ledger::valid_id(&row.id)
                && registry
                    .find_by_origin(&row.id, false)
                    .map_err(storage)?
                    .is_none()
            {
                out.push(row)
            }
        }
        Ok(out)
    }
    fn bound(
        &self,
        from: &str,
        to: &str,
        agent: &str,
    ) -> Result<Option<(String, RebindRecord)>, EngineError> {
        let applied = self.ledger.list_applied()?;
        let mut existing = None;
        for (id, rec) in applied {
            let Some(header) = &rec.header else { continue };
            if required(header, "fromOwner")? != from {
                continue;
            }
            if required(header, "toOwner")? != to {
                return Err(error(MemoryOpErrorCode::IdentityAlreadyBound));
            }
            if required(header, "agentId")? == agent {
                existing = Some((id, rec));
            }
        }
        // A claim persists before the first header, including an interrupted apply.
        // Check it even when journals exist: conflicting authorities cannot grant access.
        if let Some(claim) = self.ledger.read_claim(from)? {
            if required(&claim, "toOwner")? != to {
                return Err(error(MemoryOpErrorCode::IdentityAlreadyBound));
            }
        }
        Ok(existing)
    }
    /// Preview by default; apply requires explicit `dryRun: false`.
    pub fn rebind(
        &self,
        req: &MemoryRebindRequest,
        p: &Principal,
        a: &AgentContext,
        cancel: &Cancel,
    ) -> Result<MemoryRebindResult, EngineError> {
        if a.origin != TurnOrigin::System || a.background {
            return Err(error(MemoryOpErrorCode::Denied));
        }
        let op = self.context.enter(p, a)?;
        let ctx = &op.context;
        if req.agent_id != p.agent_id || req.agent_id != ctx.agent_id {
            return Err(error(MemoryOpErrorCode::InvalidInput));
        }
        crate::context::safe_agent_id(req.agent_id.as_str())
            .map_err(|_| error(MemoryOpErrorCode::InvalidInput))?;
        let input = serde_json::to_value(&req.from_identity).map_err(storage)?;
        let validate = |s: Option<&str>, max, name, required| {
            validated_identity(s, max, name, required)
                .map_err(|_| error(MemoryOpErrorCode::InvalidInput))
        };
        let channel = validate(input["channel"].as_str(), CHANNEL_ID, "channel", true)?;
        let identity = validate(input["identityKey"].as_str(), USER_ID, "identityKey", true)?;
        let account = match input["accountId"].as_str() {
            None | Some("") => "default".into(),
            value => validate(value, ACCOUNT_ID, "accountId", false)?,
        };
        let user = validate(Some(&req.to_user), USER_ID, "toUser", true)?;
        let from = principal_key(&channel, &account, &identity);
        let to = harness_user_principal(&user);
        if from == to {
            return Err(error(MemoryOpErrorCode::InvalidInput));
        }
        let dry = req.dry_run != Some(false);
        cancel.check()?;
        let lease = if dry {
            None
        } else {
            Some(self.ledger.acquire(cancel, Duration::from_secs(20))?)
        };
        let existing = self.bound(&from, &to, ctx.agent_id.as_str())?;
        let registry = self.registry(ctx)?;
        if dry {
            let store = self.stores.existing(ctx).map_err(storage)?;
            let matched = self
                .matches(store.as_deref(), &from, &registry, cancel)?
                .len();
            return serde_json::from_value(
                json!({"rebindId":"","matched":matched,"rebound":0,"skipped":0,"dryRun":true}),
            )
            .map_err(storage);
        }
        let lease = lease
            .as_ref()
            .ok_or_else(|| error(MemoryOpErrorCode::Storage))?;
        let store = self.stores.writable(ctx).map_err(storage)?;
        self.check(lease, cancel)?;
        let id = existing
            .as_ref()
            .map(|(id, _)| id.clone())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        if existing.is_none() {
            let now = self.context.host().now_ms();
            lease.write_claim(&from, &to, now)?;
            self.check(lease, cancel)?;
            lease.write_header(&id, ctx.agent_id.as_str(), &from, &to, now)?;
        }
        let rec = self.ledger.load(&id)?;
        let mut already = HashSet::new();
        let matches = self.matches(Some(&store), &from, &registry, cancel)?;
        let matched = matches.len();
        let mut rebound = 0;
        for card in rec.cards {
            let card_id = required(&card, "cardId")?;
            if !rebind_ledger::valid_id(&card_id) {
                return Err(error(MemoryOpErrorCode::LedgerCorrupt));
            }
            already.insert(card_id.clone());
            self.check(lease, cancel)?;
            if let Some(row) = store.get(&card_id).map_err(storage)? {
                if row.owner_user_id == from
                    && row.scope == "user"
                    && live(&row)
                    && registry
                        .find_by_origin(&card_id, false)
                        .map_err(storage)?
                        .is_none()
                {
                    self.check(lease, cancel)?;
                    self.stores
                        .patch_owner(&store, &card_id, &to)
                        .map_err(storage)?;
                    rebound += 1;
                }
            }
        }
        for row in matches {
            if already.contains(&row.id) {
                continue;
            }
            self.check(lease, cancel)?;
            // Re-read immediately before recording and applying; a correction can race the scan.
            let Some(current) = store.get(&row.id).map_err(storage)? else {
                continue;
            };
            if current.owner_user_id != from
                || current.scope != "user"
                || !live(&current)
                || registry
                    .find_by_origin(&row.id, false)
                    .map_err(storage)?
                    .is_some()
            {
                continue;
            }
            lease.append_card(
                &id,
                &row.id,
                &from,
                &to,
                current.updated_at.as_f64().unwrap_or(0.),
                self.context.host().now_ms(),
            )?;
            self.check(lease, cancel)?;
            self.stores
                .patch_owner(&store, &row.id, &to)
                .map_err(storage)?;
            rebound += 1;
        }
        serde_json::from_value(json!({"rebindId":id,"matched":matched,"rebound":rebound,"skipped":matched.saturating_sub(rebound),"dryRun":false})).map_err(storage)
    }
    /// Reverse only ownership still matching the recorded target and edit timestamp.
    pub fn unbind(
        &self,
        req: &MemoryUnbindRequest,
        p: &Principal,
        a: &AgentContext,
        cancel: &Cancel,
    ) -> Result<MemoryUnbindResult, EngineError> {
        if a.origin != TurnOrigin::System || a.background {
            return Err(error(MemoryOpErrorCode::Denied));
        }
        let op = self.context.enter(p, a)?;
        let ctx = &op.context;
        let id = req.rebind_id.to_ascii_lowercase();
        if !rebind_ledger::valid_id(&id) {
            return Err(error(MemoryOpErrorCode::InvalidInput));
        }
        let dry = req.dry_run == Some(true);
        cancel.check()?;
        let lease = if dry {
            None
        } else {
            Some(self.ledger.acquire(cancel, Duration::from_secs(20))?)
        };
        let rec = self.ledger.load(&id)?;
        let header = rec
            .header
            .as_ref()
            .filter(|h| {
                rebind_ledger::string(h, "agentId").as_deref() == Some(ctx.agent_id.as_str())
            })
            .ok_or_else(|| error(MemoryOpErrorCode::NotFound))?;
        let from = required(header, "fromOwner")?;
        let to = required(header, "toOwner")?;
        if !crate::context::is_user_principal(&from) || !crate::context::is_user_principal(&to) {
            return Err(error(MemoryOpErrorCode::LedgerCorrupt));
        }
        let matched = rec.cards.len();
        let mut unbound = 0;
        let mut skipped = 0;
        let mut modified = 0;
        if rec.reversed {
            if let Some(lease) = &lease {
                self.check(lease, cancel)?;
                lease.release_claim_if_free(&from)?;
            }
            skipped = matched;
        } else {
            let registry = self.registry(ctx)?;
            let store = if dry {
                self.stores.existing(ctx).map_err(storage)?
            } else {
                Some(self.stores.writable(ctx).map_err(storage)?)
            };
            for card in rec.cards {
                cancel.check()?;
                let card_id = required(&card, "cardId")?;
                if !rebind_ledger::valid_id(&card_id) {
                    return Err(error(MemoryOpErrorCode::LedgerCorrupt));
                }
                let row = store
                    .as_ref()
                    .map(|s| s.get(&card_id))
                    .transpose()
                    .map_err(storage)?
                    .flatten();
                let Some(row) = row else {
                    skipped += 1;
                    continue;
                };
                if row.owner_user_id == from {
                    skipped += 1;
                    continue;
                }
                let recorded = match field(&card, "fromUpdatedAt") {
                    None | Some(Json::Null) => None,
                    Some(value) => {
                        let n = super::import_primitives::number(value);
                        Some(if n.is_nan() { 0. } else { n })
                    }
                };
                if row.owner_user_id != to
                    || recorded.is_some_and(|time| row.updated_at.as_f64().unwrap_or(0.) != time)
                {
                    skipped += 1;
                    modified += 1;
                    continue;
                }
                // Ownership reversal must not re-authorize a deleted or scope-moved card.
                if row.scope != "user"
                    || !live(&row)
                    || registry
                        .find_by_origin(&card_id, false)
                        .map_err(storage)?
                        .is_some()
                {
                    skipped += 1;
                    modified += 1;
                    continue;
                }
                if let Some(lease) = &lease {
                    self.check(lease, cancel)?;
                    self.stores
                        .patch_owner(
                            store
                                .as_ref()
                                .ok_or_else(|| error(MemoryOpErrorCode::Storage))?,
                            &card_id,
                            &from,
                        )
                        .map_err(storage)?;
                }
                unbound += 1;
            }
            if let Some(lease) = &lease {
                self.check(lease, cancel)?;
                lease.append_reversed(&id, self.context.host().now_ms())?;
                self.check(lease, cancel)?;
                lease.release_claim_if_free(&from)?;
            }
        }
        serde_json::from_value(json!({"rebindId":id,"matched":matched,"unbound":unbound,"skipped":skipped,"skippedModified":modified,"dryRun":dry})).map_err(storage)
    }
}
