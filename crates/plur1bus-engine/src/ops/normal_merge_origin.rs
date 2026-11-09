//! Frozen normal-merge origin, retained before destructive primary work and checked without providers.
use super::*;
use crate::capture::normal_store::{AssessedStore, StoreOutcome};
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::ops::durable_merge) struct NormalMergeOrigin {
    version: u8,
    params: String,
    assessed_at: i64,
    decision: String,
    config_hash: String,
    workspace: (PathBuf, (u64, u64)),
    registry: (PathBuf, (u64, u64)),
}
fn binding(dir: &TrustedDirectory) -> (PathBuf, (u64, u64)) {
    (dir.path().to_owned(), dir.identity_parts())
}
fn digest(value: &Value) -> Result<String, EngineError> {
    Ok(hash(
        &serde_json::to_vec(value).map_err(|_| StoreError::Corrupt)?,
    ))
}
impl NormalMergeOrigin {
    pub(in crate::ops::durable_merge) fn prepare(
        params: &Json,
        assessed_at: i64,
        decision: &Json,
        config: &Value,
        workspace: &TrustedDirectory,
        registry: &TrustedDirectory,
    ) -> Result<Self, EngineError> {
        Ok(Self {
            version: 1,
            params: write_json(params),
            assessed_at,
            decision: write_json(decision),
            config_hash: digest(config)?,
            workspace: binding(workspace),
            registry: binding(registry),
        })
    }
    fn assess(&self, ctx: &RequestContext, cancel: &Cancel) -> Result<AssessedStore, EngineError> {
        let params = parse_json(&self.params).map_err(|_| StoreError::Corrupt)?;
        assess(
            &params,
            StoreOwner {
                agent_id: ctx.agent_id.as_str(),
                owner_user_id: &ctx.owner_user_id,
                workspace_key: &ctx.workspace_key,
            },
            self.assessed_at,
            cancel,
        )
    }
    fn decision(&self, cancel: &Cancel) -> Result<Json, EngineError> {
        merge_decision::parse_response(&self.decision, cancel)?
            .ok_or_else(|| StoreError::Corrupt.into())
    }
    fn reason(&self, cancel: &Cancel) -> Result<String, EngineError> {
        let Json::Object(fields) = self.decision(cancel)? else {
            return Err(StoreError::Corrupt.into());
        };
        let Some((_, Json::String(reason))) =
            fields.iter().find(|(k, _)| k == &JsString::from("reason"))
        else {
            return Err(StoreError::Corrupt.into());
        };
        // The pinned decision parser already requires a string. Never replace invalid UTF-16 with invented text.
        String::from_utf16(reason.as_utf16_units()).map_err(|_| StoreError::InvalidInput.into())
    }
    pub(in crate::ops::durable_merge) fn validate(
        &self,
        request: &MergeRequest,
        ctx: &RequestContext,
        config: &Value,
        dirs: (&TrustedDirectory, &TrustedDirectory),
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        if self.version != 1
            || self.config_hash != digest(config)?
            || self.workspace != binding(dirs.0)
            || self.registry != binding(dirs.1)
        {
            return Err(StoreError::InvalidInput.into());
        }
        let cfg = crate::config::effective_config(config).map_err(|_| StoreError::InvalidInput)?;
        let encoding = StoreEncoding {
            summary_max_words: cfg["summaryMaxWords"]
                .as_u64()
                .unwrap_or(150)
                .try_into()
                .map_err(|_| StoreError::InvalidInput)?,
            half_life_overrides: parse_json(&cfg["recall"]["halfLifeDaysMap"].to_string())
                .map_err(|_| StoreError::InvalidInput)?,
            flashbulb: cfg["memoryDynamics"]["flashbulbEncoding"] == true,
        };
        let vector = parse_json(
            &serde_json::to_string(&request.replacement.vector).map_err(|_| StoreError::Corrupt)?,
        )
        .map_err(|_| StoreError::Corrupt)?;
        let decision = self.decision(cancel)?;
        let expected = self
            .assess(ctx, cancel)?
            .merge(
                MergeMaterial {
                    source: &request.source.row,
                    decision: &decision,
                    vector: &vector,
                    now_ms: request.now_ms,
                },
                &encoding,
                cancel,
            )?
            .ok_or(StoreError::Corrupt)?;
        if String::from_utf16(expected.write_key.as_utf16_units())
            .map_err(|_| StoreError::InvalidInput)?
            != request.write_key
        {
            return Err(StoreError::Corrupt.into());
        }
        let expected = Record {
            row: crate::store::row::persisted_projection(&expected.into_row()?)?,
            sharing: None,
        };
        if !expected.same(&MemoryRecord {
            row: crate::store::row::persisted_projection(&request.replacement)?,
            sharing: None,
        })? {
            return Err(StoreError::Corrupt.into());
        }
        self.event(request, ctx, config, request.now_ms, cancel)?;
        cancel.check()?;
        Ok(())
    }
    pub(in crate::ops::durable_merge) fn event(
        &self,
        request: &MergeRequest,
        ctx: &RequestContext,
        config: &Value,
        now_ms: i64,
        cancel: &Cancel,
    ) -> Result<String, EngineError> {
        let cfg = crate::config::effective_config(config).map_err(|_| StoreError::InvalidInput)?;
        let row = serde_json::to_value(&request.replacement).map_err(|_| StoreError::Corrupt)?;
        let reason = self.reason(cancel)?;
        Ok(self
            .assess(ctx, cancel)?
            .effects(
                StoreOutcome::Merged {
                    id: &request.replacement.id,
                    text: &request.replacement.text,
                    importance: row["importance"].as_f64().ok_or(StoreError::Corrupt)?,
                    source_id: &request.source.row.id,
                    reason: &reason,
                },
                now_ms,
                cfg["schicht15"]["minImportance"].as_f64().unwrap_or(0.7),
                cancel,
            )?
            .into_external()?
            .curation_json)
    }
}
