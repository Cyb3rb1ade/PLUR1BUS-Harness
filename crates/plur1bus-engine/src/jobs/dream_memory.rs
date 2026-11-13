//! Replay-safe publication of one low-weight, exact-owner dream memory.
use super::{authority::JobAuthority, content_guard, lance_scope::LanceScope};
use crate::{
    capture::row_defaults::schema_defaults,
    contract::{Cancel, EmbedKind, EngineError, JobName, MemoryRow, StoreError},
    embedding::{batch::validate_vectors, EmbeddingProvider},
    neo::acl::Visibility,
    recall::{acl, tombstone_mask::TombstoneMask},
    store::{tombstone::assert_card_write_allowed, Store},
    text::js::utf16_slice,
};
use serde_json::{Number, Value};
use sha2::{Digest, Sha256};
use std::{path::PathBuf, sync::Arc};

pub(crate) struct DreamMemory {
    pub(crate) base: PathBuf,
    pub(crate) provider: Arc<dyn EmbeddingProvider>,
}

impl DreamMemory {
    pub(super) fn publish(
        &self,
        scope: &LanceScope,
        authority: &JobAuthority,
        visibility: &Visibility,
        record: &Value,
        cancel: &Cancel,
        check: &dyn Fn() -> Result<(), EngineError>,
    ) -> Result<bool, EngineError> {
        let ctx = authority.request();
        let (mode, max_chars) = match authority.job() {
            JobName::LightDream => ("light", 1200),
            JobName::RemDream => ("rem", 3000),
            _ => return Err(super::authority::unbound()),
        };
        if visibility.scope != "agent_private"
            || visibility.agent_id != ctx.agent_id.as_str()
            || visibility.workspace_identity != ctx.workspace_key
            || visibility.owner_user_id != ctx.owner_user_id
            || record["agentId"] != visibility.agent_id
            || record["ownerUserId"] != visibility.owner_user_id
            || record["workspaceKey"] != visibility.workspace_identity
            || record["scope"] != visibility.scope
        {
            return Err(super::authority::unbound());
        }
        let text = record["narrative"].as_str().ok_or(StoreError::Corrupt)?;
        if content_guard::dream_text(text, 40, max_chars).is_err() {
            return Err(StoreError::Corrupt.into());
        }
        let key = record["id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or(StoreError::Corrupt)?;
        let at = record["atMs"]
            .as_i64()
            .filter(|at| *at > 0)
            .ok_or(StoreError::Corrupt)?;
        let hash = Sha256::digest(
            serde_json::to_vec(&[
                mode,
                key,
                ctx.agent_id.as_str(),
                &ctx.owner_user_id,
                &ctx.workspace_key,
            ])
            .map_err(|_| StoreError::Corrupt)?,
        );
        let mut bytes = [0; 16];
        bytes.copy_from_slice(&hash[..16]);
        bytes[6] = (bytes[6] & 0x0f) | 0x80; // RFC 9562 application-defined UUID.
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        let id = uuid::Uuid::from_bytes(bytes).to_string();
        let mut row = schema_defaults(vec![]);
        row.id = id;
        row.text = text.to_owned();
        row.summary = format!("Traum: {}", summary(text));
        row.origin = "dream".into();
        row.created_at = at.into();
        row.source_timestamp = at.into();
        row.agent_id = visibility.agent_id.clone();
        row.stored_by = visibility.agent_id.clone();
        row.owner_user_id = visibility.owner_user_id.clone();
        row.workspace_id = visibility.workspace_identity.clone();
        row.workspace_key = visibility.workspace_identity.clone();
        row.memory_class = "dream".into();
        row.half_life_days = 30.into();
        row.epistemic_status = "untrusted".into();
        row.importance = number(&record["dreamImportance"], 0.10, 0.10, 0.49)?;
        row.emotional_intensity = number(&record["dreamIntensity"], 0., 0., 1.)?;
        row.emotional_dominant = record["moodDominant"].as_str().unwrap_or("neutral").into();
        row.evidence_quote = format!(
            "{mode}-dream, Stimmung: {}",
            record["moodLabel"].as_str().unwrap_or("unbekannt")
        );
        let existing = |store: &Store, row: &MemoryRow| -> Result<Option<bool>, EngineError> {
            cancel.check()?;
            if TombstoneMask::new(&self.base).masks(row)? {
                return Ok(Some(false));
            }
            if let Some(prior) = store.get(&row.id)? {
                if prior.agent_id != row.agent_id
                    || prior.stored_by != row.stored_by
                    || prior.owner_user_id != row.owner_user_id
                    || prior.workspace_id != row.workspace_id
                    || prior.workspace_key != row.workspace_key
                    || prior.scope != row.scope
                    || prior.memory_class != row.memory_class
                    || prior.text != row.text
                    || acl::allowed(&prior, ctx).is_err()
                {
                    return Err(StoreError::Corrupt.into());
                }
                return Ok(Some(prior.status == "active"));
            }
            Ok(None)
        };
        check()?;
        let Some(store) = scope.stores.existing_private(ctx)? else {
            return Ok(false);
        };
        if let Some(found) = existing(&store, &row)? {
            return Ok(found);
        }
        let sample = utf16_slice(text, 0, 500).to_utf8_lossy();
        let mut vectors = self.provider.embed(&[sample], EmbedKind::Passage, cancel)?;
        let dimension = self
            .provider
            .identity()
            .dimension
            .as_u64()
            .and_then(|dimension| usize::try_from(dimension).ok())
            .ok_or(StoreError::InvalidInput)?;
        validate_vectors(&vectors, 1, dimension)?;
        row.vector = vectors.pop().ok_or(StoreError::Corrupt)?;
        let _mutation = scope.operations.mutation()?;
        check()?;
        let store = scope
            .stores
            .existing_private(ctx)?
            .ok_or(StoreError::Unavailable)?;
        if let Some(found) = existing(&store, &row)? {
            return Ok(found);
        }
        match assert_card_write_allowed(&self.base, &row) {
            Ok(()) => {}
            Err(StoreError::TombstoneBlocked) => return Ok(false),
            Err(error) => return Err(error.into()),
        }
        cancel.check()?;
        store.upsert(&[row])?;
        Ok(true)
    }
}

pub(super) fn weight(mood: f64, material: Option<f64>, cap: Option<f64>) -> (f64, f64) {
    let mood = mood.clamp(0., 1.);
    let intensity = material.map_or(mood, |value| 0.6 * value.clamp(0., 1.) + 0.4 * mood);
    let importance = (0.10 + 0.35 * intensity).min(cap.unwrap_or(0.45).clamp(0.10, 0.49));
    (intensity, importance)
}

fn number(value: &Value, default: f64, min: f64, max: f64) -> Result<Number, StoreError> {
    Number::from_f64(value.as_f64().unwrap_or(default).clamp(min, max)).ok_or(StoreError::Corrupt)
}

fn summary(text: &str) -> String {
    let end = text.char_indices().find_map(|(index, character)| {
        let after = index + character.len_utf8();
        (matches!(character, '.' | '!' | '?' | '…')
            && text[after..]
                .chars()
                .next()
                .is_some_and(crate::text::js::is_js_whitespace))
        .then_some(after)
    });
    utf16_slice(&text[..end.unwrap_or(text.len())], 0, 150).to_utf8_lossy()
}
