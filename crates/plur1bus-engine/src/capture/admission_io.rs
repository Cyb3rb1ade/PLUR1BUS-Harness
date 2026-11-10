//! Bounded private capture records, version validation and canonical row fingerprints.
use super::*;
use crate::store::atomic_write::atomic_write;
use std::io::Read;
pub(super) fn read(
    dir: &TrustedDirectory,
    name: &str,
    cancel: &Cancel,
) -> Result<Option<Record>, EngineError> {
    let mut budget = MAX_BYTES;
    read_with_budget(dir, name, cancel, &mut budget)
}
pub(super) fn read_with_budget(
    dir: &TrustedDirectory,
    name: &str,
    cancel: &Cancel,
    budget: &mut usize,
) -> Result<Option<Record>, EngineError> {
    let mut file = match dir.open_file(name) {
        Err(StoreError::Io {
            kind: std::io::ErrorKind::NotFound,
        }) => return Ok(None),
        result => result?,
    };
    let identity = crate::store::directory::regular_file_identity(&file)?;
    let meta = file.metadata().map_err(StoreError::from)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.nlink() != 1 {
            return Err(StoreError::UntrustedPath.into());
        }
    }
    if meta.len() > (*budget).min(MAX_BYTES) as u64 {
        return Err(StoreError::Corrupt.into());
    }
    let mut bytes = Vec::new();
    let mut chunk = [0; 65536];
    loop {
        cancel.check()?;
        let n = file.read(&mut chunk).map_err(StoreError::from)?;
        if n == 0 {
            break;
        }
        if bytes.len() + n > MAX_BYTES {
            return Err(StoreError::Corrupt.into());
        }
        *budget = budget.checked_sub(n).ok_or(StoreError::Corrupt)?;
        bytes.extend_from_slice(&chunk[..n]);
    }
    if crate::store::directory::regular_file_identity(&dir.open_file(name)?)? != identity {
        return Err(StoreError::UntrustedPath.into());
    }
    dir.assert_unchanged()?;
    let value = crate::text::json::parse_exact(
        std::str::from_utf8(&bytes).map_err(|_| StoreError::Corrupt)?,
    )
    .map_err(|_| StoreError::Corrupt)?;
    let record: Envelope = serde_json::from_value(value).map_err(|_| StoreError::Corrupt)?;
    Ok(record.record)
}
pub(super) fn write(
    dir: &TrustedDirectory,
    name: &str,
    value: &Envelope,
) -> Result<(), EngineError> {
    let bytes = serde_json::to_vec(value).map_err(|_| StoreError::InvalidInput)?;
    if bytes.len() > MAX_BYTES {
        return Err(StoreError::InvalidInput.into());
    }
    dir.assert_unchanged()?;
    atomic_write(&dir.path().join(name), &bytes).map_err(StoreError::from)?;
    dir.assert_unchanged()?;
    Ok(())
}

fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub(super) fn validate(record: &Record) -> Result<(), EngineError> {
    let primary = record.phase == Phase::Primary;
    let order = record
        .row_order
        .iter()
        .collect::<std::collections::BTreeSet<_>>();
    if (primary && !order.is_empty())
        || (!primary
            && (order.len() != record.row_order.len() || order != record.rows.keys().collect()))
    {
        return Err(StoreError::Corrupt.into());
    }
    if record.result.as_ref().is_some_and(|result| {
        result.stored.as_u64() != Some(record.rows.len() as u64)
            || result.skipped.as_u64().is_none()
            || result
                .reason
                .as_deref()
                .is_some_and(|reason| reason != "capture-incomplete")
            || result.diagnostics.is_some()
    }) {
        return Err(StoreError::Corrupt.into());
    }
    if record.version != 1
        || !hash(&record.config)
        || !hash(&record.space)
        || !hash(&record.key)
        || record.key != turn_key_of(&record.turn)?
        || record.at_ms.unsigned_abs() > 9_007_199_254_740_991
        || primary != record.post_at_ms.is_none()
        || primary != record.result.is_none()
        || record
            .post_at_ms
            .is_some_and(|n| n.unsigned_abs() > 9_007_199_254_740_991)
        || record.rows.len() > 10_000
        || record.rows.iter().any(|(id, fingerprint)| {
            id.len() != 36 || uuid::Uuid::parse_str(id).is_err() || !hash(fingerprint)
        })
        || record.reminders.len() > 8
        || record.reminders.keys().any(|p| *p >= 8)
        || (primary
            && (record.classifier_started
                || record.classifier_done
                || record.neo_started
                || record.neo_done
                || !record.reminders.is_empty()))
        || (record.classifier_done && !record.classifier_started)
        || (record.neo_done && !record.neo_started)
        || (primary && !record.post_skipped.is_empty())
        || record.post_skipped.len() > 2
        || record
            .post_skipped
            .iter()
            .any(|reason| !super::super::pipeline::is_terminal_reason(reason))
    {
        return Err(StoreError::Corrupt.into());
    }
    Ok(())
}

pub(in crate::capture) fn row_digest(
    row: &crate::contract::MemoryRow,
) -> Result<String, StoreError> {
    Ok(format!(
        "{:x}",
        Sha256::digest(crate::capture::row_builder::to_node_json(row)?.as_bytes())
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[allow(clippy::unwrap_used, reason = "test assertions")]
    fn inventory_budget_is_shared_across_actual_file_reads() {
        let root = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let dir = TrustedDirectory::open(root.path()).unwrap();
        let bytes = b"{\"record\":null}";
        std::fs::write(root.path().join("one.json"), bytes).unwrap();
        std::fs::write(root.path().join("two.json"), bytes).unwrap();
        let mut budget = bytes.len() * 2 - 1;
        assert!(
            read_with_budget(&dir, "one.json", &Cancel::never(), &mut budget)
                .unwrap()
                .is_none()
        );
        assert_eq!(budget, bytes.len() - 1);
        assert!(read_with_budget(&dir, "two.json", &Cancel::never(), &mut budget).is_err());
    }
}
