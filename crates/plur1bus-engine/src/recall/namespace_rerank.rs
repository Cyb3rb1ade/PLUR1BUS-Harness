//! The pin's single rerank after multi-identity rank fusion.

use std::collections::HashSet;

use serde_json::json;

use crate::contract::EngineError;
use crate::embedding::{Cancel, RerankError, Reranker};

use super::merge::NamespaceResult;
use super::namespaces::NamespaceError;

pub(crate) fn apply(
    result: &mut NamespaceResult,
    query: &str,
    reranker: &dyn Reranker,
    cancel: &Cancel,
    fallback: bool,
) -> Result<(), NamespaceError> {
    if result.memories.len() <= 1 {
        return Ok(());
    }
    let docs = result
        .memories
        .iter()
        .map(|item| item["entry"]["text"].as_str().unwrap_or("").to_owned())
        .collect::<Vec<_>>();
    let ranking = reranker
        .rerank(query, &docs, docs.len(), cancel)
        .and_then(|ranking| reordered_indices(&ranking, docs.len()));
    match ranking {
        Ok(order) => {
            let mut original = std::mem::take(&mut result.memories)
                .into_iter()
                .map(Some)
                .collect::<Vec<_>>();
            result.memories = order
                .into_iter()
                .filter_map(|index| original[index].take())
                .collect();
            result.memories.extend(original.into_iter().flatten());
            Ok(())
        }
        Err(_) if fallback && cancel.check().is_ok() => {
            if result.degraded.is_none() {
                result.degraded = Some(
                    json!({"reason":"reranker-unavailable","capability":"recall",
                    "detail":"rank fusion used after reranker failure"}),
                );
            }
            Ok(())
        }
        Err(_) => Err(NamespaceError::Finalise(EngineError::NotAvailable {
            reason: "rerank".to_owned(),
        })),
    }
}

fn reordered_indices(
    ranking: &[crate::contract::RerankHit],
    len: usize,
) -> Result<Vec<usize>, RerankError> {
    let mut used = HashSet::new();
    let indices = ranking
        .iter()
        .filter_map(|item| {
            let index = serde_json::to_value(item).ok()?["index"].as_u64()?;
            let index = usize::try_from(index).ok()?;
            (index < len && used.insert(index)).then_some(index)
        })
        .collect::<Vec<_>>();
    if indices.is_empty() {
        Err(RerankError::InvalidResponse)
    } else {
        Ok(indices)
    }
}
