//! S0 research only: real SSH wire traffic on ephemeral loopback sockets.
//! No user configuration, credential store, remote shell, or product entry point.
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};

use russh::keys::{
    agent, Algorithm, PrivateKey, PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate,
};
use russh::{client, server, Channel, ChannelId, ChannelMsg};
use russh_sftp::protocol::{Data, FileAttributes, Handle, OpenFlags, Status, StatusCode};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use zeroize::Zeroizing;

type Error = Box<dyn std::error::Error + Send + Sync>;
type Connection = client::Handle<PinnedHost>;
const USER: &str = "spike";
const UPLOAD_BYTES: usize = 50 * 1024 * 1024;

struct PinnedHost(PublicKey);
impl client::Handler for PinnedHost {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        offered: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        Ok(matches!(offered, PublicKeyOrCertificate::PublicKey { key, .. } if key == &self.0))
    }
}

struct Fixture {
    address: SocketAddr,
    host: PublicKey,
    attempts: Arc<AtomicUsize>,
    password: Arc<Zeroizing<String>>,
    uploaded: Arc<Mutex<Vec<u8>>>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Fixture {
    async fn new(keys: Vec<PublicKey>) -> Result<Self, Error> {
        let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519)?;
        let host = key.public_key().clone();
        let password = Arc::new(Zeroizing::new(format!("{:x}", rand::random::<u128>())));
        let attempts = Arc::new(AtomicUsize::new(0));
        let uploaded = Arc::new(Mutex::new(Vec::new()));
        let handler = Peer {
            keys: Arc::new(keys),
            password: password.clone(),
            attempts: attempts.clone(),
            channels: HashMap::new(),
            uploaded: uploaded.clone(),
        };
        let config = Arc::new(server::Config {
            keys: vec![key],
            inactivity_timeout: Some(Duration::from_secs(30)),
            auth_rejection_time: Duration::from_millis(1),
            auth_rejection_time_initial: Some(Duration::from_millis(1)),
            ..Default::default()
        });
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let address = listener.local_addr()?;
        let task = tokio::spawn(async move {
            let mut sessions = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let Ok((socket, _)) = accepted else { break };
                        if socket.set_nodelay(true).is_err() { break; }
                        let config = config.clone();
                        let handler = handler.clone();
                        sessions.spawn(async move {
                            if let Ok(session) = server::run_stream(config, socket, handler).await {
                                let _ = session.await;
                            }
                        });
                    }
                    _ = sessions.join_next(), if !sessions.is_empty() => {}
                }
            }
        });
        Ok(Self {
            address,
            host,
            attempts,
            password,
            uploaded,
            task,
        })
    }
    async fn connect(&self) -> Result<Connection, Error> {
        let config = client::Config {
            nodelay: true,
            keepalive_interval: Some(Duration::from_secs(15)),
            keepalive_max: 3,
            inactivity_timeout: Some(Duration::from_secs(30)),
            ..Default::default()
        };
        Ok(client::connect(
            Arc::new(config),
            self.address,
            PinnedHost(self.host.clone()),
        )
        .await?)
    }
    async fn password_login(&self) -> Result<Connection, Error> {
        let mut client = self.connect().await?;
        assert!(client
            .authenticate_password(USER, self.password.as_str())
            .await?
            .success());
        Ok(client)
    }
}

// Only the fixture's fixed command is accepted; never executes an OS command.
struct Peer {
    keys: Arc<Vec<PublicKey>>,
    password: Arc<Zeroizing<String>>,
    attempts: Arc<AtomicUsize>,
    channels: HashMap<ChannelId, Channel<server::Msg>>,
    uploaded: Arc<Mutex<Vec<u8>>>,
}
impl Clone for Peer {
    fn clone(&self) -> Self {
        Self {
            keys: self.keys.clone(),
            password: self.password.clone(),
            attempts: self.attempts.clone(),
            channels: HashMap::new(),
            uploaded: self.uploaded.clone(),
        }
    }
}
impl server::Handler for Peer {
    type Error = russh::Error;
    async fn auth_password(
        &mut self,
        user: &str,
        password: &str,
    ) -> Result<server::Auth, Self::Error> {
        self.attempts.fetch_add(1, Ordering::SeqCst);
        Ok(if user == USER && password == self.password.as_str() {
            server::Auth::Accept
        } else {
            server::Auth::reject()
        })
    }
    async fn auth_publickey(
        &mut self,
        user: &str,
        key: &PublicKey,
    ) -> Result<server::Auth, Self::Error> {
        self.attempts.fetch_add(1, Ordering::SeqCst);
        Ok(if user == USER && self.keys.contains(key) {
            server::Auth::Accept
        } else {
            server::Auth::reject()
        })
    }
    async fn channel_open_session(
        &mut self,
        channel: Channel<server::Msg>,
        reply: server::ChannelOpenHandle,
        _: &mut server::Session,
    ) -> Result<(), Self::Error> {
        self.channels.insert(channel.id(), channel);
        reply.accept().await;
        Ok(())
    }
    async fn pty_request(
        &mut self,
        channel: ChannelId,
        _: &str,
        _: u32,
        _: u32,
        _: u32,
        _: u32,
        _: &[(russh::Pty, u32)],
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)
    }
    async fn exec_request(
        &mut self,
        channel: ChannelId,
        command: &[u8],
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        if command != b"spike-status" {
            return session.channel_failure(channel);
        }
        session.channel_success(channel)?;
        session.data(channel, b"stdout-ok".to_vec())?;
        session.extended_data(channel, 1, b"stderr-ok".to_vec())?;
        session.exit_status_request(channel, 7)?;
        session.eof(channel)?;
        session.close(channel)
    }
    async fn subsystem_request(
        &mut self,
        channel: ChannelId,
        name: &str,
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        if name != "sftp" {
            return session.channel_failure(channel);
        }
        let Some(stream) = self.channels.remove(&channel) else {
            return session.channel_failure(channel);
        };
        session.channel_success(channel)?;
        let uploaded = self.uploaded.clone();
        tokio::spawn(async move {
            russh_sftp::server::run(stream.into_stream(), Upload(uploaded)).await;
        });
        Ok(())
    }
}

// Bounded in-memory SFTP endpoint; the actual SFTP framing is the library's.
struct Upload(Arc<Mutex<Vec<u8>>>);
fn status(id: u32) -> Status {
    Status {
        id,
        status_code: StatusCode::Ok,
        error_message: String::new(),
        language_tag: String::new(),
    }
}
impl russh_sftp::server::Handler for Upload {
    type Error = StatusCode;
    fn unimplemented(&self) -> StatusCode {
        StatusCode::OpUnsupported
    }
    async fn open(
        &mut self,
        id: u32,
        filename: String,
        _: OpenFlags,
        _: FileAttributes,
    ) -> Result<Handle, StatusCode> {
        if filename != "spike.bin" {
            return Err(StatusCode::PermissionDenied);
        }
        Ok(Handle {
            id,
            handle: filename,
        })
    }
    async fn close(&mut self, id: u32, _: String) -> Result<Status, StatusCode> {
        Ok(status(id))
    }
    async fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<Status, StatusCode> {
        let offset = usize::try_from(offset).map_err(|_| StatusCode::Failure)?;
        let end = offset
            .checked_add(data.len())
            .filter(|end| *end <= UPLOAD_BYTES)
            .ok_or(StatusCode::Failure)?;
        if handle != "spike.bin" {
            return Err(StatusCode::PermissionDenied);
        }
        let mut bytes = self.0.lock().map_err(|_| StatusCode::Failure)?;
        if end > bytes.len() {
            bytes.resize(end, 0);
        }
        bytes[offset..end].copy_from_slice(&data);
        Ok(status(id))
    }
    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<Data, StatusCode> {
        if handle != "spike.bin" {
            return Err(StatusCode::PermissionDenied);
        }
        let bytes = self.0.lock().map_err(|_| StatusCode::Failure)?;
        let offset = usize::try_from(offset).map_err(|_| StatusCode::Eof)?;
        if offset >= bytes.len() {
            return Err(StatusCode::Eof);
        }
        let end = offset.saturating_add(len as usize).min(bytes.len());
        Ok(Data {
            id,
            data: bytes[offset..end].to_vec(),
        })
    }
}

async fn disconnect(connection: &Connection) -> Result<(), Error> {
    connection
        .disconnect(russh::Disconnect::ByApplication, "spike done", "")
        .await?;
    Ok(())
}

async fn exec_pty(connection: &Connection) -> Result<(), Error> {
    let mut channel = connection.channel_open_session().await?;
    channel
        .request_pty(true, "xterm", 80, 24, 0, 0, &[])
        .await?;
    assert!(matches!(channel.wait().await, Some(ChannelMsg::Success)));
    channel.exec(true, "spike-status").await?;
    let (mut stdout, mut stderr, mut exit) = (Vec::new(), Vec::new(), None);
    while let Some(message) = channel.wait().await {
        match message {
            ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
            ChannelMsg::ExtendedData { data, ext: 1 } => stderr.extend_from_slice(&data),
            ChannelMsg::ExitStatus { exit_status } => exit = Some(exit_status),
            ChannelMsg::Close => break,
            _ => {}
        }
    }
    assert_eq!(stdout, b"stdout-ok");
    assert_eq!(stderr, b"stderr-ok");
    assert_eq!(exit, Some(7));
    Ok(())
}

async fn upload(connection: &Connection, fixture: &Fixture) -> Result<f64, Error> {
    let channel = connection.channel_open_session().await?;
    channel.request_subsystem(true, "sftp").await?;
    let sftp = russh_sftp::client::SftpSession::new(channel.into_stream()).await?;
    let payload: Vec<u8> = (0..UPLOAD_BYTES).map(|n| (n % 251) as u8).collect();
    let start = Instant::now();
    let mut file = sftp.create("spike.bin").await?;
    file.write_all(&payload).await?;
    file.shutdown().await?;
    let seconds = start.elapsed().as_secs_f64();
    assert_eq!(
        Sha256::digest(&payload),
        Sha256::digest(&*fixture.uploaded.lock().map_err(|_| "upload poisoned")?)
    );
    let mut readback = sftp.open("spike.bin").await?;
    let mut bytes = Vec::new();
    readback.read_to_end(&mut bytes).await?;
    assert_eq!(Sha256::digest(&payload), Sha256::digest(&bytes));
    readback.shutdown().await?;
    sftp.close().await?;
    Ok(seconds)
}

async fn key_login(fixture: &Fixture, key: PrivateKey) -> Result<(), Error> {
    let mut connection = fixture.connect().await?;
    assert!(connection
        .authenticate_publickey(USER, PrivateKeyWithHashAlg::new(Arc::new(key), None))
        .await?
        .success());
    disconnect(&connection).await
}

#[cfg(unix)]
async fn agent_login(fixture: &Fixture, key: &PrivateKey) -> Result<(), Error> {
    let dir = tempfile::tempdir()?;
    let socket = dir.path().join("agent.sock");
    let listener = tokio::net::UnixListener::bind(&socket)?;
    let incoming = futures_util::stream::poll_fn(move |cx| {
        listener
            .poll_accept(cx)
            .map(|r| Some(r.map(|(stream, _)| stream)))
    });
    let task = tokio::spawn(agent::server::serve(incoming, ()));
    let result = async {
        let mut agent = agent::client::AgentClient::connect_uds(&socket).await?;
        agent.add_identity(key, &[]).await?;
        assert_eq!(agent.request_identities().await?.len(), 1);
        let mut connection = fixture.connect().await?;
        assert!(connection
            .authenticate_publickey_with(USER, key.public_key().clone(), None, &mut agent)
            .await?
            .success());
        disconnect(&connection).await
    }
    .await;
    task.abort();
    result
}

pub async fn run() -> Result<(), Error> {
    println!("S0: ephemeral keys and pinned host");
    let ed = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519)?;
    let ec = PrivateKey::random(
        &mut rand::rng(),
        Algorithm::Ecdsa {
            curve: russh::keys::ssh_key::EcdsaCurve::NistP256,
        },
    )?;
    let fixture = Fixture::new(vec![ed.public_key().clone(), ec.public_key().clone()]).await?;

    let wrong_host = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519)?;
    assert!(client::connect(
        Arc::new(client::Config::default()),
        fixture.address,
        PinnedHost(wrong_host.public_key().clone())
    )
    .await
    .is_err());
    assert_eq!(
        fixture.attempts.load(Ordering::SeqCst),
        0,
        "host pin failure precedes credentials"
    );
    let mut rejected = fixture.connect().await?;
    assert!(!rejected
        .authenticate_password(USER, "incorrect")
        .await?
        .success());
    disconnect(&rejected).await?;

    let mut connections_ms = Vec::new();
    println!("S0: password connection samples");
    for _ in 0..20 {
        let start = Instant::now();
        let connection = fixture.password_login().await?;
        connections_ms.push(start.elapsed().as_secs_f64() * 1000.0);
        disconnect(&connection).await?;
    }
    key_login(&fixture, ed.clone()).await?;
    println!("S0: Ed25519/ECDSA and encrypted key");
    key_login(&fixture, ec).await?;
    let passphrase = Zeroizing::new(format!("{:x}", rand::random::<u128>()));
    let encrypted = ed.encrypt(&mut rand::rng(), passphrase.as_bytes())?;
    let encoded = encrypted.to_openssh(russh::keys::ssh_key::LineEnding::LF)?;
    assert!(russh::keys::decode_secret_key(&encoded, Some("incorrect")).is_err());
    key_login(
        &fixture,
        russh::keys::decode_secret_key(&encoded, Some(&passphrase))?,
    )
    .await?;
    #[cfg(unix)]
    agent_login(&fixture, &ed).await?;
    println!("S0: agent and known_hosts");

    let known = tempfile::tempdir()?;
    let known_path = known.path().join("known_hosts");
    russh::keys::known_hosts::learn_known_hosts_path(
        "spike.invalid",
        2222,
        &fixture.host,
        &known_path,
    )?;
    let before = std::fs::read(&known_path)?;
    assert!(russh::keys::known_hosts::check_known_hosts_path(
        "spike.invalid",
        2222,
        &fixture.host,
        &known_path
    )?);
    assert!(!russh::keys::known_hosts::check_known_hosts_path(
        "unknown.invalid",
        2222,
        &fixture.host,
        &known_path
    )?);
    assert_eq!(before, std::fs::read(&known_path)?);

    let connection = fixture.password_login().await?;
    println!("S0: exec and PTY");
    exec_pty(&connection).await?;
    println!("S0: 50 MiB SFTP upload and readback");
    let upload_seconds = upload(&connection, &fixture).await?;
    disconnect(&connection).await?;
    connections_ms.sort_by(f64::total_cmp);
    println!("{{\"fixture\":\"russh-loopback\",\"target\":\"{}-{}\",\"samples\":20,\"connectAuthMedianMs\":{:.3},\"connectAuthP95Ms\":{:.3},\"uploadBytes\":{},\"uploadSeconds\":{:.3},\"uploadMiBPerSecond\":{:.3},\"sha256Readback\":true,\"rsa\":\"blocked-RUSTSEC-2023-0071\"}}",
        std::env::consts::OS, std::env::consts::ARCH, (connections_ms[9] + connections_ms[10]) / 2.0, connections_ms[18], UPLOAD_BYTES, upload_seconds, 50.0 / upload_seconds);
    Ok(())
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn pinned_wire_auth_exec_pty_sftp_50mib() {
        tokio::time::timeout(std::time::Duration::from_secs(120), super::run())
            .await
            .unwrap()
            .unwrap();
    }
}
