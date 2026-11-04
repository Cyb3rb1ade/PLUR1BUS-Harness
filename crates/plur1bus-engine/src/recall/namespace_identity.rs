//! The pin's per-identity routing, empty-child degradation and reciprocal-rank fusion.

use std::collections::HashMap;

use serde_json::{json, Value};

use crate::contract::StoreError;
use crate::contract::VectorSpaceIdentity;
use crate::embedding::identity::try_identity_id;
use crate::embedding::{EmbedError, EmbeddingProvider};

use super::merge::{merge, MergeOptions, NamespaceResult};
use super::namespaces::{NamespaceError, CANDIDATE_HARD_LIMIT};

/// Node's default RRF denominator offset.
pub const DEFAULT_RRF_K: f64 = 60.0;

pub(crate) struct Routed<'a> {
    pub identity: Option<String>,
    pub provider: Option<&'a dyn EmbeddingProvider>,
}

pub(crate) fn route<'a>(
    expected: Option<&VectorSpaceIdentity>,
    active: &'a dyn EmbeddingProvider,
    providers: &[&'a dyn EmbeddingProvider],
) -> Result<Routed<'a>, NamespaceError> {
    let identity = expected
        .map(try_identity_id)
        .transpose()
        .map_err(NamespaceError::Store)?;
    let Some(id) = &identity else {
        return Ok(Routed {
            identity,
            provider: Some(active),
        });
    };
    for provider in std::iter::once(active).chain(providers.iter().copied()) {
        if try_identity_id(provider.identity()).map_err(NamespaceError::Store)? == *id {
            return Ok(Routed {
                identity,
                provider: Some(provider),
            });
        }
    }
    Ok(Routed {
        identity,
        provider: None,
    })
}

pub(crate) fn unavailable(
    namespace: Option<&str>,
    identity: Option<String>,
    code: &str,
) -> NamespaceResult {
    let degraded = json!({"reason":"embedding-unavailable","capability":"recall",
        "identities":[{"identityId":identity,"code":code}]});
    NamespaceResult {
        namespace: namespace.map(str::to_owned),
        identity_id: identity,
        degraded: Some(degraded),
        ..NamespaceResult::default()
    }
}

pub(crate) fn failure_code(error: &EmbedError) -> &'static str {
    match error {
        EmbedError::DimensionMismatch { .. } | EmbedError::InvalidVector => {
            "EMBEDDING_IDENTITY_MISMATCH"
        }
        EmbedError::Cancelled(_) | EmbedError::Unavailable | EmbedError::ProviderFailed { .. } => {
            "EMBEDDING_FAILED"
        }
    }
}

/// Merge each space independently, fuse ranks, then perform the ordinary global merge.
pub(crate) fn merge_spaces(
    children: &[NamespaceResult],
    options: &MergeOptions,
    k: f64,
) -> Result<NamespaceResult, NamespaceError> {
    if !k.is_finite() || k <= 0.0 {
        return Err(NamespaceError::Store(StoreError::InvalidInput));
    }
    let mut groups: Vec<(Option<String>, Vec<NamespaceResult>)> = Vec::new();
    for child in children {
        if let Some((_, group)) = groups.iter_mut().find(|(id, _)| *id == child.identity_id) {
            group.push(child.clone()); // Group merges tag independent wrapper copies, as Node does.
        } else {
            groups.push((child.identity_id.clone(), vec![child.clone()]));
        }
    }
    let mut grouped_options = options.clone();
    grouped_options.max_out = CANDIDATE_HARD_LIMIT;
    grouped_options.trace_limits = None;
    let ranked = groups
        .into_iter()
        .map(|(id, group)| (id, merge(&group, &grouped_options)))
        .collect::<Vec<_>>();
    let mut fused = vec![NamespaceResult {
        memories: fuse(&ranked, false, k),
        canonical: fuse(&ranked, true, k),
        ..NamespaceResult::default()
    }];
    fused.extend(children.iter().map(|child| NamespaceResult {
        namespace: child.namespace.clone(),
        source_kind: child.source_kind.clone(),
        trace: child.trace.clone(),
        ..NamespaceResult::default()
    }));
    let mut result = merge(&fused, options);
    result.degraded = degradation(children);
    Ok(result)
}

struct Fused {
    item: Value,
    score: f64,
    ordinal: usize,
}

fn fuse(groups: &[(Option<String>, NamespaceResult)], canonical: bool, k: f64) -> Vec<Value> {
    let mut positions: HashMap<String, usize> = HashMap::new();
    let mut merged: Vec<Fused> = Vec::new();
    for (identity, result) in groups {
        let items = if canonical {
            &result.canonical
        } else {
            &result.memories
        };
        for (rank, item) in items.iter().enumerate() {
            let key = fusion_key(item, identity.as_deref(), merged.len());
            let score = 1.0 / (k + rank as f64 + 1.0);
            if let Some(index) = positions.get(&key).copied() {
                merged[index].score += score;
            } else {
                positions.insert(key, merged.len());
                merged.push(Fused {
                    item: item.clone(),
                    score,
                    ordinal: merged.len(),
                });
            }
        }
    }
    merged.sort_by(|a, b| b.score.total_cmp(&a.score).then(a.ordinal.cmp(&b.ordinal)));
    merged
        .into_iter()
        .map(|mut item| {
            item.item["score"] = json!(item.score);
            item.item
        })
        .collect()
}

fn fusion_key(item: &Value, identity: Option<&str>, ordinal: usize) -> String {
    item.get("entry")
        .and_then(|entry| entry.get("id"))
        .filter(|id| !id.is_null())
        .or_else(|| item.get("id").filter(|id| !id.is_null()))
        .cloned()
        .unwrap_or_else(|| json!(format!("{}:{ordinal}", identity.unwrap_or("undefined"))))
        .to_string()
}

pub(crate) fn degradation(children: &[NamespaceResult]) -> Option<Value> {
    let mut failures = Vec::new();
    for child in children {
        for failure in child
            .degraded
            .as_ref()
            .and_then(|v| v["identities"].as_array())
            .into_iter()
            .flatten()
        {
            if !failures
                .iter()
                .any(|old: &Value| old["identityId"] == failure["identityId"])
            {
                failures.push(failure.clone());
            }
        }
    }
    (!failures.is_empty()).then(|| {
        json!({"reason":"embedding-unavailable",
        "capability":"recall","identities":failures})
    })
}
