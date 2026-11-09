//! Bounded, side-effect-free retroactive-interference planning from pinned Node behavior.
//! The composition layer owns current source ACLs, exact-revision CAS and durable replay.
use super::dynamics::{compute_decayed_strength, is_core_memory};
use crate::{
    contract::{Cancel, EngineError, StoreError},
    text::{js::JsString, json::TolerantJsonValue as Json},
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
/// Explicit options from already validated host configuration; no provider is constructed.
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct InterferenceOptions {
    /// Disabled effects neither search nor plan changes.
    pub enabled: bool,
    /// Search adapter similarity floor, in [0, 1].
    pub threshold: f64,
    /// Multiplier after ordinary time decay, in [0, 1].
    pub multiplier: f64,
    /// Maximum changed rows, capped at 64 for a bounded native transaction plan.
    pub max_affected: usize,
}
impl Default for InterferenceOptions {
    fn default() -> Self {
        Self {
            enabled: true,
            threshold: 0.65,
            multiplier: 0.9,
            max_affected: 5,
        }
    }
}
impl InterferenceOptions {
    fn validate(self) -> Result<(), EngineError> {
        if self.max_affected > 64
            || !self.threshold.is_finite()
            || !(0. ..=1.).contains(&self.threshold)
            || !self.multiplier.is_finite()
            || !(0. ..=1.).contains(&self.multiplier)
        {
            return Err(StoreError::InvalidInput.into());
        }
        Ok(())
    }
}
/// Requested search shape; it grants no access to a store or its candidates.
#[derive(Debug)]
pub struct InterferenceSearch {
    /// Original finite source vector, without lossy f32 re-encoding here.
    pub vector: Vec<f64>,
    /// One more than max_affected, matching Node even when the maximum is zero.
    pub limit: usize,
    /// Similarity floor to enforce at the authorized search adapter.
    pub threshold: f64,
}
/// A frozen planned patch; preserving its exact source is essential for later CAS and recovery.
#[derive(Clone, Debug)]
pub struct InterferenceEffect {
    /// Candidate ID, retained without UTF-16 loss.
    pub id: JsString,
    /// Exact candidate snapshot, not a permission grant.
    pub before: Json,
    /// Decayed and multiplied strength with Node's 0.01 floor.
    pub memory_strength: f64,
    /// Single captured host clock for this whole plan.
    pub last_dynamics_at: i64,
}
/// Resolve the Node search request without any I/O. Missing source ID/vector skips the effect.
pub fn search_request(
    source: &Json,
    options: InterferenceOptions,
    cancel: &Cancel,
) -> Result<Option<InterferenceSearch>, EngineError> {
    cancel.check()?;
    options.validate()?;
    if !options.enabled {
        return Ok(None);
    }
    bounded(source, cancel, &mut (0, 0))?;
    if id(source).is_none() || field(source, "vector").is_none_or(|v| matches!(v, Json::Null)) {
        return Ok(None);
    }
    let Some(Json::Array(raw)) = field(source, "vector") else {
        return Err(StoreError::InvalidInput.into());
    };
    if raw.is_empty() || raw.len() > 32_768 {
        return Err(StoreError::InvalidInput.into());
    }
    let vector = raw
        .iter()
        .map(|v| match v {
            Json::Number(n) => n
                .parse::<f64>()
                .ok()
                .filter(|v| v.is_finite())
                .ok_or(StoreError::InvalidInput),
            _ => Err(StoreError::InvalidInput),
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Some(InterferenceSearch {
        vector,
        limit: options.max_affected + 1,
        threshold: options.threshold,
    }))
}
/// Select in adapter order, skip the new row and core markers, and freeze patches without writes.
/// Duplicate target IDs refuse rather than create ambiguous revision/replay obligations.
pub fn plan(
    source: &Json,
    candidates: &[Json],
    now: i64,
    options: InterferenceOptions,
    cancel: &Cancel,
) -> Result<Vec<InterferenceEffect>, EngineError> {
    let Some(_) = search_request(source, options, cancel)? else {
        return Ok(Vec::new());
    };
    if candidates.len() > 65 || now.unsigned_abs() > 8_640_000_000_000_000 {
        return Err(StoreError::InvalidInput.into());
    }
    let source_id = id(source).ok_or(StoreError::InvalidInput)?;
    let mut seen = HashSet::new();
    let mut budget = (0, 0);
    for candidate in candidates {
        bounded(candidate, cancel, &mut budget)?;
        if let Some(id) = id(candidate) {
            if !seen.insert(id) {
                return Err(StoreError::InvalidInput.into());
            }
        }
    }
    let mut effects = Vec::new();
    for candidate in candidates {
        cancel.check()?;
        if effects.len() == options.max_affected {
            break;
        }
        let Some(id) = id(candidate) else {
            continue;
        };
        if id == source_id || is_core_memory(candidate) {
            continue;
        }
        let strength = compute_decayed_strength(candidate, now as f64) * options.multiplier;
        if !strength.is_finite() {
            return Err(StoreError::InvalidInput.into());
        }
        effects.push(InterferenceEffect {
            id: id.clone(),
            before: candidate.clone(),
            memory_strength: strength.max(0.01),
            last_dynamics_at: now,
        });
    }
    Ok(effects)
}
fn field<'a>(value: &'a Json, key: &str) -> Option<&'a Json> {
    let Json::Object(fields) = value else {
        return None;
    };
    fields
        .iter()
        .find(|(k, _)| *k == JsString::from(key))
        .map(|(_, v)| v)
}
fn id(value: &Json) -> Option<&JsString> {
    match field(value, "id") {
        Some(Json::String(v)) if !v.as_utf16_units().is_empty() => Some(v),
        _ => None,
    }
}
pub(crate) fn bounded(
    value: &Json,
    cancel: &Cancel,
    budget: &mut (usize, usize),
) -> Result<(), EngineError> {
    let mut pending = vec![(value, 0)];
    let (nodes, units) = budget;
    while let Some((v, depth)) = pending.pop() {
        cancel.check()?;
        *nodes += 1;
        if *nodes > 50_000 || depth > 128 {
            return Err(StoreError::InvalidInput.into());
        }
        match v {
            Json::String(v) => *units += v.as_utf16_units().len(),
            Json::Number(v) => *units += v.len(),
            Json::Array(values) => {
                if values.len() + pending.len() > 50_000 {
                    return Err(StoreError::InvalidInput.into());
                }
                pending.extend(values.iter().map(|v| (v, depth + 1)));
            }
            Json::Object(fields) => {
                if fields.len() + pending.len() > 50_000 {
                    return Err(StoreError::InvalidInput.into());
                }
                let mut names = HashSet::new();
                for (k, v) in fields {
                    if !names.insert(k) {
                        return Err(StoreError::InvalidInput.into());
                    }
                    *units += k.as_utf16_units().len();
                    pending.push((v, depth + 1));
                }
            }
            _ => {}
        }
        if *units > 1_048_576 {
            return Err(StoreError::InvalidInput.into());
        }
    }
    Ok(())
}
