//! Fixed Apple FM model discovery over the layout-owned private Unix socket.

use std::borrow::Cow;

use plur1bus_providers::{local::ManagedSocket, Adapter, Config, ErrorKind, Ports};

use crate::scanners::{Error, Page, Port, Result};

pub struct Managed<'a> {
    adapter: Adapter,
    host: &'a dyn Ports,
}

impl<'a> Managed<'a> {
    pub fn new(socket: ManagedSocket, host: &'a dyn Ports) -> Result<Self> {
        let adapter = Adapter::managed_apple_fm(socket, Config::default())
            .map_err(|_| Error::invalid("invalid_managed_transport"))?;
        Ok(Self { adapter, host })
    }
}

impl Port for Managed<'_> {
    fn get(&mut self, page: Page<'_>) -> Result<Vec<u8>> {
        if page.path != "/models" || !page.query.is_empty() || !page.headers.is_empty() {
            return Err(Error::invalid("managed_request_surface"));
        }
        let (status, bytes) = self
            .adapter
            .managed_probe_bytes(self.host, false, page.deadline, page.max_bytes)
            .map_err(|error| match error.kind {
                ErrorKind::Aborted => Error::network("aborted"),
                ErrorKind::Timeout => Error::network("scan_timeout"),
                _ if error.code.as_deref() == Some("response_too_large") => {
                    Error::invalid("response_too_large")
                }
                _ => Error::network("unavailable"),
            })?;
        if (200..300).contains(&status) {
            return Ok(bytes);
        }
        let mut error = Error::http_status(status);
        error.reason = Cow::Owned(format!("http_{status}"));
        Err(error)
    }
}
