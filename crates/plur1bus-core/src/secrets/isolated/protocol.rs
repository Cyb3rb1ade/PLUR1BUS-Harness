//! What travels between the core and a secret helper process (`secrets/isolated-protocol.ts`), and how.
//!
//! The TypeScript core talks to its helper over Node's IPC channel. Here the channel is the helper's standard input and
//! output, two private pipes only the parent holds, and a message is a frame: four bytes of length (big endian), then that
//! many bytes of JSON. A value never enters an argument, an environment variable or a diagnostic.
//!
//! A request is `{ protocol, id, backend, operation, args }`, a reply `{ id, value?, registrations, error? }`: the members
//! of the TypeScript messages, with the protocol id added so that a helper of another version refuses instead of guessing.
//! Both ends are always the same executable, so the format is private to it.
use crate::secrets::error::{SecretError, SecretErrorCode};
use crate::secrets::types::{BackendKind, BackendProbe, SecretMeta};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::io::{self, Read, Write};

/// The id every request carries.
pub const PROTOCOL: &str = "plur1bus.secrets-helper/1";

/// The largest frame either end accepts. A value is at most 64 KiB (six times that when every character is escaped); the
/// rest is room for a long `list`.
pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

/// Which backend a helper serves (`BackendDescription`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BackendDescription {
    /// The OS keyring, for the credentials of one service.
    Keyring {
        /// The service name (one per home).
        service: String,
    },
    /// The encrypted file backend in one directory.
    File {
        /// The directory (`state/secrets`).
        dir: String,
    },
}

impl BackendDescription {
    /// The kind of backend described.
    pub fn kind(&self) -> BackendKind {
        match self {
            BackendDescription::Keyring { .. } => BackendKind::Keyring,
            BackendDescription::File { .. } => BackendKind::File,
        }
    }

    /// `{ kind: "keyring", service }` or `{ kind: "file", dir }`.
    pub fn to_json(&self) -> Value {
        match self {
            BackendDescription::Keyring { service } => {
                json!({ "kind": "keyring", "service": service })
            }
            BackendDescription::File { dir } => json!({ "kind": "file", "dir": dir }),
        }
    }

    /// The description in a request, or `None` when it is not one.
    pub fn from_json(value: &Value) -> Option<BackendDescription> {
        let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_owned);
        match value.get("kind").and_then(Value::as_str)? {
            "keyring" => Some(BackendDescription::Keyring {
                service: text("service")?,
            }),
            "file" => Some(BackendDescription::File { dir: text("dir")? }),
            _ => None,
        }
    }
}

/// What a request asks for (`BackendOperation`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Operation {
    /// `probe`
    Probe,
    /// `get`: `[name]`
    Get,
    /// `put`: `[name, value, nowMs, updatedBy | null, description | null]`
    Put,
    /// `describe`: `[name, description, nowMs, updatedBy | null]`
    Describe,
    /// `delete`: `[name, tombstoneAtMs | null]`
    Delete,
    /// `list`
    List,
    /// `tombstones`
    Tombstones,
    /// `clearTombstone`: `[name]`
    ClearTombstone,
}

impl Operation {
    /// Every operation.
    pub const ALL: [Operation; 8] = [
        Operation::Probe,
        Operation::Get,
        Operation::Put,
        Operation::Describe,
        Operation::Delete,
        Operation::List,
        Operation::Tombstones,
        Operation::ClearTombstone,
    ];

    /// The name on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            Operation::Probe => "probe",
            Operation::Get => "get",
            Operation::Put => "put",
            Operation::Describe => "describe",
            Operation::Delete => "delete",
            Operation::List => "list",
            Operation::Tombstones => "tombstones",
            Operation::ClearTombstone => "clearTombstone",
        }
    }

    /// The operation of a wire name.
    pub fn from_wire(name: &str) -> Option<Operation> {
        Operation::ALL.into_iter().find(|op| op.as_str() == name)
    }
}

/// The answer to anything that is not a `SecretError` (`secret backend operation failed`): no cause travels with it.
pub fn operation_failed() -> SecretError {
    SecretError::new(SecretErrorCode::Storage, "secret backend operation failed")
}

/// A request for an operation this helper does not have.
pub fn unknown_operation() -> SecretError {
    SecretError::new(SecretErrorCode::Storage, "unknown secret backend operation")
}

/// What a caller gets when the helper is gone, hangs or cannot be started.
pub fn store_unavailable() -> SecretError {
    SecretError::new(
        SecretErrorCode::BackendUnavailable,
        "Secret-Store unavailable",
    )
}

/// One request.
pub fn request(
    id: u64,
    backend: &BackendDescription,
    operation: Operation,
    args: &[Value],
) -> Value {
    json!({
        "protocol": PROTOCOL,
        "id": id,
        "backend": backend.to_json(),
        "operation": operation.as_str(),
        "args": args,
    })
}

/// The error a reply carries. A code outside the store's vocabulary, or anything that is not an error object, is
/// [`operation_failed`].
pub fn error_from_json(value: &Value) -> SecretError {
    let code = value
        .get("code")
        .and_then(Value::as_str)
        .and_then(SecretErrorCode::from_wire);
    let message = value.get("message").and_then(Value::as_str);
    match (code, message) {
        (Some(code), Some(message)) => SecretError::with_detail(
            code,
            message,
            match value.get("detail") {
                Some(Value::Object(detail)) => Value::Object(detail.clone()),
                _ => Value::Object(Map::new()),
            },
        ),
        _ => operation_failed(),
    }
}

/// `{ available, reason? }`.
pub fn probe_to_json(probe: &BackendProbe) -> Value {
    match &probe.reason {
        Some(reason) => json!({ "available": probe.available, "reason": reason }),
        None => json!({ "available": probe.available }),
    }
}

/// The probe of a reply.
pub fn probe_from_json(value: &Value) -> Option<BackendProbe> {
    Some(BackendProbe {
        available: value.get("available")?.as_bool()?,
        reason: match value.get("reason") {
            None | Some(Value::Null) => None,
            Some(reason) => Some(reason.as_str()?.to_owned()),
        },
    })
}

/// The metadata of a reply (the object [`SecretMeta::to_json`] writes).
pub fn meta_from_json(value: &Value) -> Option<SecretMeta> {
    let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_owned);
    let optional = |key: &str| match value.get(key) {
        None | Some(Value::Null) => Some(None),
        Some(member) => member.as_str().map(|s| Some(s.to_owned())),
    };
    Some(SecretMeta {
        name: text("name")?,
        backend: match value.get("backend")?.as_str()? {
            "keyring" => BackendKind::Keyring,
            "file" => BackendKind::File,
            "memory" => BackendKind::Memory,
            _ => return None,
        },
        created_at: text("createdAt")?,
        updated_at: text("updatedAt")?,
        updated_by: optional("updatedBy")?,
        description: optional("description")?,
    })
}

/// The tombstones of a reply: name to ISO time.
pub fn tombstones_from_json(value: &Value) -> Option<BTreeMap<String, String>> {
    value
        .as_object()?
        .iter()
        .map(|(name, at)| Some((name.clone(), at.as_str()?.to_owned())))
        .collect()
}

/// The bytes of one frame, or `None` when the message is larger than a frame may be.
pub fn encode_frame(message: &Value) -> Option<Vec<u8>> {
    let body = serde_json::to_vec(message).ok()?;
    if body.is_empty() || body.len() > MAX_FRAME_BYTES {
        return None;
    }
    let length = u32::try_from(body.len()).ok()?;
    let mut frame = Vec::with_capacity(body.len() + 4);
    frame.extend_from_slice(&length.to_be_bytes());
    frame.extend_from_slice(&body);
    Some(frame)
}

/// Reads one frame. `Ok(None)` is the clean end: the other side closed between two frames. An end inside a frame, a
/// length no frame may have and bytes that are not JSON are errors.
pub fn read_frame(input: &mut impl Read) -> io::Result<Option<Value>> {
    let mut header = [0u8; 4];
    let mut got = 0;
    while got < header.len() {
        match input.read(&mut header[got..]) {
            Ok(0) if got == 0 => return Ok(None),
            Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
            Ok(n) => got += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 || length > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "a length no frame may have",
        ));
    }
    let mut body = vec![0u8; length];
    input.read_exact(&mut body)?;
    serde_json::from_slice(&body)
        .map(Some)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "a frame that is not JSON"))
}

/// Writes one encoded frame and flushes.
pub fn write_bytes(out: &mut impl Write, frame: &[u8]) -> io::Result<()> {
    out.write_all(frame)?;
    out.flush()
}
