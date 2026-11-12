//! Read-only rollback selection. Durable import receipts, never caller keys, establish ownership.
use super::{
    context::error,
    import_ledger::{ImportIndex, ImportLedger},
    import_primitives::{field, import_card_id, import_row_digest, number, ImportDigest},
    link::source_ref_run_id,
    rebind_ledger::{self, RebindLedger},
    unimport_ledger::{marker_key, UndoReceipt, UnimportLedger, UnimportState},
};
use crate::{
    context::RequestContext,
    contract::{EngineError, MemoryOpErrorCode, MemoryRow, StoreError},
    recall::acl::{self, AclMemory, AclSubject},
    store::{ledger::JsonlLedger, tombstone::TombstoneRegistry},
    text::{
        js::JsString,
        json::{parse_json, write_json, TolerantJsonValue as Json},
    },
};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
};
pub(super) fn storage(_: impl Sized) -> EngineError {
    error(MemoryOpErrorCode::Storage)
}
pub(super) fn text<'a>(row: &'a Json, key: &str) -> Option<&'a JsString> {
    match field(row, key) {
        Some(Json::String(s)) => Some(s),
        _ => None,
    }
}
pub(super) fn run_id(row: &Json) -> String {
    text(row, "importRunId")
        .filter(|s| !s.is_empty())
        .map(JsString::to_utf8_lossy)
        .unwrap_or_else(|| {
            source_ref_run_id(
                &text(row, "sourceRef")
                    .map(JsString::to_utf8_lossy)
                    .unwrap_or_default(),
            )
        })
}
pub(super) struct Selected {
    pub receipt: UndoReceipt,
    pub digest: Option<ImportDigest>,
}
pub(super) fn select(
    base: &Path,
    agent: &str,
    run: &str,
    keys: Option<&HashSet<JsString>>,
) -> Result<Vec<Selected>, EngineError> {
    let mut selected = HashMap::new();
    let mut generations: HashMap<JsString, usize> = HashMap::new();
    for (order, line) in ImportLedger::new(base)
        .read_lines(agent)
        .map_err(storage)?
        .into_iter()
        .enumerate()
    {
        if !matches!(field(&line.raw, "kind"), None | Some(Json::Null)) {
            continue;
        }
        let generation = generations.entry(line.card_id.clone()).or_default();
        *generation += 1;
        if !matches!(field(&line.raw, "kind"), None | Some(Json::Null))
            || run_id(&line.raw) != run
            || keys.is_some_and(|k| !k.contains(&line.key))
        {
            continue;
        }
        // Same UTF-8 boundary as the actual SHA-1 UUID, even for legacy lone surrogates.
        if line.card_id != JsString::from(import_card_id(agent, &line.key.to_utf8_lossy())) {
            continue;
        }
        let n = field(&line.raw, "importedAt").map_or(0., number);
        let digest = field(&line.raw, "digest")
            .and_then(|d| serde_json::from_str::<ImportDigest>(&write_json(d)).ok())
            .filter(ImportDigest::is_valid);
        selected.insert(
            line.card_id.clone(),
            (
                order,
                Selected {
                    receipt: UndoReceipt {
                        card_id: line.card_id,
                        idempotency_key: line.key,
                        imported_at: if n.is_nan() { 0. } else { n },
                        generation: (*generation > 1).then_some(*generation),
                    },
                    digest,
                },
            ),
        );
    }
    let mut selected: Vec<_> = selected.into_values().collect();
    selected.sort_by_key(|(i, _)| *i);
    Ok(selected.into_iter().map(|(_, s)| s).collect())
}
#[derive(Clone)]
pub(super) struct SelectedLink {
    pub link_id: JsString,
    pub card_id: JsString,
    pub done: bool,
}
pub(super) fn links(
    base: &Path,
    agent: &str,
    run: &str,
    keys: Option<&HashSet<JsString>>,
) -> Result<Vec<SelectedLink>, EngineError> {
    let mut selected: HashMap<JsString, (usize, SelectedLink)> = HashMap::new();
    let ledger = JsonlLedger::<Json>::open(&base.join("_links").join(format!("{agent}.jsonl")))
        .map_err(storage)?;
    for (order, line) in ledger.snapshot().map_err(storage)?.lines().enumerate() {
        let Ok(row) = parse_json(line) else { continue };
        if !matches!(field(&row,"v"),Some(Json::Number(n)) if n.parse::<f64>()==Ok(1.)) {
            continue;
        }
        let (Some(link), Some(card)) = (text(&row, "linkId"), text(&row, "cardId")) else {
            continue;
        };
        let kind = text(&row, "kind").map(JsString::to_utf8_lossy);
        match kind.as_deref() {
            Some("linked") if text(&row, "sourceRef").is_some() => {
                selected.remove(link);
                if run_id(&row) == run
                    && !keys.is_some_and(|k| {
                        text(&row, "idempotencyKey").is_none_or(|key| !k.contains(key))
                    })
                {
                    selected.insert(
                        link.clone(),
                        (
                            order,
                            SelectedLink {
                                link_id: link.clone(),
                                card_id: card.clone(),
                                done: false,
                            },
                        ),
                    );
                }
            }
            Some("unlinked") if text(&row, "importRunId") == Some(&JsString::from(run)) => {
                if let Some((_, s)) = selected.get_mut(link) {
                    s.done = true;
                }
            }
            _ => {}
        }
    }
    let mut out: Vec<_> = selected.into_values().collect();
    out.sort_by_key(|(i, _)| *i);
    Ok(out.into_iter().map(|(_, s)| s).collect())
}
pub(super) struct Snapshot {
    pub sidecar: UnimportState,
    pub index: ImportIndex,
    pub forgotten: HashSet<JsString>,
    pub rebound: HashSet<JsString>,
}
impl Snapshot {
    pub fn load(base: &Path, agent: &str, run: &str) -> Result<Self, EngineError> {
        let registry = TombstoneRegistry::new(base, agent)
            .map_err(storage)?
            .read(false)
            .map_err(storage)?;
        // A corrupt registry cannot authorize deletion. Preview never repairs its bytes.
        if registry.corrupt_lines != 0 {
            return Err(storage(()));
        }
        let mut forgotten = HashSet::new();
        for row in registry.tombstones {
            if text(&row, "status") != Some(&JsString::from("committed")) {
                continue;
            }
            for key in ["memoryId", "canonicalOriginId"] {
                if let Some(id) = text(&row, key) {
                    forgotten.insert(id.clone());
                }
            }
        }
        let mut rebound = HashSet::new();
        for (_, record) in RebindLedger::new(base).list_applied()? {
            if record
                .header
                .as_ref()
                .and_then(|h| rebind_ledger::string(h, "agentId"))
                .as_deref()
                != Some(agent)
            {
                continue;
            }
            for card in record.cards {
                if let Some(id) = text(&card, "cardId") {
                    rebound.insert(id.clone());
                }
            }
        }
        Ok(Self {
            sidecar: UnimportLedger::new(base).load(agent, run)?,
            index: ImportLedger::new(base).load(agent).map_err(storage)?,
            forgotten,
            rebound,
        })
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Decision {
    Done,
    Finish,
    Eligible(Option<&'static str>),
    Kept(&'static str),
    Forgotten,
    Missing,
}
impl Decision {
    pub fn result(self) -> (&'static str, Option<&'static str>) {
        match self {
            Self::Done => ("already-unimported", None),
            Self::Forgotten => ("already-forgotten", None),
            Self::Missing => ("missing", None),
            Self::Kept(r) => ("kept-modified", Some(r)),
            Self::Finish | Self::Eligible(_) => ("unimported", None),
        }
    }
}
pub(super) fn row_digest(row: &MemoryRow) -> Result<ImportDigest, StoreError> {
    let raw = parse_json(&serde_json::to_string(row).map_err(|_| StoreError::Corrupt)?)
        .map_err(|_| StoreError::Corrupt)?;
    Ok(import_row_digest(&raw))
}
pub(super) fn moved(before: &MemoryRow, after: Option<&MemoryRow>) -> Result<bool, EngineError> {
    let Some(after) = after else { return Ok(true) };
    Ok(before.status != after.status
        || before.superseded_by != after.superseded_by
        || row_digest(before).map_err(storage)? != row_digest(after).map_err(storage)?)
}
pub(super) fn visible(row: &MemoryRow, contexts: &[&RequestContext]) -> Result<bool, EngineError> {
    let ownership = AclMemory::from_row(row).ok_or_else(|| storage(()))?;
    Ok(contexts.iter().any(|ctx| {
        acl::check_access(Some(&AclSubject::from_context(ctx)), Some(&ownership)).is_ok()
    }))
}
pub(super) fn decide(
    card: &Selected,
    row: Option<&MemoryRow>,
    snapshot: &Snapshot,
    contexts: &[&RequestContext],
    run: &str,
    force: bool,
    shared: impl FnOnce() -> Result<bool, StoreError>,
) -> Result<Decision, EngineError> {
    let receipt = &card.receipt;
    // RE-D36: a human forget and the current import generation outrank old completion markers.
    if snapshot.forgotten.contains(&receipt.card_id) {
        return Ok(Decision::Forgotten);
    }
    let latest = snapshot.index.by_card_id.get(&receipt.card_id);
    if latest.is_some_and(|line| run_id(&line.raw) != run) {
        return Ok(Decision::Kept("other-run"));
    }
    if let Some(row) = row {
        // Request run ids are provenance, never access grants. Apply the same ACL as import/recall.
        if !visible(row, contexts)? {
            return Ok(Decision::Kept("binding-changed"));
        }
    }
    let time = Json::Number(ryu_js::Buffer::new().format(receipt.imported_at).to_owned());
    let marker = marker_key(&receipt.card_id, Some(&time));
    let done = receipt.generation.map_or_else(
        || snapshot.sidecar.done.contains(&marker),
        |g| {
            snapshot
                .sidecar
                .generation_done
                .contains(&(marker.clone(), g))
        },
    );
    if done && latest.is_none() {
        return Ok(Decision::Done);
    }
    // A live latest receipt after an old done marker is a fresh generation, even in the same ms.
    let intent = receipt.generation.map_or_else(
        || snapshot.sidecar.intents.contains(&marker),
        |g| {
            snapshot
                .sidecar
                .generation_intents
                .contains(&(marker.clone(), g))
        },
    ) && !(done && latest.is_some());
    let ours = snapshot
        .index
        .unimported_by_card_id
        .get(&receipt.card_id)
        .is_some_and(|l| text(&l.raw, "importRunId") == Some(&JsString::from(run)));
    let Some(row) = row else {
        return Ok(if intent {
            Decision::Finish
        } else {
            Decision::Missing
        });
    };
    if row.status == "deleted" {
        return Ok(if intent || ours {
            Decision::Finish
        } else {
            Decision::Forgotten
        });
    }
    let agent = contexts
        .first()
        .ok_or_else(|| storage(()))?
        .agent_id
        .as_str();
    let reason = if row.status == "superseded" || !row.superseded_by.is_empty() {
        Some("superseded")
    } else if !matches!(row.status.as_str(), "" | "active") {
        Some("metadata-changed")
    } else if !row.agent_id.is_empty() && row.agent_id != agent {
        Some("binding-changed")
    } else if snapshot.rebound.contains(&receipt.card_id) {
        Some("rebound")
    } else if shared().map_err(storage)? {
        Some("shared")
    } else if let Some(digest) = &card.digest {
        let current = row_digest(row).map_err(storage)?;
        if current.binding != digest.binding {
            Some("binding-changed")
        } else if current.content != digest.content {
            Some("content-changed")
        } else if current.meta != digest.meta {
            Some("metadata-changed")
        } else {
            None
        }
    } else if row.updated_at.as_f64().unwrap_or(0.) != receipt.imported_at {
        Some("edited")
    } else {
        None
    };
    Ok(match reason {
        None => Decision::Eligible(None),
        Some(reason)
            if force && matches!(reason, "content-changed" | "metadata-changed" | "edited") =>
        {
            Decision::Eligible(Some(reason))
        }
        Some(reason) => Decision::Kept(reason),
    })
}
pub(super) fn derived_jobs(root: Option<&Path>, agent: &str, selected: &[Selected]) -> Vec<String> {
    const JOBS: [&str; 6] = [
        "consolidate-daily",
        "rem-dream",
        "light-dream",
        "meta-reflect",
        "episodes-rebuild",
        "skill-miner",
    ];
    let since = selected
        .iter()
        .map(|c| c.receipt.imported_at)
        .fold(f64::INFINITY, f64::min);
    let Some(root) = root.filter(|_| since.is_finite()) else {
        return vec![];
    };
    let Ok(lines) = JsonlLedger::<serde_json::Value>::open(&root.join(agent).join("ledger.jsonl"))
        .and_then(|l| l.snapshot())
    else {
        return vec![];
    };
    let mut found = HashSet::new();
    for line in lines.lines() {
        if let Ok(row) = serde_json::from_str::<serde_json::Value>(line) {
            if matches!(row["outcome"].as_str(), Some("completed" | "incomplete"))
                && row["finishedAt"]
                    .as_f64()
                    .is_some_and(|n| n.is_finite() && n > since)
            {
                if let Some(job) = row["job"].as_str() {
                    found.insert(job.to_owned());
                }
            }
        }
    }
    JOBS.into_iter()
        .filter(|j| found.contains(*j))
        .map(str::to_owned)
        .collect()
}
