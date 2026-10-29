//! Real in-process, public-key-only, read-only SSH/SFTP fixture. Its host key exists only in memory.
#![allow(dead_code)]
use russh::keys::{
    ssh_key::{Algorithm, HashAlg},
    PrivateKey, PublicKey,
};
use russh::server::{Auth, Msg, Server as _, Session};
use russh::{Channel, ChannelId};
use russh_sftp::protocol::{
    Attrs, Data, File, FileAttributes, Handle, Name, OpenFlags, Status, StatusCode,
};
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::time::{Duration, UNIX_EPOCH};

/// Portable virtual link, so tests need no Windows symlink privilege.
pub const LINK: &str = "/__fixture_link__";
/// Link target also names an actual test file under the selected root.
pub const LINK_TARGET: &str = "/first-home/config.json";

#[derive(Default)]
pub struct Counts {
    pub auth: AtomicUsize,
    pub reads: AtomicUsize,
    pub filesystem: AtomicUsize,
}

pub struct Fixture {
    pub ip: String,
    pub port: u16,
    pub fingerprint: String,
    pub counts: Arc<Counts>,
    shutdown: russh::server::RunningServerHandle,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.shutdown.shutdown("test complete".into());
        self.task.abort();
    }
}

/// Binds only loopback port zero and admits only the exact supplied public key; all mutation methods are denied.
pub async fn start(root: PathBuf, authorized: PublicKey, read_delay: Duration) -> Fixture {
    let root = std::fs::canonicalize(root).unwrap();
    assert!(root.is_dir());
    let host = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    let fingerprint = host.public_key().fingerprint(HashAlg::Sha256).to_string();
    let config = Arc::new(russh::server::Config {
        keys: vec![host],
        auth_rejection_time: Duration::ZERO,
        auth_rejection_time_initial: Some(Duration::ZERO),
        ..Default::default()
    });
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let address = listener.local_addr().unwrap();
    let counts = Arc::new(Counts::default());
    let mut server = Server {
        root: Arc::new(root),
        authorized,
        counts: counts.clone(),
        read_delay,
    };
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        let running = server.run_on_socket(config, &listener);
        let _ = sender.send(running.handle());
        let _ = running.await;
    });
    Fixture {
        ip: address.ip().to_string(),
        port: address.port(),
        fingerprint,
        counts,
        shutdown: receiver.await.unwrap(),
        task,
    }
}

struct Server {
    root: Arc<PathBuf>,
    authorized: PublicKey,
    counts: Arc<Counts>,
    read_delay: Duration,
}
impl russh::server::Server for Server {
    type Handler = Ssh;
    fn new_client(&mut self, _peer: Option<std::net::SocketAddr>) -> Ssh {
        Ssh {
            root: self.root.clone(),
            authorized: self.authorized.clone(),
            counts: self.counts.clone(),
            channels: HashMap::new(),
            read_delay: self.read_delay,
        }
    }
}

struct Ssh {
    root: Arc<PathBuf>,
    authorized: PublicKey,
    counts: Arc<Counts>,
    channels: HashMap<ChannelId, Channel<Msg>>,
    read_delay: Duration,
}
impl russh::server::Handler for Ssh {
    type Error = russh::Error;
    async fn auth_publickey(&mut self, _user: &str, key: &PublicKey) -> Result<Auth, Self::Error> {
        self.counts.auth.fetch_add(1, Ordering::SeqCst);
        Ok(if key == &self.authorized {
            Auth::Accept
        } else {
            Auth::reject()
        })
    }
    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        reply: russh::server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.channels.insert(channel.id(), channel);
        reply.accept().await;
        Ok(())
    }
    async fn subsystem_request(
        &mut self,
        id: ChannelId,
        name: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if name != "sftp" {
            session.channel_failure(id)?;
            return Ok(());
        }
        let Some(channel) = self.channels.remove(&id) else {
            session.channel_failure(id)?;
            return Ok(());
        };
        session.channel_success(id)?;
        let handler = Sftp {
            root: self.root.clone(),
            counts: self.counts.clone(),
            dirs: HashMap::new(),
            read_delay: self.read_delay,
        };
        russh_sftp::server::run(channel.into_stream(), handler).await;
        Ok(())
    }
}

struct Sftp {
    root: Arc<PathBuf>,
    counts: Arc<Counts>,
    dirs: HashMap<String, VecDeque<File>>,
    read_delay: Duration,
}

fn io_error(error: std::io::Error) -> StatusCode {
    if error.kind() == std::io::ErrorKind::NotFound {
        StatusCode::NoSuchFile
    } else {
        StatusCode::PermissionDenied
    }
}

fn attributes(metadata: &std::fs::Metadata) -> FileAttributes {
    #[cfg(unix)]
    let permission_bits = {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o777
    };
    #[cfg(not(unix))]
    let permission_bits = if metadata.permissions().readonly() {
        0o444
    } else {
        0o666
    };
    let kind = if metadata.is_file() {
        0o100000
    } else if metadata.is_dir() {
        0o040000
    } else if metadata.is_symlink() {
        0o120000
    } else {
        0
    };
    FileAttributes {
        size: Some(metadata.len()),
        permissions: Some(kind | permission_bits),
        mtime: metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|time| time.as_secs() as u32),
        ..Default::default()
    }
}

impl Sftp {
    fn path(&self, path: &str, follow: bool) -> Result<PathBuf, StatusCode> {
        let path = if path == LINK && follow {
            LINK_TARGET
        } else {
            path
        };
        if !path.starts_with('/') || path.contains(['\\', '\0']) {
            return Err(StatusCode::PermissionDenied);
        }
        let mut candidate = self.root.as_ref().clone();
        for part in Path::new(path).components() {
            match part {
                Component::RootDir => {}
                Component::Normal(part) => candidate.push(part),
                _ => return Err(StatusCode::PermissionDenied),
            }
        }
        let checked = if follow {
            std::fs::canonicalize(&candidate).map_err(io_error)?
        } else if candidate == *self.root {
            candidate.clone()
        } else {
            std::fs::canonicalize(candidate.parent().ok_or(StatusCode::PermissionDenied)?)
                .map_err(io_error)?
                .join(candidate.file_name().ok_or(StatusCode::PermissionDenied)?)
        };
        if !checked.starts_with(self.root.as_ref()) {
            return Err(StatusCode::PermissionDenied);
        }
        Ok(checked)
    }
    fn attrs(&self, path: &str, follow: bool) -> Result<FileAttributes, StatusCode> {
        self.counts.filesystem.fetch_add(1, Ordering::SeqCst);
        if path == LINK && !follow {
            return Ok(FileAttributes {
                permissions: Some(0o120444),
                size: Some(LINK_TARGET.len() as u64),
                ..Default::default()
            });
        }
        let path = self.path(path, follow)?;
        let metadata = if follow {
            std::fs::metadata(path)
        } else {
            std::fs::symlink_metadata(path)
        }
        .map_err(io_error)?;
        Ok(attributes(&metadata))
    }
}

impl russh_sftp::server::Handler for Sftp {
    type Error = StatusCode;
    fn unimplemented(&self) -> StatusCode {
        StatusCode::PermissionDenied
    }
    async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, StatusCode> {
        Ok(Attrs {
            id,
            attrs: self.attrs(&path, true)?,
        })
    }
    async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, StatusCode> {
        Ok(Attrs {
            id,
            attrs: self.attrs(&path, false)?,
        })
    }
    async fn fstat(&mut self, id: u32, handle: String) -> Result<Attrs, StatusCode> {
        Ok(Attrs {
            id,
            attrs: self.attrs(&handle, true)?,
        })
    }
    async fn open(
        &mut self,
        id: u32,
        path: String,
        flags: OpenFlags,
        _attrs: FileAttributes,
    ) -> Result<Handle, StatusCode> {
        if flags.bits() != OpenFlags::READ.bits() || !self.path(&path, true)?.is_file() {
            return Err(StatusCode::PermissionDenied);
        }
        Ok(Handle { id, handle: path })
    }
    async fn close(&mut self, id: u32, handle: String) -> Result<Status, StatusCode> {
        self.dirs.remove(&handle);
        Ok(Status {
            id,
            status_code: StatusCode::Ok,
            error_message: String::new(),
            language_tag: String::new(),
        })
    }
    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        length: u32,
    ) -> Result<Data, StatusCode> {
        self.counts.reads.fetch_add(1, Ordering::SeqCst);
        tokio::time::sleep(self.read_delay).await;
        let mut file = std::fs::File::open(self.path(&handle, true)?).map_err(io_error)?;
        file.seek(SeekFrom::Start(offset)).map_err(io_error)?;
        let mut data = vec![0; length.min(64 << 10) as usize];
        let length = file.read(&mut data).map_err(io_error)?;
        data.truncate(length);
        if data.is_empty() {
            return Err(StatusCode::Eof);
        }
        Ok(Data { id, data })
    }
    async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, StatusCode> {
        self.counts.filesystem.fetch_add(1, Ordering::SeqCst);
        let directory = self.path(&path, true)?;
        let mut files = Vec::new();
        for entry in std::fs::read_dir(directory).map_err(io_error)? {
            let entry = entry.map_err(io_error)?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| StatusCode::Failure)?;
            files.push(File::new(
                name,
                attributes(&std::fs::symlink_metadata(entry.path()).map_err(io_error)?),
            ));
            if files.len() > 100_000 {
                return Err(StatusCode::Failure);
            }
        }
        files.sort_by(|a, b| a.filename.cmp(&b.filename));
        self.dirs.insert(path.clone(), files.into());
        Ok(Handle { id, handle: path })
    }
    async fn readdir(&mut self, id: u32, handle: String) -> Result<Name, StatusCode> {
        let files = self.dirs.get_mut(&handle).ok_or(StatusCode::Failure)?;
        if files.is_empty() {
            return Err(StatusCode::Eof);
        }
        Ok(Name {
            id,
            files: files.drain(..files.len().min(64)).collect(),
        })
    }
    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, StatusCode> {
        self.counts.filesystem.fetch_add(1, Ordering::SeqCst);
        let canonical = self.path(&path, true)?;
        let relative = canonical
            .strip_prefix(self.root.as_ref())
            .map_err(|_| StatusCode::PermissionDenied)?;
        let path = format!("/{}", relative.to_string_lossy().replace('\\', "/"));
        Ok(Name {
            id,
            files: vec![File::dummy(path)],
        })
    }
    async fn readlink(&mut self, id: u32, path: String) -> Result<Name, StatusCode> {
        self.counts.filesystem.fetch_add(1, Ordering::SeqCst);
        let target = if path == LINK {
            LINK_TARGET.into()
        } else {
            let target = std::fs::read_link(self.path(&path, false)?).map_err(io_error)?;
            // The fixture presents a virtual SFTP root on every OS, including Windows junctions.
            match target.strip_prefix(self.root.as_ref()) {
                Ok(relative) => format!("/{}", relative.to_string_lossy().replace('\\', "/")),
                Err(_) => target.to_string_lossy().replace('\\', "/"),
            }
        };
        Ok(Name {
            id,
            files: vec![File::dummy(target)],
        })
    }
}
