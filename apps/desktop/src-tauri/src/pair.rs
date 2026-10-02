//! Pairing orchestration owns credentials; UI sees connection metadata and fixed error codes only.
use crate::{
    client::{ClientError, HarnessClient},
    connections::{Connection, CredentialProvenance, Kind, Origin, Store},
    secrets::{
        load_token_or_pairing_needed, token_account, token_hint, SecretString, StoreKind,
        TokenStore,
    },
};
use serde::Deserialize;
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::io::AsyncReadExt;
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PairError {
    CliMissing,
    Denied,
    InsecureOrigin,
    Invalid,
    PairingNeeded,
    Storage,
    Client(ClientError),
}
impl From<ClientError> for PairError {
    fn from(e: ClientError) -> Self {
        Self::Client(e)
    }
}
impl PairError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::CliMissing => "cli-missing",
            Self::Denied => "denied",
            Self::InsecureOrigin => "insecure-origin",
            Self::Invalid => "invalid",
            Self::PairingNeeded => "pairing-needed",
            Self::Storage => "storage",
            Self::Client(e) => match e {
                ClientError::Revoked => "revoked",
                ClientError::Unauthorized => "unauthorized",
                ClientError::Incompatible | ClientError::MissingCapability => "incompatible",
                ClientError::InstallationMismatch => "installation-mismatch",
                ClientError::CertChanged => "cert-changed",
                ClientError::CaNotKnown => "ca-untrusted",
                ClientError::Untrusted => "untrusted",
                ClientError::ProofMismatch => "proof-mismatch",
                ClientError::Network => "network",
                ClientError::Protocol => "protocol",
            },
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairCode {
    pub schema: String,
    pub code: String,
    pub expires_at: String,
    pub origin: Option<Origin>,
}
pub fn resolve_cli() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    if let Some(dir) = std::env::var_os("PLUR1BUS_DESKTOP_CONFIG_DIR") {
        let path = PathBuf::from(dir).join(if cfg!(windows) {
            "bin/plur1bus.exe"
        } else {
            "bin/plur1bus"
        });
        return path.is_file().then_some(path);
    }
    let path = if cfg!(windows) {
        PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join("PLUR1BUS/bin/plur1bus.exe")
    } else {
        PathBuf::from(std::env::var_os("HOME")?).join(".local/bin/plur1bus")
    };
    (path.is_absolute() && path.is_file()).then_some(path)
}
pub struct CliOutput {
    pub success: bool,
    pub bytes: zeroize::Zeroizing<Vec<u8>>,
}
pub trait PairExecutor: Send + Sync {
    fn execute<'a>(
        &'a self,
        cli: &'a Path,
        args: Vec<String>,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<CliOutput, PairError>> + Send + 'a>,
    >;
}
#[derive(Default)]
struct NativeExecutor {
    #[cfg(debug_assertions)]
    env: Vec<(std::ffi::OsString, std::ffi::OsString)>,
}
impl PairExecutor for NativeExecutor {
    fn execute<'a>(
        &'a self,
        cli: &'a Path,
        args: Vec<String>,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<CliOutput, PairError>> + Send + 'a>,
    > {
        Box::pin(async move {
            let mut command = tokio::process::Command::new(cli);
            command
                .args(args)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .kill_on_drop(true);
            #[cfg(debug_assertions)]
            command.envs(self.env.iter().map(|(k, v)| (k, v)));
            let mut child = command.spawn().map_err(|_| PairError::CliMissing)?;
            let stdout = child.stdout.take().ok_or(PairError::Invalid)?;
            let outcome = tokio::time::timeout(Duration::from_secs(15), async {
                let mut bytes = zeroize::Zeroizing::new(Vec::new());
                stdout
                    .take(8193)
                    .read_to_end(&mut bytes)
                    .await
                    .map_err(|_| PairError::Invalid)?;
                if bytes.len() > 8192 {
                    return Err(PairError::Invalid);
                }
                let status = child.wait().await.map_err(|_| PairError::Invalid)?;
                Ok(CliOutput {
                    success: status.success(),
                    bytes,
                })
            })
            .await;
            match outcome {
                Ok(v) => v,
                Err(_) => {
                    let _ = child.kill().await;
                    Err(PairError::Invalid)
                }
            }
        })
    }
}
pub async fn pair_local(cli: &Path, name: &str) -> Result<PairCode, PairError> {
    if !cli.is_file() {
        return Err(PairError::CliMissing);
    }
    pair_local_with(&NativeExecutor::default(), cli, name).await
}
#[cfg(debug_assertions)]
pub async fn pair_local_in_scratch(
    cli: &Path,
    name: &str,
    env: Vec<(std::ffi::OsString, std::ffi::OsString)>,
) -> Result<PairCode, PairError> {
    pair_local_with(&NativeExecutor { env }, cli, name).await
}
pub async fn pair_local_with(
    executor: &dyn PairExecutor,
    cli: &Path,
    name: &str,
) -> Result<PairCode, PairError> {
    if !cli.is_absolute() {
        return Err(PairError::CliMissing);
    }
    if name.trim().is_empty() || name.len() > 120 || name.chars().any(char::is_control) {
        return Err(PairError::Invalid);
    }
    let args = plur1bus_desktop_contract::exec::native_pair(name)
        .into_iter()
        .map(str::to_owned)
        .collect();
    let output = executor.execute(cli, args).await?;
    if output.bytes.len() > 8192 {
        return Err(PairError::Invalid);
    }
    if !output.success {
        let value: serde_json::Value = serde_json::from_slice(&output.bytes).unwrap_or_default();
        return Err(
            if matches!(
                value["code"].as_str(),
                Some("E_AUTH" | "E_DENIED" | "E_FORBIDDEN")
            ) {
                PairError::Denied
            } else {
                PairError::Invalid
            },
        );
    }
    let offer: PairCode = serde_json::from_slice(&output.bytes).map_err(|_| PairError::Invalid)?;
    if offer.schema != "device.pair/1"
        || !plur1bus_desktop_contract::trust::valid_code(&offer.code)
        || chrono::DateTime::parse_from_rfc3339(&offer.expires_at)
            .map_err(|_| PairError::Invalid)?
            <= chrono::Utc::now()
    {
        return Err(PairError::Invalid);
    }
    Ok(offer)
}
pub async fn pair_code(
    origin: &str,
    code: &str,
    name: &str,
    tokens: &dyn TokenStore,
    store: &Store,
    repair: Option<uuid::Uuid>,
) -> Result<Connection, PairError> {
    let origin = Origin::parse(origin).map_err(|_| PairError::InsecureOrigin)?;
    let existing = if let Some(id) = repair {
        Some(
            store
                .load()
                .map_err(|_| PairError::Storage)?
                .into_iter()
                .find(|c| c.id == id)
                .ok_or(PairError::Invalid)?,
        )
    } else {
        None
    };
    if existing
        .as_ref()
        .is_some_and(|c| c.origin != origin || c.name != name)
    {
        return Err(PairError::Invalid);
    }
    pair(
        origin,
        code,
        name,
        Kind::Remote,
        None,
        existing,
        tokens,
        store,
    )
    .await
}
#[allow(clippy::too_many_arguments)]
pub async fn pair(
    origin: Origin,
    code: &str,
    name: &str,
    kind: Kind,
    expected: Option<&str>,
    existing: Option<Connection>,
    tokens: &dyn TokenStore,
    store: &Store,
) -> Result<Connection, PairError> {
    pair_using_client(
        HarnessClient::new(origin, None),
        code,
        name,
        kind,
        expected,
        existing,
        tokens,
        store,
    )
    .await
}
#[allow(clippy::too_many_arguments)]
pub async fn pair_using_client(
    mut client: HarnessClient,
    code: &str,
    name: &str,
    kind: Kind,
    expected: Option<&str>,
    existing: Option<Connection>,
    tokens: &dyn TokenStore,
    store: &Store,
) -> Result<Connection, PairError> {
    let origin = client.origin().clone();
    if existing.as_ref().is_some_and(|c| c.origin != origin) {
        return Err(PairError::Invalid);
    }
    client.establish_pairing_trust(code).await?;
    let meta = client.meta().await?;
    if expected.is_some_and(|id| id != meta.installation_id)
        || existing
            .as_ref()
            .is_some_and(|c| c.installation_id != meta.installation_id)
    {
        return Err(ClientError::InstallationMismatch.into());
    }
    let redeemed = client.redeem_for(&meta.installation_id, code, name).await?;
    let mut connection = Connection::new(
        name.into(),
        kind,
        origin,
        meta.installation_id,
        redeemed.device_id,
        token_hint(&redeemed.token),
    );
    connection.credential_provenance = match tokens.kind() {
        StoreKind::Keychain => CredentialProvenance::Keychain,
        StoreKind::MemoryOnly => CredentialProvenance::MemoryOnly,
    };
    connection.pairing_needed = false;
    connection.pending_keychain_cleanup = tokens.kind() == StoreKind::MemoryOnly
        && existing.as_ref().is_some_and(|c| {
            c.pending_keychain_cleanup
                || c.credential_provenance != CredentialProvenance::MemoryOnly
        });
    if let Some(old) = existing {
        connection.id = old.id;
    }
    client.apply_pairing_trust(&mut connection);
    client
        .refresh_trust(&mut connection, &redeemed.token)
        .await?;
    tokens
        .set(&token_account(connection.id), &redeemed.token)
        .map_err(|_| PairError::PairingNeeded)?;
    if store.upsert(connection.clone()).is_err() {
        let _ = tokens.delete(&token_account(connection.id));
        return Err(PairError::Storage);
    }
    if let Err(error) = client.ack_trust(&connection, &redeemed.token).await {
        mark_failure(&mut connection, &error, tokens, store)?;
        return Err(error.into());
    }
    Ok(connection)
}
pub fn mark_failure(
    c: &mut Connection,
    error: &ClientError,
    tokens: &dyn TokenStore,
    store: &Store,
) -> Result<(), PairError> {
    if matches!(
        error,
        ClientError::Revoked
            | ClientError::Unauthorized
            | ClientError::CertChanged
            | ClientError::CaNotKnown
            | ClientError::InstallationMismatch
    ) {
        c.pairing_needed = true;
        store.upsert(c.clone()).map_err(|_| PairError::Storage)?;
    }
    if *error == ClientError::Revoked {
        // Persist the repair state before a possibly denied deletion (M4).
        tokens
            .delete(&token_account(c.id))
            .map_err(|_| PairError::PairingNeeded)?;
    }
    Ok(())
}
fn connection_token(c: &Connection, tokens: &dyn TokenStore) -> Result<SecretString, PairError> {
    let matches = matches!(
        (c.credential_provenance, tokens.kind()),
        (CredentialProvenance::Keychain, StoreKind::Keychain)
            | (CredentialProvenance::MemoryOnly, StoreKind::MemoryOnly)
    );
    if c.pairing_needed || !matches {
        return Err(PairError::PairingNeeded);
    }
    load_token_or_pairing_needed(tokens, c.id).map_err(|_| PairError::PairingNeeded)
}
pub async fn validate_connection(
    c: &mut Connection,
    tokens: &dyn TokenStore,
    store: &Store,
) -> Result<(), PairError> {
    let token = match connection_token(c, tokens) {
        Ok(token) => token,
        Err(_) => {
            c.pairing_needed = true;
            store.upsert(c.clone()).map_err(|_| PairError::Storage)?;
            return Err(PairError::PairingNeeded);
        }
    };
    let client = match HarnessClient::from_connection(c).await {
        Ok(client) => client,
        Err(e) => {
            mark_failure(c, &e, tokens, store)?;
            return Err(e.into());
        }
    };
    let result = async {
        client.whoami(&c.installation_id, &token).await?;
        client.refresh_trust(c, &token).await?;
        Ok::<_, ClientError>(())
    }
    .await;
    match result {
        Ok(()) => {
            store.upsert(c.clone()).map_err(|_| PairError::Storage)?;
            if let Err(e) = client.ack_trust(c, &token).await {
                mark_failure(c, &e, tokens, store)?;
                return Err(e.into());
            }
            store.set_active(c.id).map_err(|_| PairError::Storage)?;
            Ok(())
        }
        Err(e) => {
            c.observed_cert_pin = client.observed_pin();
            mark_failure(c, &e, tokens, store)?;
            Err(e.into())
        }
    }
}

/// WP6 can drive this bounded primitive from its cancellable event loop.
pub async fn sync_next_trust_event(
    c: &mut Connection,
    tokens: &dyn TokenStore,
    store: &Store,
) -> Result<(), PairError> {
    let client = match HarnessClient::from_connection(c).await {
        Ok(client) => client,
        Err(e) => {
            mark_failure(c, &e, tokens, store)?;
            return Err(e.into());
        }
    };
    sync_next_trust_event_with_client(c, client, tokens, store).await
}
pub async fn sync_next_trust_event_with_client(
    c: &mut Connection,
    client: HarnessClient,
    tokens: &dyn TokenStore,
    store: &Store,
) -> Result<(), PairError> {
    if client.origin() != &c.origin {
        return Err(PairError::Invalid);
    }
    let token = match connection_token(c, tokens) {
        Ok(token) => token,
        Err(_) => {
            c.pairing_needed = true;
            store.upsert(c.clone()).map_err(|_| PairError::Storage)?;
            return Err(PairError::PairingNeeded);
        }
    };
    let result = async {
        client.trust_event(&c.installation_id, &token).await?;
        client.refresh_trust(c, &token).await?;
        Ok::<_, ClientError>(client)
    }
    .await;
    match result {
        Ok(client) => {
            store.upsert(c.clone()).map_err(|_| PairError::Storage)?;
            if let Err(e) = client.ack_trust(c, &token).await {
                mark_failure(c, &e, tokens, store)?;
                return Err(e.into());
            }
            Ok(())
        }
        Err(e) => {
            mark_failure(c, &e, tokens, store)?;
            Err(e.into())
        }
    }
}

/// Credential-owning ticket path for WP5: any revoked response clears the token.
pub async fn session_ticket(
    c: &mut Connection,
    tokens: &dyn TokenStore,
    store: &Store,
) -> Result<crate::client::Ticket, PairError> {
    let token = connection_token(c, tokens)?;
    let result = async {
        let client = HarnessClient::from_connection(c).await?;
        client.session_ticket(&c.installation_id, &token).await
    }
    .await;
    match result {
        Ok(ticket) => Ok(ticket),
        Err(e) => {
            mark_failure(c, &e, tokens, store)?;
            Err(e.into())
        }
    }
}

/// A memory fallback cannot pretend it deleted an inaccessible persisted credential.
pub fn remove_connection(
    store: &Store,
    id: uuid::Uuid,
    session: Option<&dyn TokenStore>,
    persistent: &dyn TokenStore,
) -> Result<(), PairError> {
    let row = store
        .load()
        .map_err(|_| PairError::Storage)?
        .into_iter()
        .find(|c| c.id == id)
        .ok_or(PairError::Invalid)?;
    if row.pending_keychain_cleanup || row.credential_provenance != CredentialProvenance::MemoryOnly
    {
        if persistent.kind() != StoreKind::Keychain {
            return Err(PairError::PairingNeeded);
        }
        persistent
            .delete(&token_account(id))
            .map_err(|_| PairError::PairingNeeded)?;
    }
    if let Some(memory) = session.filter(|s| s.kind() == StoreKind::MemoryOnly) {
        memory
            .delete(&token_account(id))
            .map_err(|_| PairError::PairingNeeded)?;
    }
    store.remove_metadata(id).map_err(|_| PairError::Storage)
}
