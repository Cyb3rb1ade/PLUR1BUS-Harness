//! Pinned SSH handshake separated from private-key acquisition on the same connection.
use crate::protocol::{Connect, HostIdentity, Mode};
use crate::Failure;
use russh::client;
use russh::keys::{
    decode_secret_key, ssh_key::HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate,
};
use russh_sftp::client::RawSftpSession;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Instant;
use zeroize::Zeroize;

pub(crate) struct HostKey {
    expected: Option<String>,
    observed: Arc<Mutex<Option<HostIdentity>>>,
    mismatch: Arc<AtomicBool>,
}

impl client::Handler for HostKey {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let public = key.public_key();
        let fingerprint = public.fingerprint(HashAlg::Sha256).to_string();
        if let Ok(mut observed) = self.observed.lock() {
            *observed = Some(HostIdentity {
                host_key_sha256: fingerprint.clone(),
                host_key_algorithm: public.algorithm().to_string(),
            });
        }
        let matches = self.expected.as_ref().is_none_or(|pin| pin == &fingerprint);
        self.mismatch.store(!matches, Ordering::SeqCst);
        Ok(matches)
    }
}

pub(crate) async fn before<T>(
    deadline: Instant,
    future: impl std::future::Future<Output = T>,
) -> Result<T, Failure> {
    tokio::time::timeout_at(deadline.into(), future)
        .await
        .map_err(|_| Failure::Timeout)
}

async fn handshake(
    config: &Connect,
    expected: Option<String>,
) -> Result<(client::Handle<HostKey>, HostIdentity, Instant), Failure> {
    let (address, deadline) = config.validate()?;
    let observed = Arc::new(Mutex::new(None));
    let mismatch = Arc::new(AtomicBool::new(false));
    let handler = HostKey {
        expected,
        observed: observed.clone(),
        mismatch: mismatch.clone(),
    };
    let socket = before(deadline, tokio::net::TcpStream::connect(address))
        .await?
        .map_err(|_| Failure::Unavailable)?;
    let client_config = client::Config {
        inactivity_timeout: Some(deadline.saturating_duration_since(Instant::now())),
        channel_buffer_size: 2,
        window_size: config.limits.packet_bytes.saturating_mul(2),
        maximum_packet_size: 32 * 1024,
        ..Default::default()
    };
    let handle = before(
        deadline,
        client::connect_stream(Arc::new(client_config), socket, handler),
    )
    .await?
    .map_err(|_| {
        if mismatch.load(Ordering::SeqCst) {
            Failure::HostKeyMismatch
        } else {
            Failure::Unavailable
        }
    })?;
    let fingerprint = observed
        .lock()
        .map_err(|_| Failure::Protocol)?
        .clone()
        .ok_or(Failure::Protocol)?;
    Ok((handle, fingerprint, deadline))
}

pub(crate) struct KeyBytes<'a>(pub(crate) &'a mut [u8]);
impl Drop for KeyBytes<'_> {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

/// An unauthenticated, pinned connection; no credentials or filesystem operations precede this state.
pub(crate) struct PinnedConnection {
    pub(crate) identity: HostIdentity,
    ssh: client::Handle<HostKey>,
    deadline: Instant,
}
impl PinnedConnection {
    pub(crate) async fn prepare(config: &Connect) -> Result<Self, Failure> {
        if config.mode != Mode::Connect {
            return Err(Failure::InvalidRequest);
        }
        let (ssh, identity, deadline) = handshake(config, config.host_key_sha256.clone()).await?;
        Ok(Self {
            identity,
            ssh,
            deadline,
        })
    }
    pub(crate) async fn authenticate(
        self,
        config: &Connect,
        key: &mut [u8],
    ) -> Result<
        (
            client::Handle<HostKey>,
            RawSftpSession,
            HostIdentity,
            Instant,
        ),
        Failure,
    > {
        let key = KeyBytes(key);
        if key.0.is_empty() || key.0.len() > crate::protocol::KEY_BYTES {
            return Err(Failure::InvalidRequest);
        }
        let Self {
            mut ssh,
            identity,
            deadline,
        } = self;
        // No private-key decoding, authentication or data request precedes the authenticated host-key comparison.
        let decoded = std::str::from_utf8(key.0)
            .ok()
            .and_then(|text| decode_secret_key(text, None).ok());
        key.0.zeroize();
        let decoded = decoded.ok_or(Failure::Authentication)?;
        if !matches!(
            decoded.algorithm(),
            russh::keys::ssh_key::Algorithm::Ed25519
        ) {
            return Err(Failure::Authentication);
        }
        let authenticated = before(
            deadline,
            ssh.authenticate_publickey(
                config.username.clone(),
                PrivateKeyWithHashAlg::new(Arc::new(decoded), None),
            ),
        )
        .await?
        .map_err(|_| Failure::Authentication)?;
        if !authenticated.success() {
            return Err(Failure::Authentication);
        }
        let channel = before(deadline, ssh.channel_open_session())
            .await?
            .map_err(|_| Failure::Protocol)?;
        before(deadline, channel.request_subsystem(true, "sftp"))
            .await?
            .map_err(|_| Failure::Protocol)?;
        let sftp = RawSftpSession::new_with_config(
            channel.into_stream(),
            russh_sftp::client::Config {
                max_packet_len: config.limits.packet_bytes,
                max_concurrent_reads: 1,
                max_concurrent_writes: 1,
                request_timeout_secs: deadline
                    .saturating_duration_since(Instant::now())
                    .as_secs()
                    .max(1),
                ..Default::default()
            },
        );
        let version = before(deadline, sftp.init())
            .await?
            .map_err(|_| Failure::Protocol)?;
        if version.version != 3 {
            return Err(Failure::Protocol);
        }
        Ok((ssh, sftp, identity, deadline))
    }
}

pub(crate) async fn probe(config: &Connect) -> Result<HostIdentity, Failure> {
    if config.mode != Mode::ProbeHostKey {
        return Err(Failure::InvalidRequest);
    }
    let (ssh, fingerprint, deadline) = handshake(config, None).await?;
    let _ = before(
        deadline,
        ssh.disconnect(russh::Disconnect::ByApplication, "", ""),
    )
    .await;
    Ok(fingerprint)
}
