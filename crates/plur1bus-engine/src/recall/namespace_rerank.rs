//! Single rerank after multi-identity fusion, including C1 scores and CP-5.5's opt-in.
//! A declared valid empty response is a successful selection, including after fusion.

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
        .and_then(|ranking| {
            validated_ranking(&ranking, docs.len(), reranker.empty_result_is_valid())
        });
    match ranking {
        Ok(order) => {
            reorder(result, order);
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

fn validated_ranking(
    ranking: &[crate::contract::RerankHit],
    len: usize,
    empty_valid: bool,
) -> Result<Vec<(usize, f64)>, RerankError> {
    let indices = super::finalise::valid_hits(ranking, len);
    if indices.is_empty() && !empty_valid {
        Err(RerankError::InvalidResponse)
    } else {
        Ok(indices)
    }
}

fn reorder(result: &mut NamespaceResult, order: Vec<(usize, f64)>) {
    if order.is_empty() {
        result.memories.clear();
        return;
    }
    let mut original = std::mem::take(&mut result.memories)
        .into_iter()
        .map(Some)
        .collect::<Vec<_>>();
    let mut ceiling = f64::INFINITY;
    result.memories = order
        .into_iter()
        .filter_map(|(index, score)| {
            ceiling = ceiling.min(score);
            let mut item = original[index].take()?;
            item["rerankScore"] = json!(ceiling);
            Some(item)
        })
        .collect();
    result.memories.extend(original.into_iter().flatten());
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use crate::contract::RerankHit;
    use crate::recall::namespace_budget::{self, MergedBudget};

    struct OutOfOrder;
    impl Reranker for OutOfOrder {
        fn rerank(
            &self,
            _: &str,
            _: &[String],
            _: usize,
            _: &Cancel,
        ) -> Result<Vec<RerankHit>, RerankError> {
            Ok(serde_json::from_value(json!([
                {"index":2.0,"score":0.3}, {"index":1,"score":0.9},
                {"index":2,"score":0.1}, {"index":10,"score":1.0}
            ]))
            .unwrap())
        }
        fn empty_result_is_valid(&self) -> bool {
            false
        }
    }

    #[test]
    fn fused_verdict_survives_bad_scores_duplicate_indices_and_budgeting() {
        let mut result = NamespaceResult {
            memories: (0..4).map(|index| json!({
                "entry":{"id":index.to_string(),"text":"synthetic evidence","category":"general"},
                "score":(4-index) as f64,"source":"vector"
            })).collect(),
            ..NamespaceResult::default()
        };
        apply(&mut result, "fixture", &OutOfOrder, &Cancel::never(), false).unwrap();
        assert_eq!(
            result
                .memories
                .iter()
                .map(|item| item["entry"]["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["2", "1", "0", "3"]
        );
        assert_eq!(result.memories[0]["rerankScore"], json!(0.3));
        assert_eq!(result.memories[1]["rerankScore"], json!(0.3));
        assert!(result.memories[2].get("rerankScore").is_none());
        namespace_budget::apply(
            &mut result,
            MergedBudget {
                enabled: true,
                limit: 2.0,
            },
        );
        assert_eq!(
            result
                .memories
                .iter()
                .map(|item| item["entry"]["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["2", "1"]
        );
    }
}
