//! Local provider admission and the AF1 Unix HTTP transport. The sidecar's layout and slot state
//! come from the caller. The transport never resolves or dials the synthetic Apple origin.

use crate::{ErrorKind, Json, ProviderError};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use url::Url;

mod probe;
pub use probe::{probe_endpoint, Dialect, LocalModel, ProbeOptions, ProbeResult, ProbeState};

pub const APPLE_FM_BASE_URL: &str = "http://apple-fm.invalid/v1";

#[derive(Debug)]
pub struct ManagedSocket {
    path: PathBuf,
    pub(crate) active: Mutex<()>,
}

impl ManagedSocket {
    pub fn new(path: PathBuf) -> Result<Self, ProviderError> {
        if !path.is_absolute() || path.as_os_str().as_encoded_bytes().contains(&0) {
            return Err(ProviderError::invalid(
                "managed Unix socket needs the apple-fm id and an absolute layout path",
            ));
        }
        Ok(Self {
            path,
            active: Mutex::new(()),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn admit(
        &self,
        request: &Json,
    ) -> Result<std::sync::MutexGuard<'_, ()>, ProviderError> {
        if request["model"].text() != "system" {
            let mut e = ProviderError::new(
                ErrorKind::InvalidRequest,
                "Apple FM only allows the on-device system model",
            );
            e.code = Some("model_not_allowed".into());
            return Err(e);
        }
        if request.get("reasoning").is_some() {
            return Err(ProviderError::new(
                ErrorKind::InvalidRequest,
                "Apple FM does not support a reasoning directive",
            ));
        }
        if request["messages"].items().iter().any(|msg| {
            msg["role"].text() == "user"
                && msg["content"]
                    .items()
                    .iter()
                    .any(|part| part["type"].text() == "image_url")
        }) {
            return Err(ProviderError::new(
                ErrorKind::InvalidRequest,
                "Apple FM does not accept image parts",
            ));
        }
        self.active.try_lock().map_err(|_| {
            let mut e = ProviderError::new(ErrorKind::Network, "Apple FM inference is busy");
            e.code = Some("busy".into());
            e.retryable = false;
            e
        })
    }

    /// Verify the layout-owned path with fresh metadata. A non-Unix host always refuses before I/O.
    pub fn verify(&self, euid: Option<u32>) -> Result<(), ProviderError> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::{FileTypeExt, MetadataExt};
            if self.path.as_os_str().as_encoded_bytes().len() > 103 {
                return Err(unavailable("socket-path-too-long"));
            }
            let refused = || unavailable("socket-untrusted");
            let uid = euid.ok_or_else(refused)?;
            let parent = self.path.parent().ok_or_else(refused)?;
            for dir in parent.ancestors() {
                if std::fs::symlink_metadata(dir)
                    .map_err(|_| refused())?
                    .file_type()
                    .is_symlink()
                {
                    return Err(refused());
                }
            }
            let directory = std::fs::symlink_metadata(parent).map_err(|_| refused())?;
            let socket = std::fs::symlink_metadata(&self.path).map_err(|_| refused())?;
            if !directory.is_dir()
                || directory.uid() != uid
                || directory.mode() & 0o777 != 0o700
                || !socket.file_type().is_socket()
                || socket.uid() != uid
            {
                return Err(refused());
            }
            Ok(())
        }
        #[cfg(not(unix))]
        {
            let _ = euid;
            Err(unavailable("platform"))
        }
    }
}

pub fn is_loopback(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && match url.host() {
            Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
            Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
            Some(url::Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
            None => false,
        }
}

pub(crate) fn unavailable(reason: &str) -> ProviderError {
    let hint = if reason == "socket-path-too-long" {
        "; use a shorter PLUR1BUS_HOME"
    } else {
        ""
    };
    let mut error = ProviderError::new(
        ErrorKind::Network,
        format!("managed Unix provider is unavailable ({reason}){hint}"),
    );
    error.retryable = false;
    error.code = Some(reason.into());
    error
}

pub(crate) fn managed_failure(error: ProviderError) -> ProviderError {
    let message = error.provider_message.as_deref().unwrap_or_default();
    let word = |w| {
        message
            .split(|c: char| !c.is_alphanumeric())
            .any(|s| s.eq_ignore_ascii_case(w))
    };
    if error.kind == ErrorKind::ContextLength
        || ((error.status.is_none() || error.status == Some(500))
            && (error.kind == ErrorKind::Overloaded
                || error.provider_type.as_deref() == Some("server_error"))
            && (word("session") || word("transcript"))
            && word("exceeded")
            && word("context"))
    {
        let mut e = ProviderError::new(
            ErrorKind::InvalidRequest,
            "Apple FM request exceeds the model context window",
        );
        e.code = Some("context_overflow".into());
        e.status = error.status;
        return e;
    }
    error
}

#[cfg(unix)]
pub(crate) use unix::UnixConnector;

#[cfg(unix)]
mod unix {
    use crate::transport::{
        await_connect, socket_error, HttpCancellation, SocketDeadline, SocketTransport,
    };
    use std::os::fd::OwnedFd;
    use std::os::unix::net::UnixStream;
    use std::path::PathBuf;
    use std::time::{Duration, Instant};
    use ureq::unversioned::transport::{ConnectionDetails, Connector};

    #[derive(Debug)]
    pub(crate) struct UnixConnector(pub PathBuf, pub SocketDeadline, pub HttpCancellation);

    impl Connector for UnixConnector {
        type Out = SocketTransport;

        fn connect(
            &self,
            details: &ConnectionDetails<'_>,
            _: Option<()>,
        ) -> Result<Option<Self::Out>, ureq::Error> {
            let timeout = self.1.bound(details.timeout)?;
            let deadline = Instant::now() + (*timeout.after).min(Duration::from_secs(2));
            let mut stream = mio::net::UnixStream::connect(&self.0)
                .map_err(|error| socket_error(error, timeout))?;
            await_connect(
                &mut stream,
                deadline,
                &|| self.2.cancelled(),
                |stream| match stream.take_error()? {
                    Some(error) => Err(error),
                    None => stream.peer_addr().map(|_| ()),
                },
            )
            .map_err(|error| socket_error(error, timeout))?;
            let stream: UnixStream = stream.into();
            stream.set_nonblocking(false)?;
            Ok(Some(SocketTransport::new(
                OwnedFd::from(stream).into(),
                details,
                self.1,
                Some(self.2.clone()),
            )?))
        }
    }
}
