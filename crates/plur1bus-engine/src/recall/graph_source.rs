//! Request-bound Neo graph metadata checked against each actual namespace table.
use super::{
    acl::AclSubject,
    graph::{GraphEdge, GRAPH_ACL_MAX_ENDPOINT_IDS, GRAPH_ACL_MAX_INSPECTED_EDGES},
    lifecycle, namespace_entry, reactivation_acl,
    stages::StageError,
};
use crate::{
    context::RequestContext,
    contract::{Cancel, StoreError},
    embedding::EmbedError,
    neo::merged::{MetadataReader, RecordKind},
    store::Store,
    text::json::{write_json, TolerantJsonValue as Json},
};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    path::Path,
};

/// Original request and physical Neo root; no cross-request or cross-table row cache.
/// Opening and reading are read-only. Absence of a configured source is a separate
/// composition decision, never a fallback after this source fails.
pub struct BoundGraphSource {
    reader: MetadataReader,
    context: RequestContext,
}
impl BoundGraphSource {
    /// Bind an existing trusted Neo root to the same canonical request as recall.
    pub fn open(root: &Path, context: &RequestContext) -> Result<Self, StoreError> {
        Ok(Self {
            reader: MetadataReader::open(root, &context.workspace_key)?,
            context: context.clone(),
        })
    }
    /// Load after query/provider work, immediately before graph traversal. The normal
    /// stage still checks lifecycle/ACL when hydrating selected endpoints afterward.
    pub fn read_for(
        &self,
        store: &Store,
        context: &RequestContext,
        now_ms: i64,
        valid_at: Option<i64>,
        cancel: &Cancel,
    ) -> Result<Vec<GraphEdge>, StageError> {
        check(cancel)?;
        if context != &self.context {
            return Err(StageError::Store(StoreError::InvalidInput));
        }
        let subject = AclSubject::from_context(context);
        let records = self
            .reader
            .read_metadata(RecordKind::Graph, 5000, context)
            .map_err(StageError::Store)?;
        let mut rows = HashMap::new();
        let mut output = Vec::new();
        for metadata in records.iter().take(GRAPH_ACL_MAX_INSPECTED_EDGES) {
            check(cancel)?;
            if !unique(metadata) {
                continue;
            }
            let Ok(edge) = serde_json::from_str::<Value>(&write_json(metadata)) else {
                continue;
            };
            // D130: an agent-private claim cannot route another user's row just
            // because the old general private ACL accepts a matching agent.
            if ["sourceOwnership", "targetOwnership"].iter().any(|key| {
                let tuple = &edge[*key];
                tuple["scope"] == "agent-private"
                    && (context.owner_user_id.is_empty()
                        || context.workspace_key.is_empty()
                        || tuple["ownerUserId"] != context.owner_user_id
                        || tuple["workspaceIdentity"] != context.workspace_key)
            }) {
                continue;
            }
            if reactivation_acl::safe_edges(std::slice::from_ref(&edge), Some(&subject)).is_empty()
            {
                continue;
            }
            let (Some(source), Some(target), Some(kind), Some(directed), Some(strength)) = (
                edge["source"].as_str(),
                edge["target"].as_str(),
                edge["type"].as_str(),
                edge["directed"].as_bool(),
                edge["strength"].as_f64(),
            ) else {
                continue;
            };
            if !strength.is_finite() || !(0.0..=1.0).contains(&strength) {
                continue;
            }
            for id in [source, target] {
                if !rows.contains_key(id) && rows.len() < GRAPH_ACL_MAX_ENDPOINT_IDS {
                    check(cancel)?;
                    let row = store.get(id).map_err(StageError::Store)?;
                    rows.insert(
                        id.to_owned(),
                        row.filter(|row| lifecycle::is_recall_entry_live(row, now_ms, valid_at))
                            .map(|row| namespace_entry::project_entry(&row)),
                    );
                }
            }
            if [(source, "sourceOwnership"), (target, "targetOwnership")]
                .iter()
                .all(|(id, key)| {
                    rows.get(*id).and_then(Option::as_ref).is_some_and(|row| {
                        reactivation_acl::authorized(
                            row,
                            Some(&subject),
                            Some(&edge[*key]),
                            now_ms as f64,
                        )
                    })
                })
            {
                output.push(GraphEdge {
                    source: source.into(),
                    target: target.into(),
                    strength,
                    directed,
                    kind: kind.into(),
                });
            }
        }
        check(cancel)?;
        // Recheck the held root after all physical row reads; this is not an atomic
        // snapshot across Neo and Lance or an external-writer CAS claim.
        self.reader
            .read_metadata(RecordKind::Graph, 0, context)
            .map_err(StageError::Store)?;
        Ok(output)
    }
}
fn check(cancel: &Cancel) -> Result<(), StageError> {
    cancel
        .check()
        .map_err(|error| StageError::Embed(EmbedError::Cancelled(error)))
}
fn unique(value: &Json) -> bool {
    match value {
        Json::Object(fields) => {
            let mut names = HashSet::new();
            fields
                .iter()
                .all(|(name, value)| names.insert(name) && unique(value))
        }
        Json::Array(values) => values.iter().all(unique),
        _ => true,
    }
}
