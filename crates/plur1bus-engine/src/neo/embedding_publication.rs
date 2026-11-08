//! Replay of an exact saved vector append, followed by authorized metadata and queue revisions.
use super::{
    capture_journal::CaptureJournal,
    derived_fields::{field, set, str_field, text, validate_object},
    embedding_plan::{self, QUEUE, TARGETS},
    embedding_vectors, episode_io, journal_io,
};
use crate::{
    context::RequestContext,
    contract::{Cancel, EngineError, StoreError},
    store::{atomic_write::atomic_write, directory::TrustedDirectory, state_file::StateFile},
    text::{
        js::JsString,
        json::{write_json, TolerantJsonValue as Json},
    },
};
use std::collections::{HashMap, HashSet};

pub(super) struct Session<'a> {
    pub dir: &'a TrustedDirectory,
    pub proof: &'a Json,
    pub name: String,
    pub ctx: &'a RequestContext,
    pub check: &'a dyn Fn() -> Result<(), EngineError>,
    pub journal: &'a CaptureJournal,
    pub now: &'a str,
    pub caller: Json,
}
fn changes(plan: &Json) -> Result<&[Json], StoreError> {
    if field(plan, "version")? != &embedding_vectors::number(1) {
        return Err(StoreError::Corrupt);
    }
    let Json::Array(changes) = field(plan, "changes")? else {
        return Err(StoreError::Corrupt);
    };
    if changes.len() > 2000 || changes.is_empty() {
        return Err(StoreError::Corrupt);
    }
    Ok(changes)
}
fn file(change: &Json) -> Result<String, StoreError> {
    let name = str_field(change, "file")?.to_utf8_lossy();
    if !TARGETS.contains(&name.as_str()) && name != QUEUE {
        return Err(StoreError::Corrupt);
    }
    Ok(name)
}
fn latest(dir: &TrustedDirectory, file: &str, cancel: &Cancel) -> Result<Vec<Json>, EngineError> {
    let rows = journal_io::rows(dir, file, cancel)?;
    Ok(if file == QUEUE {
        embedding_plan::latest_queue(rows)?
    } else {
        journal_io::latest(rows)?
    })
}
fn validate_change(change: &Json, ctx: &RequestContext) -> Result<(), StoreError> {
    validate_object(change)?;
    let file = file(change)?;
    let before = field(change, "before")?;
    let after = field(change, "after")?;
    validate_object(before)?;
    validate_object(after)?;
    if !embedding_plan::private(before, ctx)
        || !embedding_plan::private(after, ctx)
        || journal_io::id(before)? != journal_io::id(after)?
    {
        return Err(StoreError::Corrupt);
    }
    let allowed: &[&str] = if file == QUEUE {
        &["impact", "status", "processedAt", "reason"]
    } else {
        if !embedding_plan::live(before, ctx)
            || !embedding_plan::live(after, ctx)
            || field(after, "embeddingStatus")? != &text("fresh")
            || field(after, "embeddingStore")? != &text("sidecar")
        {
            return Err(StoreError::Corrupt);
        }
        &[
            "embedding",
            "embeddingStatus",
            "embeddingDims",
            "embeddingStore",
            "embeddingImpact",
            "embeddingUpdatedAt",
        ]
    };
    let strip = |row: &Json| -> Json {
        match row {
            Json::Object(fields) => Json::Object(
                fields
                    .iter()
                    .filter(|(k, _)| !allowed.iter().any(|a| k == &JsString::from(*a)))
                    .cloned()
                    .collect(),
            ),
            _ => Json::Null,
        }
    };
    if strip(before) != strip(after) {
        return Err(StoreError::Corrupt);
    }
    Ok(())
}
pub(super) fn preflight(
    session: &Session<'_>,
    plan: &Json,
    cancel: &Cancel,
) -> Result<(), EngineError> {
    (session.check)()?;
    let changes = changes(plan)?;
    let mut seen = HashSet::new();
    for change in changes {
        validate_change(change, session.ctx)?;
        if !seen.insert((file(change)?, journal_io::id(field(change, "before")?)?)) {
            return Err(StoreError::Corrupt.into());
        }
    }
    for name in TARGETS.into_iter().chain([QUEUE]) {
        let rows = journal_io::rows(session.dir, name, cancel)?;
        let current: HashMap<_, _> = latest(session.dir, name, cancel)?
            .into_iter()
            .map(|r| Ok((journal_io::id(&r)?, r)))
            .collect::<Result<_, StoreError>>()?;
        let mut count = rows.len();
        let mut length = journal_io::bytes(session.dir, name, cancel)?.map_or(0, |b| b.len());
        for change in changes.iter().filter(|c| file(c).is_ok_and(|f| f == name)) {
            let before = field(change, "before")?;
            let after = field(change, "after")?;
            let row = current
                .get(&journal_io::id(before)?)
                .ok_or(StoreError::Corrupt)?;
            if row != before && row != after {
                return Err(StoreError::Corrupt.into());
            }
            if row != after {
                count += 1;
                length = length
                    .checked_add(write_json(after).len() + 2)
                    .ok_or(StoreError::Corrupt)?;
            }
        }
        if count > journal_io::MAX_ROWS || length > journal_io::MAX_BYTES {
            return Err(StoreError::Corrupt.into());
        }
    }
    embedding_vectors::verify(session.dir, session.proof, field(plan, "vectors")?, cancel)?;
    embedding_vectors::verify_changes(field(plan, "vectors")?, changes)?;
    let _ = indices(session.dir, changes, cancel)?;
    Ok(())
}
pub(super) fn resume(session: &Session<'_>, cancel: &Cancel) -> Result<usize, EngineError> {
    let Some(plan) = episode_io::read(session.dir, &session.name, session.proof, cancel)? else {
        return Ok(0);
    };
    super::revision_io::guard_pending(session.dir, cancel)?;
    guard_other_pending(session.dir, &session.name, cancel)?;
    let caller = super::caller::decode(field(&plan, "caller")?)?;
    let ctx = session
        .journal
        .authorize_caller(&caller, session.proof, cancel)?;
    let check = || -> Result<(), EngineError> {
        (session.check)()?;
        if session
            .journal
            .authorize_caller(&caller, session.proof, cancel)?
            != ctx
        {
            return Err(StoreError::InvalidInput.into());
        }
        Ok(())
    };
    let original = Session {
        dir: session.dir,
        proof: session.proof,
        name: session.name.clone(),
        ctx: &ctx,
        check: &check,
        journal: session.journal,
        now: session.now,
        caller: field(&plan, "caller")?.clone(),
    };
    preflight(&original, &plan, cancel)?;
    let changes = changes(&plan)?;
    embedding_vectors::publish(session.dir, field(&plan, "vectors")?, cancel, &check)?;
    let mut appended = 0;
    for name in TARGETS.into_iter().chain([QUEUE]) {
        let relevant: Vec<_> = changes
            .iter()
            .filter(|c| file(c).is_ok_and(|f| f == name))
            .collect();
        if relevant.is_empty() {
            continue;
        }
        if let Some(bytes) = journal_io::bytes(session.dir, name, cancel)? {
            let committed = bytes.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
            if committed < bytes.len() {
                check()?;
                session
                    .dir
                    .truncate_jsonl_tail(name, bytes.len() as u64, committed as u64)?;
            }
        }
        let current: HashMap<_, _> = latest(session.dir, name, cancel)?
            .into_iter()
            .map(|r| Ok((journal_io::id(&r)?, r)))
            .collect::<Result<_, StoreError>>()?;
        for change in relevant {
            let after = field(change, "after")?;
            if current.get(&journal_io::id(after)?) != Some(after) {
                check()?;
                session
                    .dir
                    .append_jsonl_durable(name, after, journal_io::MAX_BYTES)?;
                appended += 1;
            }
        }
        check()?;
        session.dir.sync_file_durable(name)?;
    }
    let (candidates, records) = indices(session.dir, &[], cancel)?;
    check()?;
    atomic_write(
        &session.dir.path().join("candidate-index.jsonl"),
        candidates.as_bytes(),
    )
    .map_err(StoreError::from)?;
    check()?;
    StateFile::store(&session.dir.path().join("record-index.json"), &records)?;
    check()?;
    episode_io::write(session.dir, &session.name, session.proof, Json::Null)?;
    Ok(appended)
}
fn indices(
    dir: &TrustedDirectory,
    changes: &[Json],
    cancel: &Cancel,
) -> Result<(String, Json), EngineError> {
    let mut candidates = journal_io::rows(dir, "candidate-index.jsonl", cancel)?;
    candidates.extend(journal_io::rows(dir, TARGETS[0], cancel)?);
    for change in changes {
        if file(change)? == TARGETS[0] {
            candidates.push(field(change, "after")?.clone());
        }
    }
    let mut index = String::new();
    for candidate in journal_io::latest(candidates)? {
        if let Some(row) = super::candidate_index::project(&candidate)? {
            index.push_str(&write_json(&row));
            index.push('\n');
            if index.len() > journal_io::MAX_BYTES {
                return Err(StoreError::Corrupt.into());
            }
        }
    }
    let mut records = super::journal_index::project(dir, cancel)?;
    let mut queue = field(&records, "embeddingQueue")?.clone();
    let mut statuses = field(&queue, "statuses")?.clone();
    for change in changes {
        if file(change)? == QUEUE {
            let after = field(change, "after")?;
            let Json::Object(fields) = &mut statuses else {
                return Err(StoreError::Corrupt.into());
            };
            let id = journal_io::id(after)?;
            let status = field(after, "status")?.clone();
            if let Some((_, old)) = fields.iter_mut().find(|(k, _)| k == &id) {
                *old = status;
            } else {
                fields.push((id, status));
            }
        }
    }
    set(&mut queue, "statuses", statuses)?;
    set(&mut records, "embeddingQueue", queue)?;
    if write_json(&records).len() + 1 > journal_io::MAX_BYTES {
        return Err(StoreError::Corrupt.into());
    }
    Ok((index, records))
}

/// All callers share one physical vector file. An unfinished foreign binding must settle
/// before another append changes its frozen prefix; its metadata never grants this caller access.
pub(super) fn guard_other_pending(
    dir: &TrustedDirectory,
    own: &str,
    cancel: &Cancel,
) -> Result<(), EngineError> {
    dir.assert_unchanged()?;
    for (index, entry) in std::fs::read_dir(dir.path())
        .map_err(StoreError::from)?
        .enumerate()
    {
        cancel.check()?;
        if index >= journal_io::MAX_ROWS {
            return Err(StoreError::Unavailable.into());
        }
        let entry = entry.map_err(StoreError::from)?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| StoreError::UntrustedPath)?;
        if name == own || !name.starts_with("native-embedding-pending-") || !name.ends_with(".json")
        {
            continue;
        }
        let value = embedding_vectors::load(dir, &name, cancel)?;
        if field(&value, "plan")? != &Json::Null {
            return Err(StoreError::Busy.into());
        }
    }
    dir.assert_unchanged()?;
    Ok(())
}
