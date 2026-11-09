//! Private normal-store assessment and merge rows. Pure preparation grants no source authority.
//! Validity inputs here are already canonical millisecond numbers; front-door date parsing is separate.
use super::{
    categorize::{categorize_memory_with_reason, MEMORY_ORIGINS},
    durable_merge,
    emotion_json::{get, object, string},
    fact_quality::{compute_memory_importance, number_json},
    interference::bounded,
    merge_decision, merge_safety,
};
use crate::{
    context::{is_user_principal, safe_agent_id},
    contract::{Cancel, EngineError, MemoryRow, StoreError},
    ops::memory_guards,
    text::{
        js::JsString,
        json::{parse_json, write_json, TolerantJsonValue as Json},
        legacy::text_utils::generate_summary,
    },
};
/// Original ownership supplied by a caller-bound adapter, not accepted as a wire credential.
#[derive(Clone, Copy)]
pub struct StoreOwner<'a> {
    /// Current canonical agent.
    pub agent_id: &'a str,
    /// Current canonical user principal.
    pub owner_user_id: &'a str,
    /// Current bound workspace identity, retained even on private rows.
    pub workspace_key: &'a str,
}
/// Validated host encoding settings; no provider or mutable store is held here.
pub struct StoreEncoding {
    /// Maximum words in deterministic summaries.
    pub summary_max_words: usize,
    /// Existing category/class half-life rules.
    pub half_life_overrides: Json,
    /// Explicit flashbulb switch.
    pub flashbulb: bool,
}
impl Default for StoreEncoding {
    fn default() -> Self {
        Self {
            summary_max_words: 150,
            half_life_overrides: object(Vec::<(&str, Json)>::new()),
            flashbulb: false,
        }
    }
}
/// Assessed immutable input. Ownership/key/time cannot be replaced after assessment.
pub struct AssessedStore {
    text: String,
    category: String,
    origin: String,
    importance: f64,
    expires_at: i64,
    agent: String,
    owner: String,
    workspace: String,
    source_url: JsString,
    evidence: JsString,
    valid_from: u64,
    valid_until: u64,
    key: JsString,
}
/// Source and provider outputs captured by the authorized adapter.
#[derive(Clone, Copy)]
pub struct MergeMaterial<'a> {
    /// Exact current source snapshot, revalidated around providers by the adapter.
    pub source: &'a MemoryRow,
    /// Parsed merge-decision object, including reason.
    pub decision: &'a Json,
    /// Actual provider vector; pure projection preserves its original numeric representation.
    pub vector: &'a Json,
    /// One host time after preparation, retained for retries.
    pub now_ms: i64,
}
/// Exact prepared row protocol, with Node cuts retained until the typed store boundary.
pub struct PreparedStoreRow {
    /// Ordered normal-store fields and dynamics, before filling the declared schema defaults.
    pub entry: Json,
    /// Original owner-bound key, including raw Node UTF-16 provenance cuts.
    pub write_key: JsString,
}
/// Backward-compatible name for a provider-approved merged preparation.
pub type PreparedMerge = PreparedStoreRow;
fn timestamp(value: &Json) -> Result<u64, EngineError> {
    match value {
        Json::Null => Ok(0),
        Json::Number(v) => {
            let n = v.parse::<f64>().map_err(|_| StoreError::InvalidInput)?;
            if !n.is_finite() || n < 0. || n.fract() != 0. || n > 9_007_199_254_740_991. {
                return Err(StoreError::InvalidInput.into());
            }
            Ok(n as u64)
        }
        _ => Err(StoreError::InvalidInput.into()),
    }
}
fn n(value: f64) -> Json {
    Json::Number(number_json(value))
}
fn cut(value: &Json, max: usize) -> JsString {
    match value {
        Json::String(v) => v.utf16_slice(0, max),
        _ => JsString::from(""),
    }
}
/// Assess canonical private-store parameters before providers, including the existing C7 TTL guard.
pub fn assess(
    params: &Json,
    owner: StoreOwner<'_>,
    now: i64,
    cancel: &Cancel,
) -> Result<AssessedStore, EngineError> {
    bounded(params, cancel, &mut (0, 0))?;
    memory_guards::validate_store(params).map_err(|_| StoreError::InvalidInput)?;
    safe_agent_id(owner.agent_id).map_err(|_| StoreError::InvalidInput)?;
    if !is_user_principal(owner.owner_user_id)
        || owner.workspace_key.is_empty()
        || owner.workspace_key.len() > 4096
        || now.unsigned_abs() > 9_007_199_254_740_991
    {
        return Err(StoreError::InvalidInput.into());
    }
    if !matches!(get(params, "scope"), Json::Null)
        && get(params, "scope") != &string("agent-private")
    {
        return Err(StoreError::InvalidInput.into());
    }
    let Json::String(raw_text) = get(params, "text") else {
        return Err(StoreError::InvalidInput.into());
    };
    let text =
        String::from_utf16(raw_text.as_utf16_units()).map_err(|_| StoreError::InvalidInput)?;
    let (category, reason) = match get(params, "category") {
        Json::String(v) if !v.is_empty() => (v.to_utf8_lossy(), "caller-provided"),
        _ => {
            let category = categorize_memory_with_reason(raw_text)?;
            (category.category.to_owned(), category.reason)
        }
    };
    let origin = match get(params, "origin") {
        Json::String(v) if MEMORY_ORIGINS.contains(&v.to_utf8_lossy().as_str()) => {
            v.to_utf8_lossy()
        }
        _ => "dm".into(),
    };
    let explicit = match get(params, "importance") {
        Json::Null => None,
        Json::Number(v) => Some(v.parse::<f64>().map_err(|_| StoreError::InvalidInput)?),
        _ => return Err(StoreError::InvalidInput.into()),
    };
    if explicit.is_some_and(|v| !v.is_finite()) {
        return Err(StoreError::InvalidInput.into());
    }
    let importance =
        compute_memory_importance(raw_text, Some(&JsString::from(reason)), explicit)?.importance;
    let ttl = match get(params, "ttl") {
        Json::String(v) if v == &JsString::from("session") => "session",
        Json::String(v) if v == &JsString::from("short") => "short",
        _ => "",
    };
    let ttl_ms = match ttl {
        "session" => 86_400_000.,
        "short" => 14. * 86_400_000.,
        _ => 0.,
    };
    let expiry = memory_guards::store_expiry(now as f64, ttl_ms, importance)
        .map_err(|_| StoreError::InvalidInput)?;
    if expiry.abs() > 9_007_199_254_740_991. {
        return Err(StoreError::InvalidInput.into());
    }
    let source_url = cut(get(params, "sourceUrl"), 500);
    let evidence = cut(get(params, "evidenceQuote"), 200);
    let valid_from = timestamp(get(params, "validFrom"))?;
    let valid_until = timestamp(get(params, "validUntil"))?;
    if valid_from > 0 && valid_until > 0 && valid_until <= valid_from {
        return Err(StoreError::InvalidInput.into());
    }
    let key = durable_merge::write_key(
        &object([
            ("workspaceKey", string(owner.workspace_key)),
            ("text", string(&text)),
            ("category", string(&category)),
            ("origin", string(&origin)),
            ("importance", n(importance)),
            ("ttl", string(ttl)),
            ("sourceUrl", Json::String(source_url.clone())),
            ("evidenceQuote", Json::String(evidence.clone())),
            ("scope", string("agent-private")),
            ("ownerUserId", string(owner.owner_user_id)),
            ("validFrom", n(valid_from as f64)),
            ("validUntil", n(valid_until as f64)),
        ]),
        cancel,
    )?;
    Ok(AssessedStore {
        text,
        category,
        origin,
        importance,
        expires_at: expiry as i64,
        agent: owner.agent_id.into(),
        owner: owner.owner_user_id.into(),
        workspace: owner.workspace_key.into(),
        source_url,
        evidence,
        valid_from,
        valid_until,
        key,
    })
}
impl AssessedStore {
    /// Original incoming text for the caller-bound model request.
    pub fn text(&self) -> &str {
        &self.text
    }
    /// Assessed category, independent of the old source category.
    pub fn category(&self) -> &str {
        &self.category
    }
    /// Exact incoming importance before combining with the source.
    pub fn importance(&self) -> Json {
        n(self.importance)
    }
    /// Original key; never reconstruct it from outward Unicode-projected fields.
    pub fn write_key(&self) -> &JsString {
        &self.key
    }
    /// Construct an ordinary unattributed new row from the original operation ID/vector/time.
    /// Does not infer trust, authorize storage or repeat any embedding. Publication must freeze it.
    pub fn ordinary(
        &self,
        id: &uuid::Uuid,
        vector: &Json,
        now: i64,
        encoding: &StoreEncoding,
        cancel: &Cancel,
    ) -> Result<PreparedStoreRow, EngineError> {
        cancel.check()?;
        if id.is_nil()
            || now.unsigned_abs() > 9_007_199_254_740_991
            || encoding.summary_max_words == 0
            || encoding.summary_max_words > 10000
        {
            return Err(StoreError::InvalidInput.into());
        }
        bounded(vector, cancel, &mut (0, 0))?;
        bounded(&encoding.half_life_overrides, cancel, &mut (0, 0))?;
        let Json::Array(values) = vector else {
            return Err(StoreError::InvalidInput.into());
        };
        if values.is_empty()
            || values.len() > 32768
            || values
                .iter()
                .any(|v| !matches!(v,Json::Number(s) if s.parse::<f64>().is_ok_and(f64::is_finite)))
        {
            return Err(StoreError::InvalidInput.into());
        }
        let status = super::epistemic::decide_capture_status(
            &JsString::from(self.text.as_str()),
            "",
            &self.origin,
            true,
        )?;
        let row = object([
            ("id", string(&id.to_string())),
            ("text", string(&self.text)),
            (
                "summary",
                string(&generate_summary(&self.text, encoding.summary_max_words)),
            ),
            ("origin", string(&self.origin)),
            ("vector", vector.clone()),
            ("importance", n(self.importance)),
            ("category", string(&self.category)),
            ("createdAt", n(now as f64)),
            ("mergedFrom", string("[]")),
            ("expiresAt", n(self.expires_at as f64)),
            ("agentId", string(&self.agent)),
            ("storedBy", string(&self.agent)),
            ("workspaceId", string(&self.workspace)),
            ("workspaceKey", string(&self.workspace)),
            ("ownerUserId", string(&self.owner)),
            ("sourceTurnId", string("")),
            ("sourceMessageRole", string("")),
            ("sourceTimestamp", n(now as f64)),
            ("sourceUrl", Json::String(self.source_url.clone())),
            ("evidenceQuote", Json::String(self.evidence.clone())),
            ("scope", string("agent-private")),
            ("validFrom", n(self.valid_from as f64)),
            ("validUntil", n(self.valid_until as f64)),
            ("epistemicStatus", string(status)),
        ]);
        let entry = super::dynamics::apply_dynamics_defaults(
            &row,
            now as f64,
            &encoding.half_life_overrides,
            &object([("flashbulbEncodingEnabled", Json::Bool(encoding.flashbulb))]),
        );
        cancel.check()?;
        Ok(PreparedStoreRow {
            entry,
            write_key: self.key.clone(),
        })
    }
    /// Lexical guard to run before any provider call. It does not authorize access to the source.
    pub fn compatible(&self, source: &MemoryRow) -> Result<bool, EngineError> {
        if source.text.len() > 1_048_576 {
            return Err(StoreError::InvalidInput.into());
        }
        Ok(!merge_safety::meaningful_difference(
            &JsString::from(source.text.as_str()),
            &JsString::from(self.text.as_str()),
        )?)
    }
    /// Validate source binding, lexical decision and validity before any merged-text embedding.
    /// The caller must still authorize and reread the actual source around provider work.
    pub fn checked_text(
        &self,
        source: &MemoryRow,
        decision: &Json,
        cancel: &Cancel,
    ) -> Result<Option<String>, EngineError> {
        cancel.check()?;
        if source.agent_id != self.agent
            || source.stored_by != self.agent
            || source.owner_user_id != self.owner
            || source.workspace_key != self.workspace
            || source.scope != "agent-private"
            || source.status != "active"
            || source.text.len() > 1_048_576
        {
            return Err(StoreError::InvalidInput.into());
        }
        bounded(decision, cancel, &mut (0, 0))?;
        if !self.compatible(source)? {
            return Ok(None);
        }
        let Some(decision) = merge_decision::parse_response(&write_json(decision), cancel)? else {
            return Ok(None);
        };
        if get(&decision, "merge") != &Json::Bool(true) {
            return Ok(None);
        }
        let Json::String(merged) = get(&decision, "mergedText") else {
            return Ok(None);
        };
        if merged.is_empty()
            || merged.utf16_len()
                <= source
                    .text
                    .encode_utf16()
                    .count()
                    .min(self.text.encode_utf16().count())
            || !merge_safety::preserves_facts(
                &JsString::from(source.text.as_str()),
                &JsString::from(self.text.as_str()),
                merged,
            )?
        {
            return Ok(None);
        }
        let merged_text =
            String::from_utf16(merged.as_utf16_units()).map_err(|_| StoreError::InvalidInput)?;
        if merged_text.len() > 1_048_576 {
            return Err(StoreError::InvalidInput.into());
        }
        let raw = parse_json(&serde_json::to_string(source).map_err(|_| StoreError::InvalidInput)?)
            .map_err(|_| StoreError::InvalidInput)?;
        let from = timestamp(get(&raw, "validFrom"))?;
        let until = timestamp(get(&raw, "validUntil"))?;
        if (until > 0 && self.valid_from > 0 && until <= self.valid_from)
            || (self.valid_until > 0 && from > 0 && self.valid_until <= from)
        {
            return Ok(None);
        }
        Ok(Some(merged_text))
    }
    /// Materialize a provider-approved merge only when all lexical/length/validity guards hold.
    pub fn merge(
        &self,
        m: MergeMaterial<'_>,
        encoding: &StoreEncoding,
        cancel: &Cancel,
    ) -> Result<Option<PreparedMerge>, EngineError> {
        cancel.check()?;
        let source = m.source;
        if m.now_ms.unsigned_abs() > 9_007_199_254_740_991
            || encoding.summary_max_words == 0
            || encoding.summary_max_words > 10000
        {
            return Err(StoreError::InvalidInput.into());
        }
        bounded(&encoding.half_life_overrides, cancel, &mut (0, 0))?;
        bounded(m.vector, cancel, &mut (0, 0))?;
        let Some(merged_text) = self.checked_text(source, m.decision, cancel)? else {
            return Ok(None);
        };
        let merged = JsString::from(merged_text.as_str());
        let Json::Array(vector) = m.vector else {
            return Err(StoreError::InvalidInput.into());
        };
        if vector.is_empty()
            || vector.len() > 32768
            || vector
                .iter()
                .any(|v| !matches!(v,Json::Number(s) if s.parse::<f64>().is_ok_and(f64::is_finite)))
        {
            return Err(StoreError::InvalidInput.into());
        }
        let raw = parse_json(&serde_json::to_string(source).map_err(|_| StoreError::InvalidInput)?)
            .map_err(|_| StoreError::InvalidInput)?;
        let from = timestamp(get(&raw, "validFrom"))?;
        let until = timestamp(get(&raw, "validUntil"))?;
        if (until > 0 && self.valid_from > 0 && until <= self.valid_from)
            || (self.valid_until > 0 && from > 0 && self.valid_until <= from)
        {
            return Ok(None);
        }
        let merged_from = if from > 0 && self.valid_from > 0 {
            from.min(self.valid_from)
        } else {
            0
        };
        let merged_until = if until > 0 && self.valid_until > 0 {
            until.max(self.valid_until)
        } else {
            0
        };
        let importance = source
            .importance
            .as_f64()
            .filter(|v| v.is_finite())
            .ok_or(StoreError::InvalidInput)?
            .max(self.importance);
        let id = durable_merge::identity(&self.agent, &source.id, &self.key, cancel)?;
        let mut fields = vec![
            ("id".into(), string(&id.replacement_id)),
            ("text".into(), Json::String(merged.clone())),
            (
                "summary".into(),
                string(&generate_summary(&merged_text, encoding.summary_max_words)),
            ),
            ("origin".into(), string(&self.origin)),
            ("vector".into(), m.vector.clone()),
            ("importance".into(), n(importance)),
            ("category".into(), string(&self.category)),
            ("createdAt".into(), n(m.now_ms as f64)),
            (
                "mergedFrom".into(),
                string(&write_json(&durable_merge::lineage(&raw, cancel)?)),
            ),
            ("expiresAt".into(), n(self.expires_at as f64)),
            ("agentId".into(), string(&self.agent)),
            ("storedBy".into(), string(&self.agent)),
            ("workspaceId".into(), string(&self.workspace)),
            ("workspaceKey".into(), string(&self.workspace)),
            ("ownerUserId".into(), string(&self.owner)),
        ];
        let Json::Object(metadata) = durable_merge::epistemic_metadata(&raw, m.now_ms, cancel)?
        else {
            return Err(StoreError::Corrupt.into());
        };
        fields.extend(metadata);
        fields.extend([
            ("sourceTurnId".into(), string("")),
            ("sourceMessageRole".into(), string("")),
            ("sourceTimestamp".into(), n(m.now_ms as f64)),
            ("sourceUrl".into(), Json::String(self.source_url.clone())),
            ("evidenceQuote".into(), Json::String(self.evidence.clone())),
            ("scope".into(), string("agent-private")),
            ("validFrom".into(), n(merged_from as f64)),
            ("validUntil".into(), n(merged_until as f64)),
        ]);
        let entry = super::dynamics::apply_dynamics_defaults(
            &Json::Object(fields),
            m.now_ms as f64,
            &encoding.half_life_overrides,
            &object([("flashbulbEncodingEnabled", Json::Bool(encoding.flashbulb))]),
        );
        cancel.check()?;
        Ok(Some(PreparedMerge {
            entry,
            write_key: self.key.clone(),
        }))
    }
}
impl PreparedStoreRow {
    /// Fill fixed schema defaults; external provenance cuts drop only unpaired UTF-16 units (F3).
    /// Provider text is never silently repaired, and neither this conversion nor the key grants authority.
    pub fn into_row(mut self) -> Result<MemoryRow, EngineError> {
        let Json::Object(fields) = &mut self.entry else {
            return Err(StoreError::InvalidInput.into());
        };
        for (name, value) in fields.iter_mut() {
            if (name == &JsString::from("sourceUrl") || name == &JsString::from("evidenceQuote"))
                && matches!(value, Json::String(_))
            {
                if let Json::String(text) = value {
                    *text = JsString::from(super::output_unicode::external(text));
                }
            }
        }
        let extra: serde_json::Value =
            serde_json::from_str(&write_json(&self.entry)).map_err(|_| StoreError::InvalidInput)?;
        let mut defaults = serde_json::to_value(super::row_defaults::schema_defaults(vec![]))
            .map_err(|_| StoreError::Corrupt)?;
        defaults
            .as_object_mut()
            .ok_or(StoreError::Corrupt)?
            .extend(extra.as_object().ok_or(StoreError::InvalidInput)?.clone());
        let row: MemoryRow =
            serde_json::from_value(defaults).map_err(|_| StoreError::InvalidInput)?;
        if row.vector.is_empty()
            || row.vector.len() > 32768
            || row.vector.iter().any(|v| !v.is_finite())
        {
            return Err(StoreError::InvalidInput.into());
        }
        Ok(row)
    }
}
