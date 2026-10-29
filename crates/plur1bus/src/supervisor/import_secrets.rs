//! One-use source credentials cross private pipes only; no value enters supervisor state, logs or run records.
use super::imports::Job;
use crate::ext::ExtError;
use crate::paths::Layout;
use plur1bus_rpc::{transport, trust};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Write};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use zeroize::Zeroizing;

const MAX_FRAME: usize = 1024 * 1024;
const MAX_VALUE: usize = 64 * 1024;
const MAX_REQUEST: usize = 4096;
const SOURCE_NAMES: &str =
    include_str!("../../../../packages/core/src/import/source-secret-names.json");

fn unavailable() -> ExtError {
    ExtError::new(
        "E_NOT_AVAILABLE",
        "source-secret-unavailable",
        "private source credentials are unavailable",
    )
}

fn names() -> Result<&'static BTreeSet<String>, ExtError> {
    static NAMES: OnceLock<Result<BTreeSet<String>, ()>> = OnceLock::new();
    NAMES
        .get_or_init(|| {
            let values: Vec<String> = serde_json::from_str(SOURCE_NAMES).map_err(|_| ())?;
            let names: BTreeSet<String> = values.iter().cloned().collect();
            if names.len() != 16
                || names.len() != values.len()
                || names.iter().any(|name| {
                    name.is_empty()
                        || name.len() > 64
                        || !name.bytes().all(|byte| {
                            byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_'
                        })
                })
            {
                return Err(());
            }
            Ok(names)
        })
        .as_ref()
        .map_err(|_| unavailable())
}

fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
            }
        })
}

fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[derive(PartialEq, Eq)]
struct Binding {
    invocation: String,
    run: String,
    plan: String,
    hash: String,
    owner: String,
    preflight: String,
    attempt: u64,
    source_type: String,
    target: Option<String>,
}

impl Binding {
    fn of(job: &Job) -> Result<Self, ExtError> {
        let preflight = job.preflight_id.as_deref().ok_or_else(unavailable)?;
        if job.role != "owner"
            || job.mode != "apply"
            || !job.migrate_secrets
            || job.automatic_rollback
            || !uuid(&job.run_id)
            || !uuid(&job.invocation_id)
            || !uuid(&job.plan_id)
            || !uuid(preflight)
            || !digest(&job.plan_sha256)
            || job.owner_id.is_empty()
            || job.owner_id.len() > 512
            || !(1..=1000).contains(&job.attempt)
            || job.source_type.len() > 64
            || job
                .target_sha256
                .as_deref()
                .is_some_and(|value| !digest(value))
        {
            return Err(unavailable());
        }
        Ok(Self {
            invocation: job.invocation_id.clone(),
            run: job.run_id.clone(),
            plan: job.plan_id.clone(),
            hash: job.plan_sha256.clone(),
            owner: job.owner_id.clone(),
            preflight: preflight.into(),
            attempt: job.attempt,
            source_type: job.source_type.clone(),
            target: job.target_sha256.clone(),
        })
    }
}

/// Deliberately neither Clone, Debug nor Serialize. Values have one owner until consumed into a private frame.
pub struct SourceSecrets {
    values: BTreeMap<String, Zeroizing<String>>,
    binding: Binding,
}

fn take<'a>(packet: &'a [u8], at: &mut usize, count: usize) -> Result<&'a [u8], ExtError> {
    let end = at.checked_add(count).ok_or_else(unavailable)?;
    let part = packet.get(*at..end).ok_or_else(unavailable)?;
    *at = end;
    Ok(part)
}

struct PrivateBytes {
    bytes: Zeroizing<Vec<u8>>,
    limit: usize,
}
impl Write for PrivateBytes {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.bytes.len().saturating_add(bytes.len()) >= self.limit {
            return Err(std::io::Error::other("private frame limit"));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn serialize(value: &impl Serialize, limit: usize) -> Result<Zeroizing<Vec<u8>>, ExtError> {
    // One allocation: growth/reallocation must not leave earlier plaintext copies in freed buffers.
    let mut writer = PrivateBytes {
        bytes: Zeroizing::new(Vec::with_capacity(limit)),
        limit,
    };
    serde_json::to_writer(&mut writer, value).map_err(|_| unavailable())?;
    writer.bytes.push(b'\n');
    Ok(writer.bytes)
}

impl SourceSecrets {
    fn decode(packet: &[u8], job: &Job) -> Result<Self, ExtError> {
        let binding = Binding::of(job)?;
        if packet.len() < 3 || packet.len() > MAX_FRAME || packet[0] != 0 {
            return Err(unavailable());
        }
        let allowed = names()?;
        let count = u16::from_be_bytes([packet[1], packet[2]]) as usize;
        if count > allowed.len() {
            return Err(unavailable());
        }
        let mut at = 3;
        let mut values = BTreeMap::new();
        for _ in 0..count {
            let key_len = u16::from_be_bytes(
                take(packet, &mut at, 2)?
                    .try_into()
                    .map_err(|_| unavailable())?,
            ) as usize;
            let key =
                std::str::from_utf8(take(packet, &mut at, key_len)?).map_err(|_| unavailable())?;
            if !allowed.contains(key) || values.contains_key(key) {
                return Err(unavailable());
            }
            let value_len = u32::from_be_bytes(
                take(packet, &mut at, 4)?
                    .try_into()
                    .map_err(|_| unavailable())?,
            ) as usize;
            if value_len > MAX_VALUE {
                return Err(unavailable());
            }
            let value = std::str::from_utf8(take(packet, &mut at, value_len)?)
                .map_err(|_| unavailable())?;
            values.insert(key.into(), Zeroizing::new(value.to_owned()));
        }
        if at != packet.len() {
            return Err(unavailable());
        }
        Ok(Self { values, binding })
    }

    /// Consumes the exact job-bound transfer. Its decoded values are wiped as the private worker frame takes ownership.
    pub fn frame(self, job: &Job) -> Result<Zeroizing<Vec<u8>>, ExtError> {
        if self.binding != Binding::of(job)? {
            return Err(unavailable());
        }
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Transfer<'a> {
            v: u8,
            #[serde(rename = "type")]
            kind: &'static str,
            run_id: &'a str,
            plan_id: &'a str,
            preflight_id: &'a str,
            entries: BTreeMap<&'a str, &'a str>,
        }
        let transfer = Transfer {
            v: 1,
            kind: "secret-source",
            run_id: &job.run_id,
            plan_id: &job.plan_id,
            preflight_id: &self.binding.preflight,
            entries: self
                .values
                .iter()
                .map(|(key, value)| (key.as_str(), value.as_str()))
                .collect(),
        };
        serialize(&transfer, MAX_FRAME)
    }
}

fn remaining(deadline: Instant) -> Result<Duration, ExtError> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|left| !left.is_zero())
        .ok_or_else(unavailable)
}

fn read_before(
    stream: &mut dyn transport::Stream,
    mut bytes: &mut [u8],
    deadline: Instant,
) -> Result<(), ExtError> {
    while !bytes.is_empty() {
        stream
            .set_read_timeout(Some(remaining(deadline)?))
            .map_err(|_| unavailable())?;
        let read = stream.read(bytes).map_err(|_| unavailable())?;
        if read == 0 {
            return Err(unavailable());
        }
        bytes = &mut bytes[read..];
    }
    Ok(())
}

fn write_before(
    stream: &mut dyn transport::Stream,
    mut bytes: &[u8],
    deadline: Instant,
) -> Result<(), ExtError> {
    while !bytes.is_empty() {
        // On Windows this also bounds overlapped writes. Unix sends at most one bounded 4 KiB request and ACK.
        stream
            .set_read_timeout(Some(remaining(deadline)?))
            .map_err(|_| unavailable())?;
        let written = stream.write(bytes).map_err(|_| unavailable())?;
        if written == 0 {
            return Err(unavailable());
        }
        bytes = &bytes[written..];
    }
    stream.flush().map_err(|_| unavailable())
}

fn token(layout: &Layout) -> Result<(Zeroizing<[u8; MAX_REQUEST + 1]>, usize), ExtError> {
    trust::verify_run_dir(&layout.run()).map_err(|_| unavailable())?;
    let path = layout.core_token();
    let metadata = std::fs::symlink_metadata(&path).map_err(|_| unavailable())?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > MAX_REQUEST as u64
    {
        return Err(unavailable());
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    let mut file = options.open(path).map_err(|_| unavailable())?;
    if !file.metadata().map_err(|_| unavailable())?.is_file() {
        return Err(unavailable());
    }
    let mut bytes = Zeroizing::new([0u8; MAX_REQUEST + 1]);
    let mut at = 0;
    while at < bytes.len() {
        let read = file.read(&mut bytes[at..]).map_err(|_| unavailable())?;
        if read == 0 {
            break;
        }
        at += read;
    }
    if at == 0 || at > MAX_REQUEST {
        return Err(unavailable());
    }
    Ok((bytes, at))
}

fn acquire_with_timeout(
    layout: &Layout,
    job: &Job,
    timeout: Duration,
) -> Result<SourceSecrets, ExtError> {
    Binding::of(job)?;
    let deadline = Instant::now() + timeout;
    let address = crate::paths::import_secrets_address(
        &layout.home,
        if cfg!(windows) { "windows" } else { "posix" },
    );
    trust::verify_address(&address).map_err(|_| unavailable())?;
    let mut stream = transport::connect(&address, remaining(deadline)?.min(Duration::from_secs(2)))
        .map_err(|_| unavailable())?;
    #[cfg(unix)]
    {
        // SAFETY: geteuid has no preconditions.
        trust::check_peer_uid(stream.peer_uid(), unsafe { libc::geteuid() })
            .map_err(|_| unavailable())?;
    }
    #[cfg(windows)]
    {
        let expected = layout
            .recorded_pid(plur1bus_rpc::Endpoint::Core)
            .ok_or_else(unavailable)?;
        if stream.peer_pid() != Some(expected) {
            return Err(unavailable());
        }
    }
    {
        let (bytes, length) = token(layout)?;
        let token = std::str::from_utf8(&bytes[..length])
            .map_err(|_| unavailable())?
            .trim();
        if token.is_empty() {
            return Err(unavailable());
        }
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Request<'a> {
            v: u8,
            token: &'a str,
            plan_id: &'a str,
            preflight_id: &'a str,
        }
        let request = serialize(
            &Request {
                v: 1,
                token,
                plan_id: &job.plan_id,
                preflight_id: job.preflight_id.as_deref().ok_or_else(unavailable)?,
            },
            MAX_REQUEST,
        )?;
        write_before(&mut *stream, &request, deadline)?;
    }
    let mut header = [0u8; 4];
    read_before(&mut *stream, &mut header, deadline)?;
    let length = u32::from_be_bytes(header) as usize;
    if !(3..=MAX_FRAME).contains(&length) {
        return Err(unavailable());
    }
    let mut packet = Zeroizing::new(vec![0; length]);
    read_before(&mut *stream, &mut packet, deadline)?;
    let secrets = SourceSecrets::decode(&packet, job)?;
    write_before(&mut *stream, &[0x06], deadline)?;
    Ok(secrets)
}

/// Fetches an Owner's one-use lease while Core is live; all values stay in zeroing private memory.
pub fn acquire(layout: &Layout, job: &Job) -> Result<SourceSecrets, ExtError> {
    acquire_with_timeout(layout, job, Duration::from_secs(10))
}

#[cfg(test)]
#[path = "import_secrets_tests.rs"]
mod tests;
