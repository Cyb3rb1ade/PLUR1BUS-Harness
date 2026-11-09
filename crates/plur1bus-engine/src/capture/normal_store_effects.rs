//! Frozen normal-store curation and knowledge proposals; no publication or authority is implied.
use super::*;
use crate::capture::{
    fact_quality::{explain_fact_quality, should_promote_memory},
    output_unicode::external,
};
use chrono::{SecondsFormat, TimeZone, Utc};

/// An outcome verified by the eventual caller-bound storage coordinator.
/// This pure description grants no authority to read a source, append a log or stage knowledge.
#[derive(Clone, Copy)]
pub enum StoreOutcome<'a> {
    /// A separately persisted primary row.
    Stored {
        /// Actual row ID.
        id: &'a str,
    },
    /// A completed durable merge; importance is the combined value, quality remains the input's.
    Merged {
        /// Replacement row ID.
        id: &'a str,
        /// Actual prepared replacement text.
        text: &'a str,
        /// Final combined importance.
        importance: f64,
        /// Original source ID.
        source_id: &'a str,
        /// Original provider reason, retained for retries.
        reason: &'a str,
    },
    /// An authorized exact duplicate; never proposes knowledge work.
    Duplicate {
        /// Existing row ID.
        id: &'a str,
        /// Finite native-distance score.
        score: f64,
    },
}
/// Pure Node projection. Text cuts preserve UTF-16, including a dangling surrogate until outward conversion.
pub struct StoreEffects {
    /// One ordered curation-log entry.
    pub curation: Json,
    /// Optional one-entry knowledge proposal, not the whole mutable pending queue.
    pub knowledge_pending: Option<Json>,
}
/// F3-safe outward fields. An adapter must still authorize and durably publish these proposals.
pub struct ExternalStoreEffects {
    /// Ordered outward JSON for an eventual append; excludes the trailing newline.
    pub curation_json: String,
    /// Curation entry with complete Unicode codepoints at the text cut.
    pub curation: serde_json::Value,
    /// Optional knowledge proposal; does not activate a job or bypass A1 policy.
    pub knowledge_pending: Option<serde_json::Value>,
}
impl StoreEffects {
    /// Apply the F3 outward cut only; preserve the pure form for Node comparison and identities.
    pub fn into_external(mut self) -> Result<ExternalStoreEffects, EngineError> {
        let Json::Object(fields) = &mut self.curation else {
            return Err(StoreError::InvalidInput.into());
        };
        let (_, Json::String(text)) = fields
            .iter_mut()
            .find(|(k, _)| k == &JsString::from("text"))
            .ok_or(StoreError::InvalidInput)?
        else {
            return Err(StoreError::InvalidInput.into());
        };
        *text = JsString::from(external(text));
        let curation_json = write_json(&self.curation);
        Ok(ExternalStoreEffects {
            curation: serde_json::from_str(&curation_json).map_err(|_| StoreError::InvalidInput)?,
            curation_json,
            knowledge_pending: self
                .knowledge_pending
                .map(|v| {
                    serde_json::from_str(&write_json(&v)).map_err(|_| StoreError::InvalidInput)
                })
                .transpose()?,
        })
    }
}
fn valid_id(id: &str) -> Result<(), EngineError> {
    if id.is_empty() || id.len() > 128 || id.chars().any(char::is_control) {
        return Err(StoreError::InvalidInput.into());
    }
    Ok(())
}
impl AssessedStore {
    /// Plan the pinned curation/promotion fields from original input quality and verified final outcome.
    /// This neither writes the log/queue nor resolves the separately scoped A1 importance policy.
    pub fn effects(
        &self,
        outcome: StoreOutcome<'_>,
        now_ms: i64,
        min_importance: f64,
        cancel: &Cancel,
    ) -> Result<StoreEffects, EngineError> {
        cancel.check()?;
        if now_ms < 0 || !min_importance.is_finite() || !(0. ..=1.).contains(&min_importance) {
            return Err(StoreError::InvalidInput.into());
        }
        let time = Utc
            .timestamp_millis_opt(now_ms)
            .single()
            .filter(|v| (0..=9999).contains(&chrono::Datelike::year(v)))
            .ok_or(StoreError::InvalidInput)?
            .to_rfc3339_opts(SecondsFormat::Millis, true);
        let (event, id, text, reason, related, importance) = match outcome {
            StoreOutcome::Stored { id } => (
                "memory.stored",
                id,
                self.text.as_str(),
                "stored".into(),
                Json::Null,
                Some(self.importance),
            ),
            StoreOutcome::Duplicate { id, score } => {
                if !score.is_finite() || !(0. ..=1.).contains(&score) {
                    return Err(StoreError::InvalidInput.into());
                }
                (
                    "memory.rejected_duplicate",
                    id,
                    self.text.as_str(),
                    format!("duplicate_score:{}", crate::text::number::fixed(score, 3)),
                    string(id),
                    None,
                )
            }
            StoreOutcome::Merged {
                id,
                text,
                importance,
                source_id,
                reason,
            } => {
                valid_id(source_id)?;
                if text.is_empty()
                    || text.len() > 1024 * 1024
                    || reason.len() > 1024 * 1024
                    || !importance.is_finite()
                    || !(0. ..=1.).contains(&importance)
                {
                    return Err(StoreError::InvalidInput.into());
                }
                (
                    "memory.merged",
                    id,
                    text,
                    format!("merged_with:{source_id} ({reason})"),
                    string(source_id),
                    Some(importance),
                )
            }
        };
        valid_id(id)?;
        let curation = object([
            ("event", string(event)),
            ("timestamp", string(&time)),
            ("agentId", string(&self.agent)),
            ("memoryId", string(id)),
            (
                "text",
                Json::String(JsString::from(text).utf16_slice(0, 200)),
            ),
            ("category", string(&self.category)),
            ("origin", string(&self.origin)),
            ("reason", string(&reason)),
            ("relatedId", related),
        ]);
        let quality = explain_fact_quality(&JsString::from(self.text.as_str()))?;
        let knowledge_pending = importance
            .filter(|value| {
                should_promote_memory(&self.category, *value, Some(&quality), min_importance)
            })
            .map(|value| {
                object([
                    ("key", string(&format!("{}:{id}", self.agent))),
                    ("sourceAgent", string(&self.agent)),
                    ("memoryId", string(id)),
                    ("queuedAt", string(&time)),
                    ("reason", string("schicht15-store-pending")),
                    ("category", string(&self.category)),
                    ("importance", n(value)),
                ])
            });
        bounded(&curation, cancel, &mut (0, 0))?;
        if let Some(value) = &knowledge_pending {
            bounded(value, cancel, &mut (0, 0))?;
        }
        cancel.check()?;
        Ok(StoreEffects {
            curation,
            knowledge_pending,
        })
    }
}
