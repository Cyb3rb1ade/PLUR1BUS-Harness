//! Frozen episode publication plans, exact revision replay and checkpoint-last ordering.
use super::{
    derived_fields::{object, validate_object},
    episode_plan, journal_io,
    merged_order::field,
    session_store::Checkpoint,
};
use crate::{
    context::RequestContext,
    contract::{Cancel, EngineError, StoreError},
    store::{directory::TrustedDirectory, state_file::StateFile},
    text::json::{parse_json, write_json, TolerantJsonValue as Json},
};

pub(super) fn read(
    dir: &TrustedDirectory,
    name: &str,
    proof: &Json,
    cancel: &Cancel,
) -> Result<Option<Json>, EngineError> {
    let Some(bytes) = journal_io::bytes(dir, name, cancel)? else {
        return Ok(None);
    };
    let value = parse_json(std::str::from_utf8(&bytes).map_err(|_| StoreError::Corrupt)?)
        .map_err(|_| StoreError::Corrupt)?;
    validate_object(&value)?;
    if field(&value, "ownership") != Some(proof) {
        return Err(StoreError::Corrupt.into());
    }
    match field(&value, "plan") {
        Some(Json::Null) => Ok(None),
        Some(plan @ Json::Object(_)) => {
            validate_object(plan)?;
            Ok(Some(plan.clone()))
        }
        _ => Err(StoreError::Corrupt.into()),
    }
}
pub(super) fn write(
    dir: &TrustedDirectory,
    name: &str,
    proof: &Json,
    plan: Json,
) -> Result<(), EngineError> {
    let value = object(vec![("ownership", proof.clone()), ("plan", plan)]);
    if write_json(&value).len() + 1 > journal_io::MAX_BYTES {
        return Err(StoreError::InvalidInput.into());
    }
    dir.assert_unchanged()?;
    StateFile::store(&dir.path().join(name), &value)?;
    dir.assert_unchanged()?;
    Ok(())
}
pub(super) fn revision(row: &Json) -> Result<u64, StoreError> {
    match field(row, "revision") {
        None => Ok(0),
        Some(Json::Number(n)) => n.parse().map_err(|_| StoreError::Corrupt),
        _ => Err(StoreError::Corrupt),
    }
}
pub(super) fn preflight(
    dir: &TrustedDirectory,
    plan: &Json,
    ctx: &RequestContext,
    cancel: &Cancel,
) -> Result<Vec<Json>, EngineError> {
    episode_plan::verify_sources(plan, dir, ctx, cancel)?;
    let existing = journal_io::rows(dir, "episodes.jsonl", cancel)?;
    for predecessor in episode_plan::array(plan, "predecessors")? {
        validate_object(predecessor)?;
        let id = journal_io::id(predecessor)?;
        let rev = revision(predecessor)?;
        let matches = existing
            .iter()
            .filter(|row| {
                journal_io::id(row).ok().as_ref() == Some(&id) && revision(row).ok() == Some(rev)
            })
            .collect::<Vec<_>>();
        if matches.is_empty()
            || matches.iter().any(|row| {
                !journal_io::owned(row, ctx)
                    || field(predecessor, "digest") != Some(&episode_plan::fingerprint(row))
            })
        {
            return Err(StoreError::Corrupt.into());
        }
    }
    let mut count = existing.len();
    let mut size = journal_io::bytes(dir, "episodes.jsonl", cancel)?.map_or(0, |v| v.len());
    let mut pending = Vec::new();
    let mut planned = std::collections::HashSet::new();
    for row in episode_plan::array(plan, "episodes")? {
        cancel.check()?;
        let id = journal_io::id(row)?;
        if !journal_io::owned(row, ctx) || !planned.insert(id.clone()) {
            return Err(StoreError::Corrupt.into());
        }
        for id in episode_plan::strings(episode_plan::array(row, "memoryIds")?)? {
            if !episode_plan::array(plan, "sources")?
                .iter()
                .any(|source| journal_io::id(source).ok().as_ref() == Some(&id))
            {
                return Err(StoreError::Corrupt.into());
            }
        }
        if field(row, "scope") != Some(&super::derived_fields::text("agent_private")) {
            return Err(StoreError::Corrupt.into());
        }
        let rev = revision(row)?;
        let mut prior = None;
        let mut written = false;
        for old in &existing {
            if journal_io::id(old)? != id {
                continue;
            }
            if !journal_io::owned(old, ctx) {
                return Err(StoreError::InvalidInput.into());
            }
            let old_rev = revision(old)?;
            if old_rev > rev || (old_rev == rev && old != row) {
                return Err(StoreError::Corrupt.into());
            }
            written |= old == row;
            prior = Some(prior.map_or(old_rev, |v: u64| v.max(old_rev)));
        }
        if written {
            continue;
        }
        if (rev == 0 && prior.is_some()) || (rev > 0 && prior != Some(rev - 1)) {
            return Err(StoreError::Corrupt.into());
        }
        count += 1;
        size += write_json(row).len() + 1;
        if count > journal_io::MAX_ROWS || size > journal_io::MAX_BYTES {
            return Err(StoreError::InvalidInput.into());
        }
        pending.push(row.clone());
    }
    Ok(pending)
}
pub(super) struct Publication<'a> {
    pub dir: &'a TrustedDirectory,
    pub name: &'a str,
    pub proof: &'a Json,
    pub ctx: &'a RequestContext,
    pub check: &'a dyn Fn() -> Result<(), EngineError>,
}
pub(super) fn replay(
    publication: &Publication<'_>,
    plan: &Json,
    checkpoint: &mut Checkpoint<'_>,
    cancel: &Cancel,
) -> Result<usize, EngineError> {
    let Publication {
        dir,
        name,
        proof,
        ctx,
        check,
    } = *publication;
    let next = field(plan, "next").ok_or(StoreError::Corrupt)?;
    let previous = field(plan, "previous").ok_or(StoreError::Corrupt)?;
    checkpoint.validate(next)?;
    let committed = checkpoint.state() == next;
    if !committed && checkpoint.state() != previous {
        return Err(StoreError::Corrupt.into());
    }
    let rows = preflight(dir, plan, ctx, cancel)?;
    // A committed checkpoint cannot legitimately reference missing episode rows.
    if committed && !rows.is_empty() {
        return Err(StoreError::Corrupt.into());
    }
    if let Some(bytes) = journal_io::bytes(dir, "episodes.jsonl", cancel)? {
        let complete = bytes.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
        if complete < bytes.len() {
            check()?;
            dir.truncate_jsonl_tail("episodes.jsonl", bytes.len() as u64, complete as u64)?;
        }
    }
    for row in &rows {
        check()?;
        dir.append_jsonl_durable("episodes.jsonl", row, journal_io::MAX_BYTES)?;
    }
    if !episode_plan::array(plan, "episodes")?.is_empty() {
        check()?;
        dir.sync_file_durable("episodes.jsonl")?;
    }
    check()?;
    if !committed {
        checkpoint.commit(next.clone())?;
    }
    check()?;
    write(dir, name, proof, Json::Null)?;
    Ok(rows.len())
}
