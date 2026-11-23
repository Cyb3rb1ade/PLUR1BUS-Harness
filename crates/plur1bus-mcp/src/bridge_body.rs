//! Response boundary for the stdio server's HTTP bridge.
use serde_json::Value;
use std::{io, time::Instant};

const MAX_DECODED_JSON_BYTES: usize = 1024 * 1024;

/// Only the failure class or numeric status crosses the bridge.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Timeout,
    TooLarge,
    Transport,
    InvalidJson,
    Status(u16),
}

/// The host supplies decoded bytes from the authorized connection.
pub trait Body {
    /// End the read at the given absolute deadline, inherited from the request.
    fn read_until(&mut self, buf: &mut [u8], deadline: Instant) -> io::Result<usize>;
}

/// Accept one JSON reply. A notification or rejected status has no reply body
/// to forward. The owner must close or discard the source after any outcome.
pub fn read_json(
    status: u16,
    body: &mut impl Body,
    deadline: Instant,
) -> Result<Option<Value>, Error> {
    match status {
        202 | 204 | 205 => return Ok(None),
        200..=299 => {}
        _ => return Err(Error::Status(status)),
    }
    let mut bytes = Vec::new();
    let mut buffer = [0; 8192];
    loop {
        if Instant::now() >= deadline {
            return Err(Error::Timeout);
        }
        let remaining = MAX_DECODED_JSON_BYTES - bytes.len();
        let window = remaining.saturating_add(1).min(buffer.len());
        let result = body.read_until(&mut buffer[..window], deadline);
        if Instant::now() >= deadline {
            return Err(Error::Timeout);
        }
        match result {
            Ok(0) => break,
            Ok(count) if count > window => return Err(Error::Transport),
            Ok(count) if count > remaining => return Err(Error::TooLarge),
            Ok(count) => bytes.extend_from_slice(&buffer[..count]),
            Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
            Err(err) if err.kind() == io::ErrorKind::TimedOut => return Err(Error::Timeout),
            Err(_) => return Err(Error::Transport),
        }
    }
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Ok(None);
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| Error::InvalidJson)
}
