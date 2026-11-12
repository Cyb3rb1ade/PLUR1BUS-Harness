//! Authenticated record projection onto held, bounded Node generation sidecars.
use super::{
    merged::{optional, Record, RecordKind},
    merged_order::{field, record_id, Sourced},
};
use crate::{
    contract::StoreError,
    store::{directory::TrustedDirectory, neo_files::Generation, state_file::JsonRecord},
    text::json::{parse_json, TolerantJsonValue as Json},
};
use std::{
    collections::HashMap,
    io::{Read, Seek, SeekFrom},
};
const MAX_BYTES: usize = 64 * 1024 * 1024;
pub(super) fn ordinary(file: &std::fs::File) -> Result<std::fs::Metadata, StoreError> {
    let metadata = file.metadata()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() != 1 {
            return Err(StoreError::UntrustedPath);
        }
    }
    Ok(metadata)
}
fn generation(dir: &TrustedDirectory) -> Result<Option<Generation>, StoreError> {
    let Some(mut file) = optional(dir.open_file("vector-index.json"))? else {
        return Ok(None);
    };
    let before = ordinary(&file)?;
    if before.len() > MAX_BYTES as u64 {
        return Err(StoreError::InvalidInput);
    }
    let mut bytes = Vec::new();
    file.by_ref()
        .take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_BYTES {
        return Err(StoreError::InvalidInput);
    }
    let after = file.metadata()?;
    if before.len() != after.len() || before.modified()? != after.modified()? {
        return Err(StoreError::Busy);
    }
    let json = parse_json(std::str::from_utf8(&bytes).map_err(|_| StoreError::Corrupt)?)
        .map_err(|_| StoreError::Corrupt)?;
    let index = Generation::from_json(json)?;
    let mut seen = std::collections::HashSet::new();
    for (id, _) in &index.entries {
        if !seen.insert(id) {
            return Err(StoreError::Corrupt);
        }
    }
    dir.assert_unchanged()?;
    Ok(Some(index))
}
fn inline(row: &Json) -> Result<Option<Vec<f64>>, StoreError> {
    match field(row, "embedding") {
        None | Some(Json::Null) => Ok(None),
        Some(Json::Array(values)) => values
            .iter()
            .map(|v| {
                let Json::Number(n) = v else {
                    return Err(StoreError::Corrupt);
                };
                n.parse::<f64>()
                    .ok()
                    .filter(|n| n.is_finite())
                    .ok_or(StoreError::Corrupt)
            })
            .collect::<Result<Vec<_>, _>>()
            .map(Some),
        _ => Err(StoreError::Corrupt),
    }
}
fn source_vectors(
    dir: Option<&TrustedDirectory>,
    ids: &[String],
    budget: &mut usize,
) -> Result<HashMap<String, Vec<f64>>, StoreError> {
    let mut out = HashMap::new();
    if ids.is_empty() {
        return Ok(out);
    }
    let Some(dir) = dir else {
        return Ok(out);
    };
    let Some(index) = generation(dir)? else {
        return Ok(out);
    };
    let wanted: std::collections::HashSet<_> = ids.iter().collect();
    let mut entries: Vec<_> = index
        .entries
        .iter()
        .filter(|(id, _)| wanted.contains(id))
        .collect();
    if entries.is_empty() {
        return Ok(out);
    }
    entries.sort_by_key(|(_, e)| e.offset);
    let mut file = optional(dir.open_file(&index.file))?.ok_or(StoreError::Corrupt)?;
    let before = ordinary(&file)?;
    for (id, entry) in entries {
        *budget = budget
            .checked_add(entry.length)
            .ok_or(StoreError::InvalidInput)?;
        if *budget > MAX_BYTES {
            return Err(StoreError::InvalidInput);
        }
        let end = entry
            .offset
            .checked_add(entry.length as u64)
            .ok_or(StoreError::Corrupt)?;
        if end > before.len() {
            return Err(StoreError::Corrupt);
        }
        file.seek(SeekFrom::Start(entry.offset))?;
        let mut bytes = vec![0; entry.length];
        file.read_exact(&mut bytes)
            .map_err(|_| StoreError::Corrupt)?;
        let vector = bytes
            .chunks_exact(4)
            .map(|b| {
                let n = f32::from_le_bytes([b[0], b[1], b[2], b[3]]);
                n.is_finite()
                    .then_some(f64::from(n))
                    .ok_or(StoreError::Corrupt)
            })
            .collect::<Result<Vec<_>, _>>()?;
        out.insert(id.clone(), vector);
    }
    let after = file.metadata()?;
    if before.len() != after.len() || before.modified()? != after.modified()? {
        return Err(StoreError::Busy);
    }
    dir.assert_unchanged()?;
    Ok(out)
}
pub(super) fn attach(
    kind: RecordKind,
    rows: Vec<Sourced>,
    canonical: Option<&TrustedDirectory>,
    legacy: Option<&TrustedDirectory>,
) -> Result<Vec<Record>, StoreError> {
    let vectors = matches!(
        kind,
        RecordKind::Turns | RecordKind::Candidates | RecordKind::Behavior
    );
    let ids: Vec<_> = rows
        .iter()
        .map(|row| {
            if !vectors || field(&row.metadata, "embedding").is_some() {
                return None;
            }
            let id = record_id(&row.metadata)?;
            let utf8 = id.to_utf8_lossy();
            (!utf8.is_empty() && utf8.encode_utf16().eq(id.as_utf16_units().iter().copied()))
                .then_some(utf8)
        })
        .collect();
    let collect = |old| {
        rows.iter()
            .zip(&ids)
            .filter(|(row, _)| row.legacy == old)
            .filter_map(|(_, id)| id.clone())
            .collect::<Vec<_>>()
    };
    let mut budget = 0;
    let new_vectors = source_vectors(canonical, &collect(false), &mut budget)?;
    let old_vectors = source_vectors(legacy, &collect(true), &mut budget)?;
    rows.into_iter()
        .zip(ids)
        .map(|(row, id)| {
            let embedding = if let Some(id) = id {
                if row.legacy {
                    old_vectors.get(&id)
                } else {
                    new_vectors.get(&id)
                }
                .cloned()
            } else {
                inline(&row.metadata)?
            };
            Ok(Record {
                metadata: row.metadata,
                embedding,
            })
        })
        .collect()
}
