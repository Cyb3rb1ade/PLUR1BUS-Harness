//! Exact binary append and vector-space binding for the Node sidecar layout.
use super::{
    derived_fields::{field, object, set, str_field, text},
    journal_io,
};
use crate::{
    contract::{Cancel, EngineError, StoreError},
    store::{
        directory::TrustedDirectory,
        neo_files::{Generation, VectorEntry},
        state_file::{JsonRecord, StateFile},
    },
    text::{
        js::JsString,
        json::{parse_json, TolerantJsonValue as Json},
    },
};
use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::{Digest, Sha256};
const MANIFEST: &str = "vector-index.json";
const SPACE: &str = "native-vector-space.json";

pub(super) fn load(
    dir: &TrustedDirectory,
    name: &str,
    cancel: &Cancel,
) -> Result<Json, EngineError> {
    journal_io::bytes(dir, name, cancel)?
        .map(|b| {
            parse_json(std::str::from_utf8(&b).map_err(|_| StoreError::Corrupt)?)
                .map_err(|_| StoreError::Corrupt.into())
        })
        .unwrap_or(Ok(Json::Null))
}
fn marker(proof: &Json, space: &str, dimensions: usize) -> Result<Json, StoreError> {
    let mut out = object(vec![
        ("version", Json::Number("1".into())),
        ("spaceId", text(space)),
        ("dimensions", number(dimensions)),
    ]);
    for key in [
        "workspaceIdentity",
        "workspaceDirectory",
        "neoRoot",
        "workspaceFileIdentity",
        "neoRootFileIdentity",
    ] {
        set(&mut out, key, field(proof, key)?.clone())?;
    }
    Ok(out)
}
pub(super) fn number(n: usize) -> Json {
    Json::Number(n.to_string())
}
pub(super) fn unsigned(value: &Json) -> Result<usize, StoreError> {
    if let Json::Number(n) = value {
        n.parse().map_err(|_| StoreError::Corrupt)
    } else {
        Err(StoreError::Corrupt)
    }
}
pub(super) struct Snapshot {
    old_manifest: Json,
    old_space: Json,
    space: Json,
    generation: Generation,
    prefix: Vec<u8>,
    suffix: Vec<u8>,
}
impl Snapshot {
    pub(super) fn open(
        dir: &TrustedDirectory,
        proof: &Json,
        space: &str,
        dimensions: usize,
        cancel: &Cancel,
    ) -> Result<Self, EngineError> {
        if dimensions == 0 || dimensions > 65536 {
            return Err(StoreError::InvalidInput.into());
        }
        let old_manifest = load(dir, MANIFEST, cancel)?;
        let generation = if old_manifest == Json::Null {
            Generation::new(0)
        } else {
            Generation::from_json(old_manifest.clone())?
        };
        let prefix = journal_io::bytes(dir, &generation.file, cancel)?.unwrap_or_default();
        let old_space = load(dir, SPACE, cancel)?;
        let space = marker(proof, space, dimensions)?;
        if old_space != space
            && (old_space != Json::Null || !generation.entries.is_empty() || !prefix.is_empty())
        {
            return Err(StoreError::IdentityMismatch.into());
        }
        if prefix.len() % 4 != 0 || generation.entries.len() > journal_io::MAX_ROWS {
            return Err(StoreError::Corrupt.into());
        }
        let mut ids = std::collections::HashSet::new();
        for (id, entry) in &generation.entries {
            let offset = usize::try_from(entry.offset).map_err(|_| StoreError::Corrupt)?;
            if !ids.insert(id)
                || entry.dims != dimensions
                || offset % 4 != 0
                || offset
                    .checked_add(entry.length)
                    .is_none_or(|n| n > prefix.len())
            {
                return Err(StoreError::Corrupt.into());
            }
        }
        Ok(Self {
            old_manifest,
            old_space,
            space,
            generation,
            prefix,
            suffix: vec![],
        })
    }
    pub(super) fn push(&mut self, id: &JsString, vector: &[f32]) -> Result<(), StoreError> {
        let id_utf8 = id.to_utf8_lossy();
        if JsString::from(id_utf8.as_str()) != *id
            || vector.is_empty()
            || vector.iter().any(|v| !v.is_finite())
        {
            return Err(StoreError::InvalidInput);
        }
        let offset = self
            .prefix
            .len()
            .checked_add(self.suffix.len())
            .ok_or(StoreError::InvalidInput)?;
        let length = vector
            .len()
            .checked_mul(4)
            .ok_or(StoreError::InvalidInput)?;
        if offset
            .checked_add(length)
            .is_none_or(|n| n > journal_io::MAX_BYTES)
        {
            return Err(StoreError::InvalidInput);
        }
        let entry = VectorEntry {
            offset: offset as u64,
            length,
            dims: vector.len(),
        };
        if let Some((_, old)) = self
            .generation
            .entries
            .iter_mut()
            .find(|(key, _)| key == &id_utf8)
        {
            *old = entry;
        } else {
            self.generation.entries.push((id_utf8, entry));
        }
        for v in vector {
            self.suffix.extend_from_slice(&v.to_le_bytes());
        }
        Ok(())
    }
    pub(super) fn freeze(self) -> Result<Json, StoreError> {
        if self.generation.entries.len() > journal_io::MAX_ROWS {
            return Err(StoreError::InvalidInput);
        }
        if self.suffix.is_empty() {
            return Ok(Json::Null);
        }
        Ok(object(vec![
            ("oldManifest", self.old_manifest),
            ("manifest", self.generation.to_json()?),
            ("oldSpace", self.old_space),
            ("space", self.space),
            ("prefixLen", number(self.prefix.len())),
            (
                "prefixSha",
                text(&format!("{:x}", Sha256::digest(&self.prefix))),
            ),
            ("suffix", text(&STANDARD.encode(self.suffix))),
        ]))
    }
}
fn decode(plan: &Json) -> Result<(Generation, usize, [u8; 32], Vec<u8>), StoreError> {
    let generation = Generation::from_json(field(plan, "manifest")?.clone())?;
    let prefix = unsigned(field(plan, "prefixLen")?)?;
    let hash = str_field(plan, "prefixSha")?.to_utf8_lossy();
    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(StoreError::Corrupt);
    }
    let mut digest = [0; 32];
    for (i, pair) in hash.as_bytes().chunks_exact(2).enumerate() {
        digest[i] = u8::from_str_radix(
            std::str::from_utf8(pair).map_err(|_| StoreError::Corrupt)?,
            16,
        )
        .map_err(|_| StoreError::Corrupt)?;
    }
    let suffix = STANDARD
        .decode(str_field(plan, "suffix")?.to_utf8_lossy())
        .map_err(|_| StoreError::Corrupt)?;
    if prefix % 4 != 0
        || suffix.is_empty()
        || suffix.len() % 4 != 0
        || prefix
            .checked_add(suffix.len())
            .is_none_or(|n| n > journal_io::MAX_BYTES)
        || suffix
            .chunks_exact(4)
            .any(|b| !f32::from_le_bytes([b[0], b[1], b[2], b[3]]).is_finite())
    {
        return Err(StoreError::Corrupt);
    }
    Ok((generation, prefix, digest, suffix))
}
pub(super) fn verify(
    dir: &TrustedDirectory,
    proof: &Json,
    plan: &Json,
    cancel: &Cancel,
) -> Result<(), EngineError> {
    if plan == &Json::Null {
        return Ok(());
    }
    let (generation, prefix, digest, suffix) = decode(plan)?;
    let old_space = field(plan, "oldSpace")?;
    let old_manifest = field(plan, "oldManifest")?;
    let old = if old_manifest == &Json::Null {
        Generation::new(0)
    } else {
        Generation::from_json(old_manifest.clone())?
    };
    let space = field(plan, "space")?;
    if old.file != generation.file
        || (old_space != space
            && (old_space != &Json::Null || !old.entries.is_empty() || prefix != 0))
    {
        return Err(StoreError::IdentityMismatch.into());
    }
    for (_, entry) in &old.entries {
        if usize::try_from(entry.offset)
            .ok()
            .and_then(|n| n.checked_add(entry.length))
            .is_none_or(|n| n > prefix)
        {
            return Err(StoreError::Corrupt.into());
        }
    }
    let dimensions = unsigned(field(space, "dimensions")?)?;
    let identity = str_field(space, "spaceId")?.to_utf8_lossy();
    if identity.len() != 64
        || !identity.bytes().all(|b| b.is_ascii_hexdigit())
        || marker(proof, &identity, dimensions)? != *space
        || dimensions == 0
    {
        return Err(StoreError::Corrupt.into());
    }
    for (name, before, after) in [
        (MANIFEST, "oldManifest", "manifest"),
        (SPACE, "oldSpace", "space"),
    ] {
        let current = load(dir, name, cancel)?;
        if current != *field(plan, before)? && current != *field(plan, after)? {
            return Err(StoreError::Corrupt.into());
        }
    }
    let bytes = journal_io::bytes(dir, &generation.file, cancel)?.unwrap_or_default();
    if bytes.len() < prefix
        || bytes.len() > prefix + suffix.len()
        || <[u8; 32]>::from(Sha256::digest(&bytes[..prefix])) != digest
        || bytes[prefix..] != suffix[..bytes.len() - prefix]
    {
        return Err(StoreError::Corrupt.into());
    }
    let mut ids = std::collections::HashSet::new();
    for (id, entry) in &generation.entries {
        let offset = usize::try_from(entry.offset).map_err(|_| StoreError::Corrupt)?;
        if !ids.insert(id)
            || entry.dims != dimensions
            || offset % 4 != 0
            || offset
                .checked_add(entry.length)
                .is_none_or(|n| n > prefix + suffix.len())
        {
            return Err(StoreError::Corrupt.into());
        }
    }
    Ok(())
}
pub(super) fn publish(
    dir: &TrustedDirectory,
    plan: &Json,
    cancel: &Cancel,
    check: &dyn Fn() -> Result<(), EngineError>,
) -> Result<(), EngineError> {
    if plan == &Json::Null {
        return Ok(());
    }
    let (generation, prefix, digest, suffix) = decode(plan)?;
    check()?;
    dir.append_binary_replay_durable(
        &generation.file,
        prefix as u64,
        &digest,
        &suffix,
        journal_io::MAX_BYTES,
        cancel,
    )?;
    // No fresh row is visible until both the model identity and manifest are durable.
    for (name, key) in [(SPACE, "space"), (MANIFEST, "manifest")] {
        check()?;
        StateFile::store(&dir.path().join(name), field(plan, key)?)?;
        dir.assert_unchanged()?;
    }
    Ok(())
}

/// Ensure a saved manifest changes only the exact fresh targets of this publication.
pub(super) fn verify_changes(plan: &Json, changes: &[Json]) -> Result<(), StoreError> {
    let targets: Vec<_> = changes
        .iter()
        .filter(|c| {
            str_field(c, "file").is_ok_and(|f| f != &JsString::from(super::embedding_plan::QUEUE))
        })
        .collect();
    if plan == &Json::Null {
        return if targets.is_empty() {
            Ok(())
        } else {
            Err(StoreError::Corrupt)
        };
    }
    if targets.is_empty() {
        return Err(StoreError::Corrupt);
    }
    let (generation, prefix, _, suffix) = decode(plan)?;
    let old = field(plan, "oldManifest")?;
    let previous = if old == &Json::Null {
        Generation::new(0)
    } else {
        Generation::from_json(old.clone())?
    };
    if previous.file != generation.file {
        return Err(StoreError::Corrupt);
    }
    let mut changed = std::collections::HashSet::new();
    for target in targets {
        let after = field(target, "after")?;
        let id = journal_io::id(after)?.to_utf8_lossy();
        if !changed.insert(id.clone()) {
            return Err(StoreError::Corrupt);
        }
        let (_, entry) = generation
            .entries
            .iter()
            .find(|(k, _)| k == &id)
            .ok_or(StoreError::Corrupt)?;
        let offset = usize::try_from(entry.offset).map_err(|_| StoreError::Corrupt)?;
        if offset < prefix
            || offset
                .checked_add(entry.length)
                .is_none_or(|n| n > prefix + suffix.len())
            || unsigned(field(after, "embeddingDims")?)? != entry.dims
        {
            return Err(StoreError::Corrupt);
        }
    }
    for (id, entry) in &previous.entries {
        if !changed.contains(id)
            && generation
                .entries
                .iter()
                .find(|(k, _)| k == id)
                .map(|(_, v)| v)
                != Some(entry)
        {
            return Err(StoreError::Corrupt);
        }
    }
    for (id, _) in &generation.entries {
        if !changed.contains(id) && !previous.entries.iter().any(|(k, _)| k == id) {
            return Err(StoreError::Corrupt);
        }
    }
    Ok(())
}
