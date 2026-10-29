//! Read-only SFTP session with host pinning and shared cumulative run budgets.
use crate::connection::{before, HostKey, KeyBytes, PinnedConnection};
use crate::protocol::{Connect, HostIdentity, Limits, Metadata, READ_BYTES};
use crate::Failure;
use russh::client;
use russh_sftp::client::{error::Error as SftpError, RawSftpSession};
use russh_sftp::protocol::{FileAttributes, OpenFlags, StatusCode};
use std::collections::BTreeSet;
use std::time::Instant;

fn sftp_error(error: SftpError) -> Failure {
    match error {
        SftpError::Status(status) => match status.status_code {
            StatusCode::NoSuchFile => Failure::NotFound,
            StatusCode::PermissionDenied => Failure::PermissionDenied,
            _ => Failure::Protocol,
        },
        SftpError::Timeout => Failure::Timeout,
        SftpError::Limited(_) => Failure::Limit,
        _ => Failure::Protocol,
    }
}

async fn remote<T>(
    deadline: Instant,
    future: impl std::future::Future<Output = Result<T, SftpError>>,
) -> Result<T, Failure> {
    before(deadline, future).await?.map_err(sftp_error)
}

fn metadata(attrs: FileAttributes) -> Result<Metadata, Failure> {
    let kind = match attrs.permissions.unwrap_or(0) & 0o170000 {
        0o100000 => "file",
        0o040000 => "directory",
        0o120000 => "symlink",
        _ => "other",
    };
    let size = if kind == "file" {
        attrs.size.ok_or(Failure::Protocol)?
    } else {
        attrs.size.unwrap_or(0)
    };
    if size > 9_007_199_254_740_991 {
        return Err(Failure::Protocol);
    }
    Ok(Metadata {
        kind,
        size,
        mtime_ms: attrs.mtime.map(|time| u64::from(time) * 1000),
    })
}

struct Budget {
    limits: Limits,
    deadline: Instant,
    bytes: u64,
    entries: u64,
    requests: u64,
}
impl Budget {
    fn check(&self) -> Result<(), Failure> {
        if Instant::now() >= self.deadline {
            Err(Failure::Timeout)
        } else {
            Ok(())
        }
    }
    fn request(&mut self) -> Result<(), Failure> {
        self.check()?;
        if self.requests >= self.limits.requests {
            return Err(Failure::Limit);
        }
        self.requests += 1;
        Ok(())
    }
    fn path(&mut self, path: &str) -> Result<(), Failure> {
        self.request()?;
        if path.len() > 8192
            || !path.starts_with('/')
            || path.contains('\\')
            || path.chars().any(char::is_control)
            || path
                .split('/')
                .skip(1)
                .any(|part| matches!(part, "." | "..") || (part.is_empty() && path != "/"))
            || path.split('/').filter(|part| !part.is_empty()).count() > self.limits.depth
        {
            return Err(Failure::PathDenied);
        }
        Ok(())
    }
}

/// A pinned, authenticated session exposing no writes, execution or raw transport.
pub struct ReadonlySession {
    identity: HostIdentity,
    ssh: client::Handle<HostKey>,
    sftp: RawSftpSession,
    budget: Budget,
}

impl ReadonlySession {
    /// Completes key exchange and pinning before public-key authentication; wipes supplied key bytes on every path.
    pub async fn connect(config: &Connect, key: &mut [u8]) -> Result<Self, Failure> {
        let key = KeyBytes(key);
        let pinned = PinnedConnection::prepare(config).await?;
        Self::authenticate(config, pinned, key.0).await
    }

    pub(crate) async fn authenticate(
        config: &Connect,
        pinned: PinnedConnection,
        key: &mut [u8],
    ) -> Result<Self, Failure> {
        let (ssh, sftp, identity, deadline) = pinned.authenticate(config, key).await?;
        Ok(Self {
            identity,
            ssh,
            sftp,
            budget: Budget {
                limits: config.limits.clone(),
                deadline,
                bytes: 0,
                entries: 0,
                requests: 0,
            },
        })
    }

    /// Key exchange only: takes no private key and sends no authentication or filesystem request.
    pub async fn probe(config: &Connect) -> Result<HostIdentity, Failure> {
        crate::connection::probe(config).await
    }

    /// The authenticated server's identity, available without any filesystem read.
    pub fn host_identity(&self) -> &HostIdentity {
        &self.identity
    }

    /// Follows the final symlink for metadata.
    pub async fn stat(&mut self, path: &str) -> Result<Metadata, Failure> {
        self.budget.path(path)?;
        metadata(
            remote(self.budget.deadline, self.sftp.stat(path))
                .await?
                .attrs,
        )
    }

    /// Returns final-link metadata without following it.
    pub async fn lstat(&mut self, path: &str) -> Result<Metadata, Failure> {
        self.budget.path(path)?;
        metadata(
            remote(self.budget.deadline, self.sftp.lstat(path))
                .await?
                .attrs,
        )
    }

    /// Lists immediate names under cumulative entry, packet, encoded metadata and operation budgets.
    pub async fn readdir(&mut self, path: &str) -> Result<Vec<String>, Failure> {
        self.budget.path(path)?;
        let handle = remote(self.budget.deadline, self.sftp.opendir(path))
            .await?
            .handle;
        let result = self.directory(&handle).await;
        let closed = remote(self.budget.deadline, self.sftp.close(handle)).await;
        match result {
            Ok(names) => {
                closed?;
                Ok(names)
            }
            Err(error) => Err(error),
        }
    }

    async fn directory(&mut self, handle: &str) -> Result<Vec<String>, Failure> {
        let mut names = BTreeSet::new();
        let mut encoded = 2;
        loop {
            self.budget.request()?;
            let page = match before(self.budget.deadline, self.sftp.readdir(handle)).await? {
                Ok(page) => page,
                Err(SftpError::Status(status)) if status.status_code == StatusCode::Eof => break,
                Err(error) => return Err(sftp_error(error)),
            };
            if page.files.is_empty() {
                return Err(Failure::Protocol);
            }
            for file in page.files {
                if self.budget.entries >= self.budget.limits.entries {
                    return Err(Failure::Limit);
                }
                self.budget.entries += 1;
                let name = file.filename;
                if matches!(name.as_str(), "." | "..") {
                    continue;
                }
                if name.is_empty()
                    || name.len() > 8192
                    || name.contains(['/', '\\'])
                    || name.chars().any(char::is_control)
                {
                    return Err(Failure::Protocol);
                }
                encoded += serde_json::to_vec(&name)
                    .map_err(|_| Failure::Protocol)?
                    .len()
                    + 1;
                if encoded > self.budget.limits.metadata_bytes.saturating_sub(128) {
                    return Err(Failure::Limit);
                }
                if !names.insert(name) {
                    return Err(Failure::Protocol);
                }
            }
        }
        Ok(names.into_iter().collect())
    }

    /// Reads at most 64KiB at an offset; file size, offset range and remaining total are checked before reading.
    pub async fn read(&mut self, path: &str, offset: u64, length: u32) -> Result<Vec<u8>, Failure> {
        self.budget.path(path)?;
        if length > READ_BYTES
            // SFTP DATA carries a type, request id and byte-string length before its bytes.
            || length.saturating_add(9) > self.budget.limits.packet_bytes
            || offset
                .checked_add(u64::from(length))
                .is_none_or(|end| end > self.budget.limits.file_bytes)
            || u64::from(length)
                > self
                    .budget
                    .limits
                    .read_bytes
                    .saturating_sub(self.budget.bytes)
        {
            return Err(Failure::Limit);
        }
        let handle = remote(
            self.budget.deadline,
            self.sftp
                .open(path, OpenFlags::READ, FileAttributes::default()),
        )
        .await?
        .handle;
        let result = self.file(&handle, offset, length).await;
        let closed = remote(self.budget.deadline, self.sftp.close(handle)).await;
        let bytes = match result {
            Ok(bytes) => {
                closed?;
                bytes
            }
            Err(error) => return Err(error),
        };
        self.budget.bytes += bytes.len() as u64;
        Ok(bytes)
    }

    async fn file(&self, handle: &str, offset: u64, length: u32) -> Result<Vec<u8>, Failure> {
        let attrs = metadata(
            remote(self.budget.deadline, self.sftp.fstat(handle))
                .await?
                .attrs,
        )?;
        if attrs.kind != "file" {
            return Err(Failure::UnsupportedType);
        }
        if attrs.size > self.budget.limits.file_bytes {
            return Err(Failure::Limit);
        }
        if length == 0 {
            return Ok(Vec::new());
        }
        match before(self.budget.deadline, self.sftp.read(handle, offset, length)).await? {
            Ok(reply) if reply.data.len() <= length as usize => Ok(reply.data),
            Ok(_) => Err(Failure::Protocol),
            Err(SftpError::Status(status)) if status.status_code == StatusCode::Eof => {
                Ok(Vec::new())
            }
            Err(error) => Err(sftp_error(error)),
        }
    }

    /// Returns one canonical absolute path.
    pub async fn realpath(&mut self, path: &str) -> Result<String, Failure> {
        self.budget.path(path)?;
        let reply = remote(self.budget.deadline, self.sftp.realpath(path)).await?;
        let target = one_path(reply.files)?;
        if !target.starts_with('/')
            || target.contains('\\')
            || target.split('/').any(|part| matches!(part, "." | ".."))
        {
            return Err(Failure::Protocol);
        }
        Ok(target)
    }

    /// Returns one link target; the host port checks root containment before following it.
    pub async fn readlink(&mut self, path: &str) -> Result<String, Failure> {
        self.budget.path(path)?;
        one_path(
            remote(self.budget.deadline, self.sftp.readlink(path))
                .await?
                .files,
        )
    }

    /// Ends SFTP and SSH without filesystem mutations.
    pub async fn close(self) -> Result<(), Failure> {
        let _ = self.sftp.close_session();
        before(
            self.budget.deadline,
            self.ssh
                .disconnect(russh::Disconnect::ByApplication, "", ""),
        )
        .await?
        .map_err(|_| Failure::Unavailable)
    }
}

fn one_path(mut files: Vec<russh_sftp::protocol::File>) -> Result<String, Failure> {
    if files.len() != 1 {
        return Err(Failure::Protocol);
    }
    let path = files.remove(0).filename;
    if path.is_empty() || path.len() > 8192 || path.chars().any(char::is_control) {
        return Err(Failure::Protocol);
    }
    Ok(path)
}

impl Drop for ReadonlySession {
    fn drop(&mut self) {
        let _ = self.sftp.close_session();
    }
}
