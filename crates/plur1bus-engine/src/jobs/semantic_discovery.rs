//! C5 semantic link discovery. The private result is independent of any vault writer.
use super::{
    lance_scope::LanceScope,
    registry::{JobBody, JobContext, JobReport},
};
use crate::{
    context::RequestContext,
    contract::{Cancel, EngineError, JobName, JobOutcome, MemoryRow, StoreError},
    recall::{
        acl, hash_embed::cosine_similarity, lifecycle::is_recall_entry_live,
        tombstone_mask::TombstoneMask,
    },
    store::{directory::TrustedDirectory, kernel_lease},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::Write,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

const MAX_SOURCE_ROWS: usize = 5000;
const MAX_INDEX_BYTES: usize = 8 * 1024 * 1024;
const FILE: &str = "link-index.json";

pub(crate) struct SemanticDiscovery {
    pub scope: Arc<LanceScope>,
    pub base: PathBuf,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Index {
    version: String,
    entries: BTreeMap<String, Entry>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Entry {
    similar: Vec<String>,
    content_hash: String,
    first_discovered_at: String,
    last_checked_at: String,
}

impl JobBody for SemanticDiscovery {
    fn name(&self) -> JobName {
        JobName::DiscoverSemanticLinks
    }

    fn run(&self, context: &JobContext, cancel: &Cancel) -> Result<JobReport, EngineError> {
        let cancel = &cancel.limited_to(Instant::now() + Duration::from_secs(90));
        let authority = context.authority()?;
        let (principal, agent) = authority.caller();
        let _operation = self.scope.operations.enter(principal, agent)?;
        let host = self.scope.operations.host();
        let raw = serde_json::to_value(host.config()).map_err(|_| StoreError::Corrupt)?;
        let config = crate::config::effective_config(&raw).map_err(|_| StoreError::InvalidInput)?;
        let bridge = &config["obsidianBridge"];
        let links = &bridge["graphLinks"];
        let settings = &links["semanticDiscovery"];
        if bridge["enabled"] == false || settings["enabled"] == false {
            return Ok(JobReport {
                outcome: JobOutcome::Skipped,
                reason: Some("semantic_discovery_disabled".into()),
            });
        }
        if let Some(skip) = self.scope.check(authority, cancel)? {
            return Ok(skip);
        }
        let request = authority.request();
        let Some(store) = self.scope.stores.existing_private(request)? else {
            return Ok(JobReport::completed());
        };
        let mut filter = LanceScope::filter(authority);
        filter.status = Some("active".into());
        let binding =
            crate::recall::knowledge::private_key(request).ok_or(StoreError::InvalidInput)?;
        let dir = TrustedDirectory::open(&self.base)?
            .create_child("_semantic")?
            .create_child(&binding)?;
        let lease = kernel_lease::acquire(&dir, "semantic-discovery", cancel, &mut || {})?;
        let before = super::ledger::io::read(&dir, FILE, MAX_INDEX_BYTES, cancel)?;
        let mut index: Index = match before.as_deref() {
            Some(bytes) => serde_json::from_slice(bytes).map_err(|_| StoreError::Corrupt)?,
            None => Index {
                version: "1".into(),
                entries: BTreeMap::new(),
            },
        };
        if index.version != "1" || index.entries.len() > MAX_SOURCE_ROWS {
            return Err(StoreError::Corrupt.into());
        }
        let load = || {
            let tombstones = TombstoneMask::new(&self.base);
            let mut rows = BTreeMap::new();
            for row in store.scan(&filter, MAX_SOURCE_ROWS)? {
                cancel.check()?;
                if eligible(&row, request, context.now_ms) && !tombstones.masks(&row)? {
                    let id = row.id.clone();
                    if rows.insert(id, row).is_some() {
                        return Err(StoreError::Corrupt.into());
                    }
                }
            }
            Ok::<_, EngineError>(rows)
        };
        let source = load()?;
        if source.is_empty() && index.entries.is_empty() {
            return Ok(JobReport::completed());
        }
        let mut order: Vec<_> = source.values().collect();
        order.sort_by(|a, b| {
            let time = |row: &MemoryRow| {
                index
                    .entries
                    .get(&row.id)
                    .map(|entry| entry.last_checked_at.as_str())
            };
            time(a).cmp(&time(b)).then(a.id.cmp(&b.id))
        });
        let threshold = settings["threshold"]
            .as_f64()
            .or_else(|| links["semanticThreshold"].as_f64())
            .filter(|value| value.is_finite())
            .unwrap_or(0.78)
            .clamp(0., 1.);
        let count = |name, default, max| -> usize {
            settings[name]
                .as_u64()
                .map_or(default, |value| value.min(max) as usize)
        };
        let max_per_run = count("maxPerRun", 500, 5000);
        let max_links = count("maxLinksPerRecord", 5, 100);
        let top_k = count("topK", 15, 4096);
        let now = chrono::DateTime::from_timestamp_millis(context.now_ms)
            .ok_or(StoreError::InvalidInput)?
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let mut processed = 0;
        let mut unchanged = 0;
        let mut skipped = 0;
        for row in order.into_iter().take(max_per_run) {
            cancel.check()?;
            if row.vector.iter().all(|value| *value == 0.) {
                skipped += 1;
                continue;
            }
            let content_hash = content_hash(row);
            if index
                .entries
                .get(&row.id)
                .is_some_and(|entry| entry.content_hash == content_hash)
            {
                unchanged += 1;
                continue;
            }
            let mut similar = Vec::new();
            for result in store.search(&row.vector, top_k.saturating_add(1), &filter)? {
                let candidate = &result.row;
                if candidate.id != row.id
                    && source.contains_key(&candidate.id)
                    && eligible(candidate, request, context.now_ms)
                {
                    let score = cosine_similarity(&row.vector, &candidate.vector);
                    if score >= threshold {
                        similar.push((candidate.id.clone(), score));
                    }
                }
            }
            similar.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
            let first_discovered_at = index
                .entries
                .get(&row.id)
                .map_or_else(|| now.clone(), |entry| entry.first_discovered_at.clone());
            index.entries.insert(
                row.id.clone(),
                Entry {
                    similar: similar
                        .into_iter()
                        .map(|(id, _)| id)
                        .take(max_links)
                        .collect(),
                    content_hash,
                    first_discovered_at,
                    last_checked_at: now.clone(),
                },
            );
            processed += 1;
        }
        index.entries.retain(|id, entry| {
            entry.similar.retain(|peer| source.contains_key(peer));
            source.contains_key(id)
        });
        let bytes = serde_json::to_vec_pretty(&index).map_err(|_| StoreError::Corrupt)?;
        if bytes.len() > MAX_INDEX_BYTES {
            return Err(StoreError::Unavailable.into());
        }
        if before.as_deref() != Some(&bytes) {
            let _mutation = self.scope.operations.mutation()?;
            let check = || {
                lease.check(&dir)?;
                if self.scope.check(authority, cancel)?.is_some()
                    || serde_json::to_value(host.config()).map_err(|_| StoreError::Corrupt)? != raw
                {
                    return Err(StoreError::Unavailable.into());
                }
                Ok(())
            };
            check()?;
            let current = load()?;
            if current.len() != source.len()
                || current.iter().any(|(id, row)| {
                    source.get(id).is_none_or(|old| {
                        old.vector != row.vector || content_hash(old) != content_hash(row)
                    })
                })
            {
                return Err(StoreError::Unavailable.into());
            }
            replace(&dir, before.as_deref(), &bytes, cancel, &check)?;
        }
        context.note_count("processed", processed)?;
        context.note_count("unchanged", unchanged)?;
        context.note_count("skipped", skipped)?;
        Ok(JobReport::completed())
    }
}

fn eligible(row: &MemoryRow, request: &RequestContext, now: i64) -> bool {
    row.agent_id == request.agent_id.as_str()
        && row.stored_by == request.agent_id.as_str()
        && row.workspace_key == request.workspace_key
        && row.owner_user_id == request.owner_user_id
        && row.scope == "agent-private"
        && row.id != "__schema__"
        && row.memory_class != "dream"
        && is_recall_entry_live(row, now, None)
        && acl::allowed(row, request).is_ok()
}

fn content_hash(row: &MemoryRow) -> String {
    let mut hash = Sha256::new();
    hash.update(row.text.as_bytes());
    hash.update([0]);
    hash.update(row.summary.as_bytes());
    format!("sha256:{:x}", hash.finalize())
}

fn replace(
    dir: &TrustedDirectory,
    before: Option<&[u8]>,
    bytes: &[u8],
    cancel: &Cancel,
    check: &dyn Fn() -> Result<(), EngineError>,
) -> Result<(), EngineError> {
    let name = format!(".semantic-{}.tmp", uuid::Uuid::new_v4());
    let mut file = dir.create_file(&name)?;
    let identity = crate::store::directory::regular_file_identity(&file)?;
    let old_identity = super::ledger::io::identity(dir, FILE)?;
    let result = (|| {
        file.write_all(bytes).map_err(StoreError::from)?;
        file.sync_all().map_err(StoreError::from)?;
        drop(file);
        check()?;
        if super::ledger::io::read(dir, FILE, MAX_INDEX_BYTES, cancel)?.as_deref() != before {
            return Err(StoreError::Unavailable.into());
        }
        dir.replace_staged(&name, FILE, identity, old_identity)?;
        Ok(())
    })();
    if result.is_err() && super::ledger::io::identity(dir, &name).ok().flatten() == Some(identity) {
        let _ = dir.remove_file(&name);
    }
    result
}
