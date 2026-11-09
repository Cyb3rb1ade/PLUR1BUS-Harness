//! Best-effort canonical graph cleanup under the original rollback caller and physical roots.
use super::{
    append_cap_io, append_source::SourceProof, capture_journal::CaptureJournal,
    correction_effects::EffectAuthority, journal_io, merged_order::field,
};
use crate::{
    context::{is_user_principal, RequestContext},
    contract::{EngineError, MemoryRow, StoreError},
    ops::{
        context::OperationContext,
        unimport::{UnimportCleanup, UnimportStores},
    },
    store::{directory::TrustedDirectory, Store},
    text::json::{parse_json, TolerantJsonValue as Json},
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};
const GRAPH: &str = "memory-graph.jsonl";

/// Admission is captured before archive callbacks; a later cleanup cannot rebind an old request.
pub(crate) struct UnimportGraph {
    operation: Arc<OperationContext>,
    journal: Arc<CaptureJournal>,
    stores: Arc<dyn UnimportStores>,
    authority: EffectAuthority,
    request: RequestContext,
    config: Value,
    workspace: TrustedDirectory,
    base: TrustedDirectory,
}
impl UnimportGraph {
    pub(crate) fn open(
        operation: Arc<OperationContext>,
        journal: Arc<CaptureJournal>,
        stores: Arc<dyn UnimportStores>,
        authority: EffectAuthority,
    ) -> Result<Self, EngineError> {
        let host = operation.host();
        let request = RequestContext::build(&authority.principal, &authority.agent, host)?;
        if !is_user_principal(&request.owner_user_id) || request.workspace_key.is_empty() {
            return Err(StoreError::InvalidInput.into());
        }
        let workspace = host
            .workspace_dir(&request.agent_id)?
            .ok_or(StoreError::InvalidInput)?;
        let this = Self {
            config: serde_json::to_value(host.config()).map_err(|_| StoreError::Corrupt)?,
            workspace: TrustedDirectory::open(&workspace)?,
            base: TrustedDirectory::open(&authority.base_db)?,
            operation,
            journal,
            stores,
            authority,
            request,
        };
        this.check()?;
        Ok(this)
    }
    fn check(&self) -> Result<(), EngineError> {
        self.authority.cancel.check()?;
        self.operation.assert_open()?;
        self.workspace.assert_unchanged()?;
        self.base.assert_unchanged()?;
        let host = self.operation.host();
        if RequestContext::build(&self.authority.principal, &self.authority.agent, host)?
            != self.request
            || host.workspace_dir(&self.request.agent_id)?.as_deref() != Some(self.workspace.path())
            || serde_json::to_value(host.config()).map_err(|_| StoreError::Corrupt)? != self.config
        {
            return Err(StoreError::InvalidInput.into());
        }
        Ok(())
    }
    pub(crate) fn run(
        &self,
        ids: &[String],
        lease: &dyn Fn() -> Result<(), EngineError>,
    ) -> Result<UnimportCleanup, EngineError> {
        self.check()?;
        self.journal.with_operation_cleanup(
            &self.authority.principal,
            &self.authority.agent,
            &self.request,
            &self.authority.cancel,
            &|| {
                self.check()?;
                lease()
            },
            |dir, check| {
                let store = self
                    .stores
                    .existing(&self.request)?
                    .ok_or(StoreError::Unavailable)?;
                let mut evidence = HashMap::new();
                let mut drop = HashSet::new();
                for id in ids {
                    check()?;
                    let row = store.get(id)?.ok_or(StoreError::InvalidInput)?;
                    if !private(&row, &self.request)
                        || row.status != "deleted"
                        || row.epistemic_status != "invalidated"
                    {
                        return Err(StoreError::InvalidInput.into());
                    }
                    drop.insert(id.as_str());
                    evidence.insert(id.clone(), fingerprint(&row)?);
                }
                let Some((source, before)) = SourceProof::read(dir, GRAPH, &self.authority.cancel)?
                else {
                    return Ok(UnimportCleanup::default());
                };
                let mut kept = Vec::with_capacity(before.len());
                let mut result = UnimportCleanup::default();
                for (index, line) in before.split_inclusive(|b| *b == b'\n').enumerate() {
                    check()?;
                    if index >= journal_io::MAX_ROWS {
                        return Err(StoreError::Corrupt.into());
                    }
                    // Opaque/malformed bytes and incomplete appends are never reconstructed.
                    let row = line
                        .ends_with(b"\n")
                        .then(|| std::str::from_utf8(line).ok())
                        .flatten()
                        .and_then(|s| parse_json(s).ok())
                        .filter(|row| super::derived_fields::validate_object(row).is_ok());
                    let remove = if let Some(row) = row {
                        let source = text(&row, "source");
                        let target = text(&row, "target");
                        if source.as_deref().is_some_and(|id| drop.contains(id))
                            || target.as_deref().is_some_and(|id| drop.contains(id))
                        {
                            let owned = journal_io::owned(&row, &self.request)
                                && super::acl::bindings(&row, &self.request)?.scope
                                    == "agent_private";
                            let peers = if !owned {
                                false
                            } else if let (Some(source), Some(target)) = (source, target) {
                                self.peer(&store, &source, &mut evidence)?
                                    && self.peer(&store, &target, &mut evidence)?
                            } else {
                                false
                            };
                            if !owned || !peers {
                                result.cleanup_errors = 1;
                            }
                            owned && peers
                        } else {
                            false
                        }
                    } else {
                        false
                    };
                    if remove {
                        result.graph_edges_removed += 1;
                    } else {
                        kept.extend_from_slice(line);
                    }
                }
                if result.graph_edges_removed > 0 {
                    let recheck = || {
                        check()?;
                        for (id, row) in &evidence {
                            if store
                                .get(id)?
                                .as_ref()
                                .map(fingerprint)
                                .transpose()?
                                .as_ref()
                                != Some(row)
                            {
                                return Err(StoreError::InvalidInput.into());
                            }
                        }
                        // Policy/row callbacks above may revoke the outer import lease.
                        // Fence it last as well, immediately before physical publication.
                        self.check()?;
                        lease()
                    };
                    recheck()?;
                    source.verify(dir, GRAPH, &before)?;
                    append_cap_io::replace_live(
                        dir,
                        GRAPH,
                        source.identity,
                        &before,
                        &kept,
                        &self.authority.cancel,
                        &recheck,
                    )?;
                }
                Ok(result)
            },
        )
    }
    fn peer(
        &self,
        store: &Store,
        id: &str,
        evidence: &mut HashMap<String, [u8; 32]>,
    ) -> Result<bool, EngineError> {
        if evidence.contains_key(id) {
            return Ok(true);
        }
        let Some(row) = store.get(id)? else {
            return Ok(false);
        };
        if !private(&row, &self.request) {
            return Ok(false);
        }
        evidence.insert(id.to_owned(), fingerprint(&row)?);
        Ok(true)
    }
}
fn private(row: &MemoryRow, ctx: &RequestContext) -> bool {
    row.scope == "agent-private"
        && row.agent_id == ctx.agent_id.as_str()
        && row.stored_by == ctx.agent_id.as_str()
        && row.owner_user_id == ctx.owner_user_id
        && row.workspace_key == ctx.workspace_key
        && (row.workspace_id.is_empty() || row.workspace_id == ctx.workspace_key)
}
fn text(row: &Json, key: &str) -> Option<String> {
    match field(row, key) {
        Some(Json::String(s)) => {
            let value = s.to_utf8_lossy();
            (crate::text::js::JsString::from(value.as_str()) == *s).then_some(value)
        }
        _ => None,
    }
}

fn fingerprint(row: &MemoryRow) -> Result<[u8; 32], EngineError> {
    let bytes = serde_json::to_vec(row).map_err(|_| StoreError::Corrupt)?;
    Ok(Sha256::digest(bytes).into())
}
