//! Generated output admission and publication over private storage ports.
use crate::{
    jobs::{Error, Result},
    units::{self, Units},
    uploads::{self, Entry, Health, IndexRecord, Upload},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::Instant;

mod video_store;
pub use video_store::{Video, VideoControl, VideoStage};

const MANIFEST: &str = "manifest.json";
const SCHEMA: &str = "media.output/1";
const MAX_MANIFEST_BYTES: usize = 1024 * 1024;

#[derive(Clone, Copy)]
pub enum Namespace {
    Output,
    Upload,
}

pub enum Destination<'a> {
    Output(&'a str),
    Upload { id: &'a str, index: IndexRecord },
}

impl Destination<'_> {
    fn location(&self) -> (Namespace, &str) {
        match self {
            Self::Output(id) => (Namespace::Output, id),
            Self::Upload { id, .. } => (Namespace::Upload, id),
        }
    }
}

/// The host provides confinement to the media store's private directory.
pub trait Backend {
    type Guard<'a>: WriteGuard
    where
        Self: 'a;

    /// Serialize generated and uploaded writes, accounting and pruning.
    fn lock(&self, deadline: Instant) -> Result<Self::Guard<'_>>;
    /// Under exclusive startup ownership, remove stale staging and lock
    /// entries from the previous process and return the new store lock.
    fn recover_staging(&mut self, deadline: Instant) -> Result<Self::Guard<'_>>;
    /// Open and read a confined regular file, bounding the bytes while reading.
    /// In the upload namespace a missing manifest for a present entry is an error.
    fn read(
        &self,
        space: Namespace,
        id: &str,
        name: &str,
        limit: usize,
        deadline: Instant,
    ) -> Result<Option<Vec<u8>>>;
}

pub trait WriteGuard {
    type Stage<'a>: VideoStage
    where
        Self: 'a;

    fn contains(&self, space: Namespace, id: &str, deadline: Instant) -> Result<bool>;
    fn generated_bytes(&self, deadline: Instant) -> Result<u64>;
    fn stage(&mut self, deadline: Instant) -> Result<Self::Stage<'_>>;
    /// Generated outputs only. Each tuple names a published output and its creation time.
    fn entries(&self, deadline: Instant) -> Result<Vec<(String, i64)>>;
    fn delete(&mut self, id: &str, deadline: Instant) -> Result<()>;
    /// Inspect bounded upload manifests and file metadata without reading payloads.
    fn uploads(&mut self, deadline: Instant) -> Result<Vec<Entry>>;
    fn write_upload_index(
        &mut self,
        id: &str,
        record: IndexRecord,
        deadline: Instant,
    ) -> Result<()>;
    fn upload_index_ids(&self, deadline: Instant) -> Result<Vec<String>>;
    fn remove_upload_index(&mut self, id: &str, deadline: Instant) -> Result<()>;
    /// Await idempotent host owner cleanup before unlinking. For a malformed entry
    /// the input is only a directory entry and must never be used for owner lookup.
    fn delete_upload(&mut self, id: &str, verified_id: bool, deadline: Instant) -> Result<()>;
}

/// A private staging directory whose uncommitted contents are removed on drop.
pub trait Stage {
    /// Exclusively create and sync a file in the staging directory.
    fn write_private(&mut self, name: &str, bytes: &[u8], deadline: Instant) -> Result<()>;
    /// Publish the directory without replacing old data. For an upload, persist
    /// the charge first and remove it on failed rename while holding the lock.
    fn publish(self, target: Destination<'_>, deadline: Instant) -> Result<()>;
}

pub use crate::images::Format as ImageFormat;

#[derive(Clone, Copy)]
pub struct Image<'a> {
    pub bytes: &'a [u8],
    pub format: ImageFormat,
}

/// Request parameters without the binary sources.
#[derive(Clone, Copy)]
pub struct Images<'a> {
    pub parameters: &'a Value,
    pub references: &'a [&'a [u8]],
    pub mask: Option<&'a [u8]>,
    pub metadata: &'a Value,
    pub agent_metadata: Option<bool>,
    pub partial: bool,
    pub files: &'a [Image<'a>],
}

#[derive(Default)]
pub struct Settings {
    pub quota_bytes: Option<u64>,
    pub retention_ms: Option<u64>,
    pub max_video_bytes: Option<u64>,
    pub embed_metadata: Option<bool>,
}

pub struct OutputStore<'a, B> {
    backend: &'a B,
    settings: Settings,
}

impl<'a, B: Backend> OutputStore<'a, B> {
    pub fn new(backend: &'a B, settings: Settings) -> Self {
        Self { backend, settings }
    }

    pub fn put_images(
        &self,
        id: &str,
        input: &Images<'_>,
        now_ms: i64,
        deadline: Instant,
    ) -> Result<Value> {
        verify_id(id)?;
        if !matches!(units::requested(input.parameters)?, Units::Images(_)) {
            return Err(Error::UnsupportedParameter);
        }
        if input.files.is_empty() || input.files.len() > 10 {
            return Err(Error::InvalidResponse);
        }
        let mut files = Vec::with_capacity(input.files.len());
        let mut staged = Vec::with_capacity(input.files.len());
        let metadata = self.embed_payload(input.parameters, input.metadata, input.agent_metadata);
        for (index, image) in input.files.iter().enumerate() {
            check_deadline(deadline)?;
            if ImageFormat::sniff(image.bytes) != Some(image.format) {
                return Err(Error::InvalidResponse);
            }
            let format = image.format.extension();
            let name = format!("{index}.{format}");
            let stored = if let Some(ref payload) = metadata {
                std::borrow::Cow::Owned(crate::images::embed(image.bytes, image.format, payload)?)
            } else {
                std::borrow::Cow::Borrowed(image.bytes)
            };
            files.push(json!({
                "path":name, "format":format, "sha256":hash(&stored), "bytes":stored.len(),
            }));
            staged.push((name, stored));
        }
        let mut manifest = json!({
            "schema":SCHEMA, "id":id, "createdAt":now_ms, "prompt":input.parameters["prompt"],
            "parameters":input.parameters, "referenceHashes":input.references.iter().map(|bytes| hash(bytes)).collect::<Vec<_>>(),
            "metadata":manifest_metadata(input.metadata)?, "partial":input.partial, "files":files,
        });
        if let Some(mask) = input.mask {
            manifest["maskHash"] = json!(hash(mask));
        }
        let encoded = encode_manifest(&manifest)?;
        staged.push((MANIFEST.into(), std::borrow::Cow::Owned(encoded)));
        let files = staged
            .iter()
            .map(|(name, data)| (name.as_str(), data.as_ref()))
            .collect::<Vec<_>>();
        self.publish(Destination::Output(id), &files, now_ms, deadline)?;
        Ok(manifest)
    }

    fn embed_payload<'m>(
        &self,
        parameters: &'m Value,
        metadata: &'m Value,
        agent_metadata: Option<bool>,
    ) -> Option<crate::images::Metadata<'m>> {
        let enabled = parameters["embedMetadata"]
            .as_bool()
            .or(agent_metadata)
            .or(self.settings.embed_metadata)
            .unwrap_or(false);
        enabled.then(|| crate::images::Metadata {
            prompt: parameters["prompt"].as_str().unwrap_or_default(),
            parameters,
            metadata,
        })
    }

    fn publish(
        &self,
        destination: Destination<'_>,
        files: &[(&str, &[u8])],
        now_ms: i64,
        deadline: Instant,
    ) -> Result<()> {
        check_deadline(deadline)?;
        let mut guard = self.backend.lock(deadline)?;
        let (space, id) = destination.location();
        if guard.contains(space, id, deadline)? {
            return Err(Error::UnsupportedParameter);
        }
        let total = files.iter().try_fold(
            charged_bytes(&mut guard, now_ms, deadline)?,
            |total, (_, bytes)| total.checked_add(bytes.len() as u64).ok_or(Error::Quota),
        )?;
        if self.settings.quota_bytes.is_some_and(|quota| total > quota) {
            return Err(Error::Quota);
        }
        let mut stage = guard.stage(deadline)?;
        for (name, bytes) in files {
            check_deadline(deadline)?;
            stage.write_private(name, bytes, deadline)?;
        }
        check_deadline(deadline)?;
        stage.publish(destination, deadline)
    }

    pub fn get(&self, id: &str, deadline: Instant) -> Result<Option<Value>> {
        verify_id(id)?;
        check_deadline(deadline)?;
        let Some(bytes) = self.backend.read(
            Namespace::Output,
            id,
            MANIFEST,
            MAX_MANIFEST_BYTES,
            deadline,
        )?
        else {
            return Ok(None);
        };
        if bytes.len() > MAX_MANIFEST_BYTES {
            return Err(Error::Storage);
        }
        check_deadline(deadline)?;
        let manifest: Value = serde_json::from_slice(&bytes).map_err(|_| Error::Storage)?;
        if manifest["schema"] != SCHEMA || manifest["id"] != id {
            return Err(Error::Storage);
        }
        Ok(Some(manifest))
    }

    pub fn delete(&self, id: &str, deadline: Instant) -> Result<()> {
        verify_id(id)?;
        check_deadline(deadline)?;
        self.backend.lock(deadline)?.delete(id, deadline)
    }

    pub fn prune(&self, now_ms: i64, deadline: Instant) -> Result<usize> {
        check_deadline(deadline)?;
        let mut guard = self.backend.lock(deadline)?;
        let mut count = 0;
        if let Some(retention) = self.settings.retention_ms {
            for (id, created) in guard.entries(deadline)? {
                verify_id(&id)?;
                if i128::from(now_ms) - i128::from(created) < i128::from(retention) {
                    continue;
                }
                check_deadline(deadline)?;
                guard.delete(&id, deadline)?;
                count += 1;
            }
        }
        Ok(count
            + prune_uploads(&mut guard, now_ms, self.settings.retention_ms, deadline)
                .map_err(upload_error)?)
    }

    pub fn put_uploaded(
        &self,
        id: &str,
        upload: &Upload<'_>,
        now_ms: i64,
        deadline: Instant,
    ) -> Result<uploads::Manifest> {
        verify_id(id)?;
        check_deadline(deadline)?;
        let manifest = uploads::Manifest::admit(id, now_ms, upload)?;
        let encoded = serde_json::to_vec(&manifest).map_err(|_| Error::Storage)?;
        if encoded.len() > uploads::MAX_MANIFEST_BYTES {
            return Err(Error::TooLarge);
        }
        let index = IndexRecord::new(now_ms, (encoded.len() + upload.bytes.len()) as u64, false);
        self.publish(
            Destination::Upload { id, index },
            &[
                (manifest.file.path.as_str(), upload.bytes),
                (MANIFEST, &encoded),
            ],
            now_ms,
            deadline,
        )
        .map_err(upload_error)?;
        Ok(manifest)
    }

    pub fn get_uploaded(&self, id: &str, deadline: Instant) -> Result<Option<uploads::Stored>> {
        verify_id(id)?;
        check_deadline(deadline)?;
        let Some(raw) = self
            .backend
            .read(
                Namespace::Upload,
                id,
                MANIFEST,
                uploads::MAX_MANIFEST_BYTES,
                deadline,
            )
            .map_err(upload_error)?
        else {
            return Ok(None);
        };
        let manifest = uploads::Manifest::decode(id, &raw).map_err(upload_error)?;
        let bytes = self
            .backend
            .read(
                Namespace::Upload,
                id,
                &manifest.file.path,
                manifest.file.bytes,
                deadline,
            )
            .map_err(upload_error)?
            .ok_or(Error::BackendUnavailable)?;
        check_deadline(deadline)?;
        if bytes.len() != manifest.file.bytes || hash(&bytes) != manifest.file.sha256 {
            return Err(Error::BackendUnavailable);
        }
        Ok(Some(uploads::Stored { manifest, bytes }))
    }

    pub fn delete_uploaded(&self, id: &str, deadline: Instant) -> Result<()> {
        verify_id(id)?;
        check_deadline(deadline)?;
        self.backend
            .lock(deadline)
            .and_then(|mut guard| guard.delete_upload(id, true, deadline))
            .map_err(upload_error)
    }
}

fn manifest_metadata(metadata: &Value) -> Result<Value> {
    let mut metadata = metadata
        .as_object()
        .cloned()
        .ok_or(Error::InvalidResponse)?;
    metadata.entry("seed").or_insert(Value::Null);
    if metadata.get("origin").is_none_or(Value::is_null) {
        metadata.insert("origin".to_owned(), json!("unknown"));
    }
    Ok(Value::Object(metadata))
}

fn encode_manifest(manifest: &Value) -> Result<Vec<u8>> {
    let encoded = serde_json::to_vec(manifest).map_err(|_| Error::InvalidResponse)?;
    if encoded.len() > MAX_MANIFEST_BYTES {
        return Err(Error::TooLarge);
    }
    Ok(encoded)
}

/// Recover interrupted publications before sharing the store with other writers.
pub fn recover_staging(backend: &mut impl Backend, now_ms: i64, deadline: Instant) -> Result<()> {
    check_deadline(deadline)?;
    let mut guard = backend.recover_staging(deadline).map_err(upload_error)?;
    prune_uploads(&mut guard, now_ms, None, deadline).map_err(upload_error)?;
    Ok(())
}

fn upload_error(error: Error) -> Error {
    match error {
        Error::Storage => Error::BackendUnavailable,
        other => other,
    }
}

fn charged_bytes(guard: &mut impl WriteGuard, now: i64, deadline: Instant) -> Result<u64> {
    let mut total = guard.generated_bytes(deadline)?;
    for entry in guard.uploads(deadline)? {
        check_deadline(deadline)?;
        let mut account = entry.account(now);
        // A metadata-only quota scan cannot clear an earlier read error.
        if entry.saved.is_some_and(|record| record.unavailable) {
            account.unavailable = true;
        }
        if verify_id(&entry.id).is_ok() && Some(account) != entry.saved {
            guard.write_upload_index(&entry.id, account, deadline)?;
        }
        total = total.checked_add(account.bytes).ok_or(Error::Quota)?;
    }
    Ok(total)
}

fn prune_uploads(
    guard: &mut impl WriteGuard,
    now: i64,
    retention: Option<u64>,
    deadline: Instant,
) -> Result<usize> {
    let mut removed = 0;
    for mut entry in guard.uploads(deadline)? {
        check_deadline(deadline)?;
        let valid_id = verify_id(&entry.id).is_ok();
        if !valid_id && !matches!(entry.health, Health::Unavailable) {
            entry.health = Health::Corrupt;
        }
        let account = entry.account(now);
        if valid_id && Some(account) != entry.saved {
            guard.write_upload_index(&entry.id, account, deadline)?;
        }
        if entry.expired(now, retention, account) {
            guard.delete_upload(&entry.id, valid_id, deadline)?;
            removed += 1;
        }
    }
    for id in guard.upload_index_ids(deadline)? {
        check_deadline(deadline)?;
        if verify_id(&id).is_ok() && !guard.contains(Namespace::Upload, &id, deadline)? {
            guard.remove_upload_index(&id, deadline)?;
        }
    }
    Ok(removed)
}

pub(crate) fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn verify_id(id: &str) -> Result<()> {
    if !(1..=100).contains(&id.len())
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        Err(Error::UnsupportedParameter)
    } else {
        Ok(())
    }
}

fn check_deadline(deadline: Instant) -> Result<()> {
    if Instant::now() >= deadline {
        Err(Error::Timeout)
    } else {
        Ok(())
    }
}
