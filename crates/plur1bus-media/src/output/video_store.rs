use std::{
    io::{self, Read, Write},
    path::{Path, PathBuf},
    time::Instant,
};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{
    charged_bytes, check_deadline, encode_manifest, hash, manifest_metadata, verify_id, Backend,
    Destination, Namespace, OutputStore, Stage, WriteGuard, MANIFEST, SCHEMA,
};
use crate::{
    jobs::{Error, Result},
    units::{self, Units},
    video::{self, ProcessPort, VideoPaths, VideoRequest},
};

const VIDEO_LIMIT: u64 = 512 * 1024 * 1024;
const PREFIX: usize = 4096;
const BUFFER: usize = 32 * 1024;

pub trait VideoStage: Stage {
    type Writer: Write;
    type Reader: Read;

    /// Create a private file and return its absolute host path and writer.
    fn create_payload(&mut self, name: &str, deadline: Instant) -> Result<(PathBuf, Self::Writer)>;
    /// Reopen a staged file privately, sync it and return a reader at offset zero.
    fn sync_payload(&self, path: &Path, deadline: Instant) -> Result<Self::Reader>;
    fn unlink_payload(&mut self, path: &Path, deadline: Instant) -> Result<()>;
}

pub struct Video<'a> {
    pub parameters: &'a Value,
    pub references: &'a [&'a [u8]],
    pub metadata: &'a Value,
    pub agent_metadata: Option<bool>,
    pub partial: bool,
    /// Provider body. The caller bounds and interrupts each blocking read.
    pub source: &'a mut dyn Read,
}

pub struct VideoControl<'a> {
    pub now_ms: i64,
    pub deadline: Instant,
    pub cancelled: &'a dyn Fn() -> bool,
}

impl VideoControl<'_> {
    fn check(&self) -> Result<()> {
        if (self.cancelled)() {
            return Err(Error::Cancelled);
        }
        check_deadline(self.deadline)
    }

    fn read(&self, input: &mut dyn Read, buffer: &mut [u8]) -> Result<usize> {
        loop {
            self.check()?;
            match input.read(buffer) {
                Ok(read) => {
                    self.check()?;
                    return Ok(read);
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(error) if error.kind() == io::ErrorKind::TimedOut => {
                    return Err(Error::Timeout)
                }
                Err(error) => {
                    self.check()?;
                    return Err(match error.kind() {
                        io::ErrorKind::FileTooLarge => Error::TooLarge,
                        io::ErrorKind::ConnectionAborted => Error::Cancelled,
                        _ => Error::BackendUnavailable,
                    });
                }
            }
        }
    }
}

impl<B: Backend> OutputStore<'_, B> {
    pub fn put_video(
        &self,
        id: &str,
        input: &mut Video<'_>,
        codec: &dyn ProcessPort,
        control: &VideoControl<'_>,
    ) -> Result<Value> {
        verify_id(id)?;
        if !matches!(units::requested(input.parameters)?, Units::VideoSeconds(_)) {
            return Err(Error::UnsupportedParameter);
        }
        let metadata = manifest_metadata(input.metadata)?;
        let embedded = self
            .embed_payload(input.parameters, input.metadata, input.agent_metadata)
            .map(|payload| serde_json::to_string(&payload).map_err(|_| Error::InvalidResponse))
            .transpose()?;
        let deadline = control.deadline;
        control.check()?;
        let mut guard = self.backend.lock(deadline)?;
        if guard.contains(Namespace::Output, id, deadline)? {
            return Err(Error::UnsupportedParameter);
        }
        let used = charged_bytes(&mut guard, control.now_ms, deadline)?;
        let quota = self.settings.quota_bytes.unwrap_or(u64::MAX);
        let limit = self.settings.max_video_bytes.unwrap_or(VIDEO_LIMIT);
        let mut stage = guard.stage(deadline)?;
        let (source_path, mut destination) = stage.create_payload("download", deadline)?;
        let prefix = stage_source(
            input.source,
            &mut destination,
            limit,
            quota.saturating_sub(used),
            control,
        )?;
        drop(destination);
        stage.sync_payload(&source_path, deadline)?;
        let actual = video::detect_format(&prefix).map_err(codec_error)?;
        let format = input.parameters["videoFormat"]
            .as_str()
            .map_or(Ok(actual), str::parse)
            .map_err(codec_error)?;
        let name = format!("0.{}", format.extension());
        let (output_path, output_file) = stage.create_payload(&name, deadline)?;
        let (poster_path, poster_file) = stage.create_payload("0.poster.png", deadline)?;
        drop((output_file, poster_file));
        let info = video::process(
            codec,
            &VideoRequest {
                paths: VideoPaths {
                    input: &source_path,
                    output: &output_path,
                    poster: &poster_path,
                },
                format,
                prompt: embedded.as_deref(),
            },
            deadline,
            control.cancelled,
        )
        .map_err(codec_error)?;
        let output = describe(
            &mut stage.sync_payload(&output_path, deadline)?,
            limit,
            control,
        )?;
        let poster = describe(
            &mut stage.sync_payload(&poster_path, deadline)?,
            limit,
            control,
        )?;
        let manifest = json!({
            "schema":SCHEMA, "kind":"video", "id":id, "createdAt":control.now_ms,
            "prompt":input.parameters["prompt"], "parameters":input.parameters,
            "referenceHashes":input.references.iter().map(|bytes| hash(bytes)).collect::<Vec<_>>(),
            "metadata":metadata, "partial":input.partial,
            "files":[{
                "path":name, "format":format.extension(), "sha256":output.1, "bytes":output.0,
                "durationSeconds":number(info.duration_seconds), "width":info.width, "height":info.height,
                "fps":number(info.fps), "audio":info.audio,
                "poster":{"path":"0.poster.png", "sha256":poster.1, "bytes":poster.0},
            }],
        });
        let encoded = encode_manifest(&manifest)?;
        let total = [used, output.0, poster.0, encoded.len() as u64]
            .into_iter()
            .try_fold(0u64, |sum, size| sum.checked_add(size).ok_or(Error::Quota))?;
        if total > quota {
            return Err(Error::Quota);
        }
        control.check()?;
        stage.unlink_payload(&source_path, deadline)?;
        stage.write_private(MANIFEST, &encoded, deadline)?;
        control.check()?;
        stage.publish(Destination::Output(id), deadline)?;
        Ok(manifest)
    }
}

fn stage_source(
    input: &mut dyn Read,
    output: &mut dyn Write,
    limit: u64,
    quota: u64,
    control: &VideoControl<'_>,
) -> Result<Vec<u8>> {
    let mut buffer = [0; BUFFER];
    let mut total = 0u64;
    let mut prefix = Vec::with_capacity(PREFIX);
    loop {
        let read = control.read(input, &mut buffer)?;
        if read == 0 {
            break;
        }
        total = total.checked_add(read as u64).ok_or(Error::TooLarge)?;
        if total > limit {
            return Err(Error::TooLarge);
        }
        if total > quota {
            return Err(Error::Quota);
        }
        let take = (PREFIX - prefix.len()).min(read);
        prefix.extend_from_slice(&buffer[..take]);
        output
            .write_all(&buffer[..read])
            .map_err(|_| Error::Storage)?;
    }
    output.flush().map_err(|_| Error::Storage)?;
    Ok(prefix)
}

fn describe(input: &mut dyn Read, limit: u64, control: &VideoControl<'_>) -> Result<(u64, String)> {
    let mut buffer = [0; BUFFER];
    let mut total = 0u64;
    let mut digest = Sha256::new();
    loop {
        let read = control.read(input, &mut buffer)?;
        if read == 0 {
            return Ok((total, format!("{:x}", digest.finalize())));
        }
        total = total.checked_add(read as u64).ok_or(Error::TooLarge)?;
        if total > limit {
            return Err(Error::TooLarge);
        }
        digest.update(&buffer[..read]);
    }
}

fn number(value: f64) -> Value {
    if value.fract() == 0.0 && (0.0..=(1u64 << 53) as f64).contains(&value) {
        json!(value as u64)
    } else {
        json!(value)
    }
}

fn codec_error(error: video::Error) -> Error {
    match error {
        video::Error::BackendUnavailable => Error::BackendUnavailable,
        video::Error::Cancelled => Error::Cancelled,
        video::Error::InvalidResponse => Error::InvalidResponse,
        video::Error::Timeout => Error::Timeout,
    }
}
