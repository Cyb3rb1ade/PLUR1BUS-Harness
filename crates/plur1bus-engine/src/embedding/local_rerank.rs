//! Pinned local BGE and jina sequence-classification reranking.

use super::artifacts::pinned_profile;
use super::local_ort::{
    cached_preparation, infer, requires_nc, LocalModelError, MediaInputs, PreparedCache,
};
use super::{Cancel, RerankError, RerankHit, Reranker};
use crate::contract::EngineError;
use crate::text::js::js_trim;
use serde_json::{Number, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// A lazy pinned local reranker; the model remains a host-owned cache artifact.
pub struct LocalReranker {
    profile: &'static super::artifacts::Artifact,
    cache_dir: PathBuf,
    prepared: PreparedCache,
}

// Node's stripEmpty removes only entirely blank strings; nonblank values stay byte-identical.
fn strip_empty(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| !value.as_str().is_some_and(|text| js_trim(text).is_empty()))
}

/// Build the flat local block passed by the Node reranker factory.
pub fn build_local_reranker(
    raw: &Value,
    cache_dir: &Path,
    accept_nc: bool,
) -> Result<Box<dyn Reranker>, EngineError> {
    let invalid = || EngineError::Invalid {
        field: "reranker.local".into(),
        message: "invalid pinned local reranker settings".into(),
    };
    let model = raw
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("woxpas-ai/bge-reranker-v2-m3-onnx");
    let profile = pinned_profile(model, None)
        .filter(|p| p.role == "reranker")
        .ok_or_else(invalid)?;
    if requires_nc(profile) && !accept_nc {
        return Err(EngineError::NotAvailable {
            reason: "noncommercial-licence-not-accepted".into(),
        });
    }
    if strip_empty(raw.get("revision"))
        .and_then(Value::as_str)
        .is_some_and(|v| v != profile.revision)
        || strip_empty(raw.get("dtype"))
            .filter(|v| !v.is_null())
            .is_some_and(|v| v.as_str() != Some("q8"))
    {
        return Err(invalid());
    }
    Ok(Box::new(LocalReranker {
        profile,
        cache_dir: cache_dir.to_owned(),
        prepared: Mutex::new(None),
    }))
}

fn failure(error: &LocalModelError) -> RerankError {
    match error {
        LocalModelError::Cancelled(reason) => RerankError::Cancelled(*reason),
        LocalModelError::InvalidTensor => RerankError::InvalidResponse,
        _ => RerankError::Unavailable,
    }
}
fn sigmoid(value: f32) -> f64 {
    let value = f64::from(value);
    if value >= 0.0 {
        1.0 / (1.0 + (-value).exp())
    } else {
        let exp = value.exp();
        exp / (1.0 + exp)
    }
}

fn score_hits(logits: &[f32], top_n: usize) -> Result<Vec<RerankHit>, RerankError> {
    if logits.iter().any(|score| !score.is_finite()) {
        return Err(RerankError::InvalidResponse);
    }
    let mut scores = logits
        .iter()
        .enumerate()
        .map(|(index, score)| (index, sigmoid(*score)))
        .collect::<Vec<_>>();
    scores.sort_by(|left, right| {
        right
            .1
            .total_cmp(&left.1)
            .then_with(|| left.0.cmp(&right.0))
    });
    scores.truncate(top_n);
    scores
        .into_iter()
        .map(|(index, score)| {
            Ok(RerankHit {
                index: Number::from(index),
                score: Number::from_f64(score).ok_or(RerankError::InvalidResponse)?,
            })
        })
        .collect()
}

impl Reranker for LocalReranker {
    fn rerank(
        &self,
        query: &str,
        docs: &[String],
        top_n: usize,
        cancel: &Cancel,
    ) -> Result<Vec<RerankHit>, RerankError> {
        cancel.check().map_err(RerankError::Cancelled)?;
        if docs.is_empty() {
            return Ok(vec![]);
        }
        let prepared =
            cached_preparation(&self.prepared, self.profile, &self.cache_dir, None, cancel)
                .map_err(|error| failure(&error))?;
        let queries = vec![query.to_owned(); docs.len()];
        let batch = prepared
            .tokenizer
            .encode_batch(&queries, Some(docs))
            .map_err(|error| failure(&error))?;
        let outputs = infer(
            self.profile,
            &prepared,
            &batch,
            None,
            &MediaInputs::default(),
            cancel,
        )
        .map_err(|error| failure(&error))?;
        let (shape, scores) = outputs.get("logits").ok_or(RerankError::InvalidResponse)?;
        if shape != &[docs.len(), 1] || scores.len() != docs.len() {
            return Err(RerankError::InvalidResponse);
        }
        let hits = score_hits(scores, top_n)?;
        cancel.check().map_err(RerankError::Cancelled)?;
        Ok(hits)
    }
    fn empty_result_is_valid(&self) -> bool {
        false
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn score_hits_orders_multiple_documents_stably_and_keeps_original_indices() {
        let hits = score_hits(&[-2.0, 2.0, 2.0, 0.0], 3).unwrap();
        let indices = hits
            .iter()
            .map(|hit| hit.index.as_u64().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(indices, [1, 2, 3]);
        let scores = hits
            .iter()
            .map(|hit| hit.score.as_f64().unwrap())
            .collect::<Vec<_>>();
        assert!((scores[0] - 0.880_797_077_977_882_3).abs() < 1e-15);
        assert_eq!(scores[0], scores[1]);
        assert_eq!(scores[2], 0.5);
        let all = score_hits(&[-2.0, 2.0, 2.0, 0.0], 99).unwrap();
        assert_eq!(all.len(), 4);
        assert_eq!(all[3].index.as_u64(), Some(0));
        assert!((all[3].score.as_f64().unwrap() - 0.119_202_922_022_117_55).abs() < 1e-15);
    }

    #[test]
    fn score_hits_handles_zero_limit_empty_input_and_extreme_finite_logits() {
        assert!(score_hits(&[1.0, 2.0, 3.0], 0).unwrap().is_empty());
        assert!(score_hits(&[], 3).unwrap().is_empty());
        let hits = score_hits(&[-f32::MAX, 0.0, f32::MAX], 3).unwrap();
        assert_eq!(
            hits.iter()
                .map(|hit| hit.index.as_u64().unwrap())
                .collect::<Vec<_>>(),
            [2, 1, 0]
        );
        assert_eq!(
            hits.iter()
                .map(|hit| hit.score.as_f64().unwrap())
                .collect::<Vec<_>>(),
            [1.0, 0.5, 0.0]
        );
        for invalid in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            assert!(matches!(
                score_hits(&[0.0, invalid, 1.0], 2),
                Err(RerankError::InvalidResponse)
            ));
        }
    }

    #[test]
    fn nullish_and_js_blank_reranker_options_use_the_pinned_defaults() {
        for options in [
            json!({}),
            json!({"revision":null,"dtype":null}),
            json!({"revision":"","dtype":""}),
            json!({"revision":" \t\n","dtype":"\r "}),
            json!({"revision":"\u{feff}","dtype":"\u{feff}"}),
            json!({"revision":"c44ebc43de724ae8816668bb44d2e728e17faa18","dtype":"q8"}),
        ] {
            assert!(
                build_local_reranker(&options, Path::new("/missing-model-cache"), false).is_ok(),
                "Node accepts these defaulted reranker options: {options}"
            );
        }
    }

    #[test]
    fn nonblank_reranker_options_are_checked_without_trimming_their_values() {
        for options in [
            json!({"revision":"wrong"}),
            json!({"revision":" c44ebc43de724ae8816668bb44d2e728e17faa18"}),
            json!({"dtype":"q8 "}),
            json!({"dtype":"q4"}),
            json!({"dtype":"fp32"}),
            json!({"dtype":"\u{0085}"}),
        ] {
            assert!(
                build_local_reranker(&options, Path::new("/missing-model-cache"), false).is_err(),
                "Node stripEmpty preserves this nonblank value for validation: {options}"
            );
        }
    }
}
