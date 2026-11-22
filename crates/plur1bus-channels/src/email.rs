//! Blocking IMAP, SMTP and MIME. The host owns socket authorization, verified TLS and mailbox state.
pub mod imap;
pub mod mime;
pub mod smtp;
mod wire;

pub use crate::stream::TimedStream;
use serde::Serialize;
use std::fmt;
use std::io;
use std::time::{Duration, Instant};

pub trait Ports {
    /// Authorize the destination, pin the remote socket address and connect before the deadline.
    fn connect(&self, host: &str, port: u16, deadline: Instant)
        -> io::Result<Box<dyn TimedStream>>;
    /// Upgrade the same socket and validate the certificate for host before returning it.
    fn upgrade(
        &self,
        host: &str,
        stream: Box<dyn TimedStream>,
        deadline: Instant,
    ) -> io::Result<Box<dyn TimedStream>>;
}

#[derive(Clone, Copy)]
pub enum Security {
    Tls,
    StartTls,
}

pub struct Options<'a> {
    pub host: &'a str,
    pub port: u16,
    pub user: &'a str,
    pub password: &'a str,
    pub security: Security,
    pub timeout: Duration,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    Auth,
    Tls,
    Protocol,
    Network,
    Timeout,
    Temporary,
    Permanent,
    State,
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct Error {
    pub kind: Kind,
    pub message: &'static str,
}

impl Error {
    pub(crate) fn new(kind: Kind, message: &'static str) -> Self {
        Self { kind, message }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message)
    }
}

impl std::error::Error for Error {}
