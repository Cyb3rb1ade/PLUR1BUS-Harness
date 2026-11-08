//! Bounded C4 publication: exact pre-append fingerprints, durable appends and index refresh.
use super::{
    derived_fields::{field, object, str_field, text, validate_object},
    journal_io,
    merged::{optional, Layout},
    revision_plan,
};
use crate::{
    context::RequestContext,
    contract::{Cancel, EngineError, StoreError},
    store::{atomic_write::atomic_write, directory::TrustedDirectory, state_file::StateFile},
    text::{
        js::JsString,
        json::{parse_json, write_json, TolerantJsonValue as Json},
    },
};
use sha2::{Digest, Sha256};
const STATE: &str = "native-revision-state.json";
pub(super) const MAX_RECORD: usize = 1024 * 1024;
pub(super) const TARGETS: [&str; 2] = ["behavior-cards.jsonl", "memory-candidates.jsonl"];
const AUDIT: &str = "destructive-ops.jsonl";
const QUEUE: &str = "embedding-queue.jsonl";
fn hash(bytes: &[u8]) -> Json {
    text(&format!("{:x}", Sha256::digest(bytes)))
}

pub(super) fn strict(
    dir: &TrustedDirectory,
    name: &str,
    cancel: &Cancel,
) -> Result<Vec<Json>, EngineError> {
    if journal_io::bytes(dir, name, cancel)?.is_some_and(|b| !b.is_empty() && !b.ends_with(b"\n")) {
        return Err(StoreError::Corrupt.into());
    }
    journal_io::rows(dir, name, cancel)
}
pub(super) fn current(
    dir: &TrustedDirectory,
    proof: &Json,
    ctx: &RequestContext,
    id: &JsString,
    cancel: &Cancel,
) -> Result<(String, Json), EngineError> {
    let root = TrustedDirectory::open(std::path::Path::new(
        &str_field(proof, "neoRoot")?.to_utf8_lossy(),
    ))?;
    let parent = root.open_child("workspaces")?;
    let legacy = Layout::for_key(&ctx.workspace_key)
        .legacy
        .map(|name| optional(parent.open_child(&name)))
        .transpose()?
        .flatten();
    for (index, file) in TARGETS.into_iter().enumerate() {
        let mut rows = if let Some(legacy) = &legacy {
            strict(legacy, file, cancel)?
        } else {
            vec![]
        };
        // Only complete source rows may participate in recovery. The one exact planned partial
        // tail is verified separately before any mutation; it is never treated as a revision.
        rows.extend(journal_io::rows(dir, file, cancel)?);
        let latest = journal_io::latest(rows)?;
        if let Some(row) = latest
            .into_iter()
            .find(|row| journal_io::id(row).ok().as_ref() == Some(id))
        {
            if let Some(legacy) = &legacy {
                legacy.assert_unchanged()?;
            }
            root.assert_unchanged()?;
            parent.assert_unchanged()?;
            return Ok((
                if index == 0 { "behavior" } else { "candidates" }.into(),
                row,
            ));
        }
    }
    Err(StoreError::InvalidInput.into())
}
pub(super) fn state(dir: &TrustedDirectory, cancel: &Cancel) -> Result<Option<Json>, EngineError> {
    Ok(state_with_size(dir, cancel)?.map(|(value, _)| value))
}
pub(super) fn state_with_size(
    dir: &TrustedDirectory,
    cancel: &Cancel,
) -> Result<Option<(Json, usize)>, EngineError> {
    let Some(file) = optional(dir.open_file(STATE))? else {
        return Ok(None);
    };
    super::vectors::ordinary(&file)?;
    if file.metadata().map_err(StoreError::from)?.len() > (8 * MAX_RECORD) as u64 {
        return Err(StoreError::Corrupt.into());
    }
    let Some(bytes) = journal_io::bytes(dir, STATE, cancel)? else {
        return Ok(None);
    };
    if bytes.len() > 8 * MAX_RECORD {
        return Err(StoreError::Corrupt.into());
    }
    let value = parse_json(std::str::from_utf8(&bytes).map_err(|_| StoreError::Corrupt)?)
        .map_err(|_| StoreError::Corrupt)?;
    validate_object(&value)?;
    Ok(Some((value, bytes.len())))
}
/// Follow-up work must not observe a prepared but unaudited human revision as ready.
pub(super) fn guard_pending(dir: &TrustedDirectory, cancel: &Cancel) -> Result<(), EngineError> {
    crate::ops::interference_state::guard_pending(dir, cancel)?;
    if let Some(value) = state(dir, cancel)? {
        if !super::derived_fields::bool_field(&value, "complete")? {
            return Err(StoreError::Busy.into());
        }
    }
    Ok(())
}
pub(super) fn save(dir: &TrustedDirectory, value: &Json) -> Result<(), EngineError> {
    if write_json(value).len() + 1 > 8 * MAX_RECORD {
        return Err(StoreError::InvalidInput.into());
    }
    dir.assert_unchanged()?;
    StateFile::store(&dir.path().join(STATE), value)?;
    dir.assert_unchanged()?;
    Ok(())
}
pub(super) fn append_plan(
    dir: &TrustedDirectory,
    file: &str,
    row: Json,
    cancel: &Cancel,
) -> Result<Json, EngineError> {
    let rows = strict(dir, file, cancel)?;
    let bytes = journal_io::bytes(dir, file, cancel)?.unwrap_or_default();
    let added = if row == Json::Null {
        0
    } else {
        write_json(&row).len() + 1
    };
    if added + 1 > MAX_RECORD
        || bytes.len() + added > journal_io::MAX_BYTES
        || rows.len() + usize::from(added > 0) > journal_io::MAX_ROWS
    {
        return Err(StoreError::InvalidInput.into());
    }
    Ok(object(vec![
        ("file", text(file)),
        ("length", Json::Number(bytes.len().to_string())),
        ("prefix", hash(&bytes)),
        ("row", row),
    ]))
}
fn appends(state: &Json) -> Result<&[Json], StoreError> {
    let Json::Array(appends) = field(state, "appends")? else {
        return Err(StoreError::Corrupt);
    };
    if appends.len() != 3 {
        return Err(StoreError::Corrupt);
    }
    Ok(appends)
}
fn destination<'a>(
    dir: &'a TrustedDirectory,
    audit: &'a TrustedDirectory,
    state: &Json,
    index: usize,
) -> Result<(&'a TrustedDirectory, &'static str), StoreError> {
    match index {
        0 => Ok((dir, revision_plan::target(state)?)),
        1 => Ok((audit, AUDIT)),
        2 => Ok((dir, QUEUE)),
        _ => Err(StoreError::Corrupt),
    }
}
struct Progress {
    length: usize,
    prefix: usize,
    complete: bool,
}
fn inspect(
    dir: &TrustedDirectory,
    file: &str,
    append: &Json,
    cancel: &Cancel,
) -> Result<Progress, EngineError> {
    validate_object(append)?;
    if field(append, "file")? != &text(file) {
        return Err(StoreError::Corrupt.into());
    }
    let Json::Number(length) = field(append, "length")? else {
        return Err(StoreError::Corrupt.into());
    };
    let prefix: usize = length.parse().map_err(|_| StoreError::Corrupt)?;
    let bytes = journal_io::bytes(dir, file, cancel)?.unwrap_or_default();
    if prefix > bytes.len() || hash(&bytes[..prefix]) != *field(append, "prefix")? {
        return Err(StoreError::Corrupt.into());
    }
    let row = field(append, "row")?;
    if row == &Json::Null {
        let _ = strict(dir, file, cancel)?;
        return Ok(Progress {
            length: prefix,
            prefix,
            complete: true,
        });
    }
    validate_object(row)?;
    let line = format!("{}\n", write_json(row));
    if line.len() + 1 > MAX_RECORD || prefix + line.len() > journal_io::MAX_BYTES {
        return Err(StoreError::Corrupt.into());
    }
    let suffix = &bytes[prefix..];
    let complete = suffix.starts_with(line.as_bytes());
    if !complete && !line.as_bytes().starts_with(suffix) {
        return Err(StoreError::Corrupt.into());
    }
    if complete {
        let _ = strict(dir, file, cancel)?;
    }
    Ok(Progress {
        length: bytes.len(),
        prefix,
        complete,
    })
}
pub(super) fn preflight(
    dir: &TrustedDirectory,
    audit: &TrustedDirectory,
    state: &Json,
    cancel: &Cancel,
) -> Result<(), EngineError> {
    for (i, append) in appends(state)?.iter().enumerate() {
        let (directory, file) = destination(dir, audit, state, i)?;
        let _ = inspect(directory, file, append, cancel)?;
    }
    // Validate index destinations and all input journals before publication, without mutating.
    let extra = (revision_plan::target(state)? == TARGETS[1])
        .then(|| field(&appends(state)?[0], "row"))
        .transpose()?;
    let _ = candidate_projection(dir, extra, cancel)?;
    let _ = super::journal_index::project(dir, cancel)?;
    Ok(())
}
pub(super) fn publish(
    dir: &TrustedDirectory,
    audit: &TrustedDirectory,
    state: &Json,
    index: usize,
    cancel: &Cancel,
    check: &dyn Fn() -> Result<(), EngineError>,
) -> Result<(), EngineError> {
    let append = &appends(state)?[index];
    let (directory, file) = destination(dir, audit, state, index)?;
    let progress = inspect(directory, file, append, cancel)?;
    if field(append, "row")? == &Json::Null {
        return Ok(());
    }
    if !progress.complete {
        check()?;
        if progress.length != progress.prefix {
            directory.truncate_jsonl_tail(file, progress.length as u64, progress.prefix as u64)?;
        }
        check()?;
        directory.append_jsonl_durable(file, field(append, "row")?, MAX_RECORD)?;
    }
    check()?;
    directory.sync_file_durable(file)?;
    Ok(())
}
fn candidate_projection(
    dir: &TrustedDirectory,
    extra: Option<&Json>,
    cancel: &Cancel,
) -> Result<String, EngineError> {
    let mut candidates = strict(dir, "candidate-index.jsonl", cancel)?;
    candidates.extend(if extra.is_some() {
        // Preflight already proved that any partial tail is this exact prepared append.
        journal_io::rows(dir, TARGETS[1], cancel)?
    } else {
        strict(dir, TARGETS[1], cancel)?
    });
    candidates.extend(extra.cloned());
    let candidates = journal_io::latest(candidates)?;
    if candidates.len() > journal_io::MAX_ROWS {
        return Err(StoreError::Unavailable.into());
    }
    let mut output = String::new();
    for row in candidates {
        if let Some(row) = super::candidate_index::project(&row)? {
            output.push_str(&write_json(&row));
            output.push('\n');
            if output.len() > journal_io::MAX_BYTES {
                return Err(StoreError::Corrupt.into());
            }
        }
    }
    Ok(output)
}
pub(super) fn indices(
    dir: &TrustedDirectory,
    cancel: &Cancel,
    check: &dyn Fn() -> Result<(), EngineError>,
) -> Result<(), EngineError> {
    let output = candidate_projection(dir, None, cancel)?;
    let records = super::journal_index::project(dir, cancel)?;
    if write_json(&records).len() + 1 > journal_io::MAX_BYTES {
        return Err(StoreError::Corrupt.into());
    }
    check()?;
    atomic_write(&dir.path().join("candidate-index.jsonl"), output.as_bytes())
        .map_err(StoreError::from)?;
    check()?;
    StateFile::store(&dir.path().join("record-index.json"), &records)?;
    dir.assert_unchanged()?;
    Ok(())
}
