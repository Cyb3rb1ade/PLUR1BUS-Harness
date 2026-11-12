//! Emergency append bound, separate from value-based scheduled retention.
use super::{append_cap_io as io, journal_io};
use crate::{
    contract::{Cancel, EngineError, StoreError},
    store::directory::{regular_file_identity, TrustedDirectory},
    text::json::parse_json,
};
use flate2::{write::GzEncoder, Compression};
use sha2::{Digest, Sha256};
use std::io::Write;

pub(super) const FILES: [&str; 11] = [
    "turn-journal.jsonl",
    "memory-candidates.jsonl",
    "reaction-ledger.jsonl",
    "behavior-cards.jsonl",
    "embedding-queue.jsonl",
    "dream-diary.jsonl",
    "episodes.jsonl",
    "memory-graph.jsonl",
    "pattern-analysis.jsonl",
    "retrieval-ledger.jsonl",
    "reconsolidation-events.jsonl",
];

/// Caller holds the workspace writer leases, authorizes the complete source and has settled
/// receipts referring to it. This helper provides durable bytes, never caller authority.
/// Immutable content-addressed gzip members make a retry after archive publication idempotent.
/// Monthly value-based archives belong to the separate RY-A maintenance protocol.
pub(super) fn compact(
    dir: &TrustedDirectory,
    name: &str,
    source: &super::append_source::SourceProof,
    max_records: usize,
    cancel: &Cancel,
    check: &dyn Fn() -> Result<(), EngineError>,
) -> Result<usize, EngineError> {
    check()?;
    if !FILES.contains(&name) || !(500..=journal_io::MAX_ROWS).contains(&max_records) {
        return Err(StoreError::InvalidInput.into());
    }
    let before = journal_io::bytes(dir, name, cancel)?.ok_or(StoreError::UntrustedPath)?;
    source.verify(dir, name, &before)?;
    let identity = source.identity;
    let modified = source
        .modified
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| StoreError::Corrupt)?;
    let cut = prefix_end(&before, max_records, cancel)?;
    let Some((cut, removed)) = cut else {
        return Ok(0);
    };
    let mut gzip = GzEncoder::new(Vec::new(), Compression::default());
    for chunk in before[..cut].chunks(65536) {
        cancel.check()?;
        gzip.write_all(chunk).map_err(StoreError::from)?;
    }
    let compressed = gzip.finish().map_err(StoreError::from)?;
    // Compression can expand small/incompressible data. Keep the existing acquisition bound.
    if compressed.len() > journal_io::MAX_BYTES {
        return Err(StoreError::Unavailable.into());
    }
    check()?;
    source.verify(
        dir,
        name,
        &journal_io::bytes(dir, name, cancel)?.ok_or(StoreError::UntrustedPath)?,
    )?;
    let archive = dir.create_child("archives")?;
    archive.restrict_private()?;
    // Bind the occurrence, not just its payload: a later physical live generation may
    // legitimately evict identical bytes. A retry retains this inode/revision and key.
    let mut occurrence = Sha256::new();
    occurrence.update(identity.0.to_le_bytes());
    occurrence.update(identity.1.to_le_bytes());
    occurrence.update(modified.as_secs().to_le_bytes());
    occurrence.update(modified.subsec_nanos().to_le_bytes());
    occurrence.update((cut as u64).to_le_bytes());
    occurrence.update(&before);
    let archive_name = format!("{name}.cap-{:x}.gz", occurrence.finalize());
    let archive_identity =
        io::publish_archive(&archive, &archive_name, &compressed, cancel, check)?;
    // There is no destructive operation until the complete archived prefix is synced.
    let guard = || {
        check()?;
        archive.assert_unchanged()?;
        if regular_file_identity(&archive.open_file(&archive_name)?)? != archive_identity
            || journal_io::bytes(&archive, &archive_name, cancel)?.as_deref()
                != Some(compressed.as_slice())
        {
            return Err(StoreError::UntrustedPath.into());
        }
        Ok(())
    };
    io::replace_live(dir, name, identity, &before, &before[cut..], cancel, &guard)?;
    Ok(removed)
}

fn prefix_end(
    bytes: &[u8],
    max: usize,
    cancel: &Cancel,
) -> Result<Option<(usize, usize)>, EngineError> {
    if !bytes.is_empty() && !bytes.ends_with(b"\n") {
        return Err(StoreError::Corrupt.into());
    }
    let mut ends = Vec::new();
    let mut end = 0;
    for line in bytes.split_inclusive(|b| *b == b'\n') {
        cancel.check()?;
        end += line.len();
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let row = parse_json(std::str::from_utf8(line).map_err(|_| StoreError::Corrupt)?)
            .map_err(|_| StoreError::Corrupt)?;
        super::derived_fields::validate_object(&row)?;
        ends.push(end);
        if ends.len() > journal_io::MAX_ROWS {
            return Err(StoreError::Unavailable.into());
        }
    }
    Ok((ends.len() > max).then(|| (ends[ends.len() - max - 1], ends.len() - max)))
}

#[cfg(test)]
#[path = "../../tests/support/neo_append_cap.rs"]
mod tests;
