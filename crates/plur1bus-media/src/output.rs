//! Generated output admission and publication over private storage ports.
use crate::{
    jobs::{Error, Result},
    units::{self, Units},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::Instant;

const MANIFEST: &str = "manifest.json";
const SCHEMA: &str = "media.output/1";
const MAX_MANIFEST_BYTES: usize = 1024 * 1024;

/// The host provides confinement to the media store's private directory.
pub trait Backend {
    type Guard<'a>: WriteGuard
    where
        Self: 'a;

    /// Serialize generated and uploaded writes, accounting and pruning.
    fn lock(&self, deadline: Instant) -> Result<Self::Guard<'_>>;
    /// Read a published manifest, bounding the bytes while reading.
    fn read_manifest(&self, id: &str, limit: usize, deadline: Instant) -> Result<Option<Vec<u8>>>;
}

pub trait WriteGuard {
    type Stage<'a>: Stage
    where
        Self: 'a;

    fn contains(&self, id: &str, deadline: Instant) -> Result<bool>;
    /// All bytes already charged under the same lock, including uploads.
    fn charged_bytes(&self, deadline: Instant) -> Result<u64>;
    fn stage(&mut self, deadline: Instant) -> Result<Self::Stage<'_>>;
    /// Generated outputs only. Each tuple names a published output and its creation time.
    fn entries(&self, deadline: Instant) -> Result<Vec<(String, i64)>>;
    fn delete(&mut self, id: &str, deadline: Instant) -> Result<()>;
}

/// A private staging directory whose uncommitted contents are removed on drop.
pub trait Stage {
    /// Exclusively create and sync a file in the staging directory.
    fn write_private(&mut self, name: &str, bytes: &[u8], deadline: Instant) -> Result<()>;
    /// Atomically publish the entire directory without overwriting an existing output.
    fn publish(self, id: &str, deadline: Instant) -> Result<()>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ImageFormat {
    Png,
    Jpeg,
    Webp,
}

impl ImageFormat {
    pub fn extension(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpeg",
            Self::Webp => "webp",
        }
    }

    pub fn sniff(bytes: &[u8]) -> Option<Self> {
        if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            Some(Self::Png)
        } else if bytes.starts_with(b"\xff\xd8\xff") {
            Some(Self::Jpeg)
        } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
            Some(Self::Webp)
        } else {
            None
        }
    }
}

#[derive(Clone, Copy)]
pub struct Image<'a> {
    pub bytes: &'a [u8],
    pub format: ImageFormat,
}

/// Request parameters without the binary sources. Images are prepared for
/// publication, including any metadata the caller selected.
#[derive(Clone, Copy)]
pub struct Images<'a> {
    pub parameters: &'a Value,
    pub references: &'a [&'a [u8]],
    pub mask: Option<&'a [u8]>,
    pub metadata: &'a Value,
    pub partial: bool,
    pub files: &'a [Image<'a>],
}

#[derive(Default)]
pub struct Settings {
    pub quota_bytes: Option<u64>,
    pub retention_ms: Option<u64>,
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
        for (index, image) in input.files.iter().enumerate() {
            check_deadline(deadline)?;
            if ImageFormat::sniff(image.bytes) != Some(image.format) {
                return Err(Error::InvalidResponse);
            }
            let format = image.format.extension();
            let name = format!("{index}.{format}");
            files.push(json!({
                "path":name, "format":format, "sha256":hash(image.bytes), "bytes":image.bytes.len(),
            }));
            staged.push((name, image.bytes));
        }
        let mut metadata = input
            .metadata
            .as_object()
            .cloned()
            .ok_or(Error::InvalidResponse)?;
        metadata.entry("seed").or_insert(Value::Null);
        if metadata.get("origin").is_none_or(Value::is_null) {
            metadata.insert("origin".to_owned(), json!("unknown"));
        }
        let mut manifest = json!({
            "schema":SCHEMA, "id":id, "createdAt":now_ms, "prompt":input.parameters["prompt"],
            "parameters":input.parameters, "referenceHashes":input.references.iter().map(|bytes| hash(bytes)).collect::<Vec<_>>(),
            "metadata":metadata, "partial":input.partial, "files":files,
        });
        if let Some(mask) = input.mask {
            manifest["maskHash"] = json!(hash(mask));
        }
        let encoded = serde_json::to_vec(&manifest).map_err(|_| Error::InvalidResponse)?;
        if encoded.len() > MAX_MANIFEST_BYTES {
            return Err(Error::TooLarge);
        }
        staged.push((MANIFEST.into(), &encoded));
        self.publish(id, &staged, deadline)?;
        Ok(manifest)
    }

    fn publish(&self, id: &str, files: &[(String, &[u8])], deadline: Instant) -> Result<()> {
        check_deadline(deadline)?;
        let mut guard = self.backend.lock(deadline)?;
        if guard.contains(id, deadline)? {
            return Err(Error::UnsupportedParameter);
        }
        if let Some(quota) = self.settings.quota_bytes {
            let total = files
                .iter()
                .try_fold(guard.charged_bytes(deadline)?, |total, (_, bytes)| {
                    total.checked_add(bytes.len() as u64).ok_or(Error::Quota)
                })?;
            if total > quota {
                return Err(Error::Quota);
            }
        }
        let mut stage = guard.stage(deadline)?;
        for (name, bytes) in files {
            check_deadline(deadline)?;
            stage.write_private(name, bytes, deadline)?;
        }
        check_deadline(deadline)?;
        stage.publish(id, deadline)
    }

    pub fn get(&self, id: &str, deadline: Instant) -> Result<Option<Value>> {
        verify_id(id)?;
        check_deadline(deadline)?;
        let Some(bytes) = self
            .backend
            .read_manifest(id, MAX_MANIFEST_BYTES, deadline)?
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
        let Some(retention) = self.settings.retention_ms else {
            return Ok(0);
        };
        check_deadline(deadline)?;
        let mut guard = self.backend.lock(deadline)?;
        let entries = guard.entries(deadline)?;
        let mut count = 0;
        for (id, created) in entries {
            verify_id(&id)?;
            if i128::from(now_ms) - i128::from(created) < i128::from(retention) {
                continue;
            }
            check_deadline(deadline)?;
            guard.delete(&id, deadline)?;
            count += 1;
        }
        Ok(count)
    }
}

fn hash(bytes: &[u8]) -> String {
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
