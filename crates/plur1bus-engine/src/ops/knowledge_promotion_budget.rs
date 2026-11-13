//! Workspace-wide C6 budget for scheduled promotion, with content-free reservations.
use crate::{
    contract::{Cancel, EngineError, StoreError},
    jobs::rate_limit::RateLimitStore,
    store::directory::TrustedDirectory,
    text::json::{write_json, TolerantJsonValue as Json},
};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, sync::Arc};

const WINDOW_MS: i64 = 86_400_000;
const MAX_RESERVATIONS: usize = 20_000;

pub(super) struct Budget {
    store: RateLimitStore,
    now: i64,
    available: usize,
    recent: BTreeMap<String, i64>,
    selected: Vec<String>,
}

impl Budget {
    pub(super) fn open(
        workspace: &TrustedDirectory,
        adaptive: &TrustedDirectory,
        limit: usize,
        now: i64,
        cancel: &Cancel,
    ) -> Result<Self, EngineError> {
        let clock = Arc::new(move || now as f64);
        let legacy = RateLimitStore::open(workspace.path(), clock.clone())?;
        let state = object(legacy.snapshot(cancel)?.as_ref())?;
        let mut prior: usize = 0;
        if let Some(promotions) = state.get("promotedKnowledge") {
            for entry in promotions.as_object().ok_or(StoreError::Corrupt)?.values() {
                cancel.check()?;
                let entry = entry.as_object().ok_or(StoreError::Corrupt)?;
                if let Some(stamps) = entry.get("promotedAt") {
                    prior = prior.saturating_add(
                        stamps
                            .as_object()
                            .ok_or(StoreError::Corrupt)?
                            .values()
                            .filter(|at| at.as_i64().is_some_and(|at| in_window(at, now)))
                            .count(),
                    );
                }
            }
        }
        let dir = adaptive.create_child("native-promotion-budget")?;
        let store = RateLimitStore::open(dir.path(), clock)?;
        let recent = reservations(&object(store.snapshot(cancel)?.as_ref())?, now)?;
        Ok(Self {
            store,
            now,
            available: limit.saturating_sub(prior.saturating_add(recent.len())),
            recent,
            selected: Vec::new(),
        })
    }

    pub(super) fn allow(&mut self, partition: &str, digest: &str) -> bool {
        let mut hash = Sha256::new();
        hash.update(partition.as_bytes());
        hash.update([0]);
        hash.update(digest.as_bytes());
        let digest = format!("{:x}", hash.finalize());
        if self.recent.contains_key(&digest) {
            return true;
        }
        if self.selected.len() == self.available {
            return false;
        }
        self.selected.push(digest);
        true
    }

    pub(super) fn reserve(&self, cancel: &Cancel) -> Result<(), EngineError> {
        if self.selected.is_empty() {
            return Ok(());
        }
        self.store.update(cancel, |snapshot, _| {
            let mut state = object(snapshot)?;
            let mut recent = reservations(&state, self.now)?;
            if recent != self.recent || recent.len() + self.selected.len() > MAX_RESERVATIONS {
                return Err(StoreError::Busy.into());
            }
            for digest in &self.selected {
                recent.insert(digest.clone(), self.now);
            }
            state.insert(
                "reservations".into(),
                serde_json::to_value(recent).map_err(|_| StoreError::Corrupt)?,
            );
            crate::text::json::parse_json(&Value::Object(state).to_string())
                .map_err(|_| StoreError::Corrupt.into())
        })
    }
}

fn in_window(at: i64, now: i64) -> bool {
    at > now.saturating_sub(WINDOW_MS) && at <= now
}

fn object(snapshot: Option<&Json>) -> Result<Map<String, Value>, EngineError> {
    let Some(snapshot) = snapshot else {
        return Ok(Map::new());
    };
    serde_json::from_str(&write_json(snapshot)).map_err(|_| StoreError::Corrupt.into())
}

fn reservations(
    state: &Map<String, Value>,
    now: i64,
) -> Result<BTreeMap<String, i64>, EngineError> {
    let Some(value) = state.get("reservations") else {
        return Ok(BTreeMap::new());
    };
    let value = value.as_object().ok_or(StoreError::Corrupt)?;
    if value.len() > MAX_RESERVATIONS {
        return Err(StoreError::Corrupt.into());
    }
    let mut entries = BTreeMap::new();
    for (digest, at) in value {
        let at = at.as_i64().ok_or(StoreError::Corrupt)?;
        if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) || at <= 0 {
            return Err(StoreError::Corrupt.into());
        }
        // A backward clock keeps a reservation live so it cannot reopen the budget.
        if at > now.saturating_sub(WINDOW_MS) {
            entries.insert(digest.clone(), at);
        }
    }
    Ok(entries)
}

#[cfg(test)]
#[test]
#[allow(
    clippy::unwrap_used,
    reason = "isolated budget fixtures must be available"
)]
fn workspace_budget_counts_legacy_and_native_across_partitions_and_survives_retry() {
    let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let workspace = TrustedDirectory::open(temp.path()).unwrap();
    let adaptive = workspace.create_child(".adaptive-learning").unwrap();
    let now = WINDOW_MS * 3;
    let cancel = &Cancel::never();
    let legacy = serde_json::json!({"promotedKnowledge":{
        "schicht15:old:another-agent":{"promotedAt":{"today":now-1,"expired":now-WINDOW_MS}}
    }});
    let state = temp.path().join("run-state.json");
    std::fs::write(&state, legacy.to_string()).unwrap();
    let open = |now| Budget::open(&workspace, &adaptive, 2, now, cancel).unwrap();
    let mut first = open(now);
    assert!(first.allow("first-owner-and-agent", "same-source"));
    first.reserve(cancel).unwrap();
    let mut retry = open(now);
    assert!(retry.allow("first-owner-and-agent", "same-source"));
    assert!(!retry.allow("another-owner-and-agent", "same-source"));
    retry.reserve(cancel).unwrap();
    assert!(open(now + WINDOW_MS).allow("another-owner-and-agent", "same-source"));
    assert_eq!(std::fs::read_to_string(&state).unwrap(), legacy.to_string());
    std::fs::write(&state, "{broken").unwrap();
    assert!(Budget::open(&workspace, &adaptive, 2, now, cancel).is_err());
    assert_eq!(std::fs::read_to_string(&state).unwrap(), "{broken");
}
