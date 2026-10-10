//! Pairing orchestration owns credentials; UI sees connection metadata and fixed error codes only.
use crate::{
    client::{ClientError, HarnessClient},
    connections::{Connection, CredentialProvenance, Kind, Origin, Store},
    secrets::{token_account, token_hint, SecretString, StoreKind, TokenError, TokenStore},
};
use serde::Deserialize;
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::io::AsyncReadExt;
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PairError {
    Cancelled,
    CliMissing,
    Runtime(&'static str),
    Denied,
    InsecureOrigin,
    Invalid,
    PairingNeeded,
    Token(TokenError),
    Storage,
    Client(ClientError),
}
impl From<ClientError> for PairError {
    fn from(e: ClientError) -> Self {
        Self::Client(e)
    }
}
impl PairError {
    pub fn public_message(&self) -> String {
        match self {
            Self::Client(ClientError::Incompatible { server, client }) => {
                format!("incompatible:{server}:{client}")
            }
            _ => self.code().to_owned(),
        }
    }
    pub fn code(&self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled",
            Self::CliMissing => "cli-missing",
            Self::Runtime(_) => "runtime",
            Self::Denied => "denied",
            Self::InsecureOrigin => "insecure-origin",
            Self::Invalid => "invalid",
            Self::PairingNeeded | Self::Token(TokenError::NotFound) => "pairing-needed",
            Self::Token(TokenError::AccessDenied) => "keychain-denied",
            Self::Token(TokenError::Unavailable(_)) => "keychain-unavailable",
            Self::Token(TokenError::Other(_)) => "keychain-error",
            Self::Storage => "storage",
            Self::Client(e) => match e {
                ClientError::Revoked => "revoked",
                ClientError::Unauthorized => "unauthorized",
                ClientError::Incompatible { .. } | ClientError::MissingCapability => "incompatible",
                ClientError::InstallationMismatch => "installation-mismatch",
                ClientError::CertChanged => "cert-changed",
                ClientError::CaNotKnown => "ca-untrusted",
                ClientError::Untrusted => "untrusted",
                ClientError::ProofMismatch => "proof-mismatch",
                ClientError::Network => "network",
                ClientError::TrustUnavailable => "trust-unavailable",
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
        existing.as_ref().map_or(Kind::Remote, |c| c.kind.clone()),
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
    client: HarnessClient,
    code: &str,
    name: &str,
    kind: Kind,
    expected: Option<&str>,
    existing: Option<Connection>,
    tokens: &dyn TokenStore,
    store: &Store,
) -> Result<Connection, PairError> {
    pair_using_client_inner(
        client, code, name, kind, expected, existing, tokens, store, None, None,
    )
    .await
}
#[allow(clippy::too_many_arguments)]
async fn pair_using_client_inner(
    mut client: HarnessClient,
    code: &str,
    name: &str,
    kind: Kind,
    expected: Option<&str>,
    existing: Option<Connection>,
    tokens: &dyn TokenStore,
    store: &Store,
    bundled: Option<crate::connections::BundledRef>,
    control: Option<&PairControl>,
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
    if let Some(control) = control {
        control.checkpoint()?;
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
    connection.bundled = bundled;
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
    let mut boundary = control
        .map(|c| c.boundary.lock().map_err(|_| PairError::Invalid))
        .transpose()?;
    if boundary
        .as_ref()
        .is_some_and(|s| **s == PairBoundary::Cancelled)
    {
        return Err(PairError::Cancelled);
    }
    tokens
        .set(&token_account(connection.id), &redeemed.token)
        .map_err(PairError::Token)?;
    if store.upsert(connection.clone()).is_err() {
        let _ = tokens.delete(&token_account(connection.id));
        return Err(PairError::Storage);
    }
    if let Some(boundary) = boundary.as_mut() {
        **boundary = PairBoundary::Committed;
    }
    drop(boundary);
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
            .map_err(PairError::Token)?;
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
    tokens
        .get(&token_account(c.id))
        .map_err(PairError::Token)?
        .ok_or(PairError::PairingNeeded)
}
pub async fn validate_connection(
    c: &mut Connection,
    tokens: &dyn TokenStore,
    store: &Store,
) -> Result<(), PairError> {
    let token = match connection_token(c, tokens) {
        Ok(token) => token,
        Err(error) => {
            c.pairing_needed = true;
            store.upsert(c.clone()).map_err(|_| PairError::Storage)?;
            return Err(error);
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
            if matches!(e, ClientError::CertChanged | ClientError::CaNotKnown) {
                c.observed_cert_pin = client.observed_pin();
            }
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
        Err(error) => {
            c.pairing_needed = true;
            store.upsert(c.clone()).map_err(|_| PairError::Storage)?;
            return Err(error);
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
            .map_err(PairError::Token)?;
    }
    if let Some(memory) = session.filter(|s| s.kind() == StoreKind::MemoryOnly) {
        memory
            .delete(&token_account(id))
            .map_err(PairError::Token)?;
    }
    store.remove_metadata(id).map_err(|_| PairError::Storage)
}

/// Bundled pairing stays entirely native: fixed exec, loopback redemption, credential store.
pub async fn pair_bundled(
    ctl: &crate::controller::Controller,
    tokens: &dyn TokenStore,
    store: &Store,
    name: &str,
    progress: impl Fn(crate::controller::InstallStep),
) -> Result<Connection, PairError> {
    pair_bundled_controlled(ctl, tokens, store, name, progress, None).await
}
pub async fn pair_bundled_controlled(
    ctl: &crate::controller::Controller,
    tokens: &dyn TokenStore,
    store: &Store,
    name: &str,
    progress: impl Fn(crate::controller::InstallStep),
    control: Option<&PairControl>,
) -> Result<Connection, PairError> {
    use crate::controller::{CtlError, InstallStep};
    if name.trim().is_empty() || name.len() > 120 || name.chars().any(char::is_control) {
        return Err(PairError::Invalid);
    }
    let i = ctl
        .installed()
        .map_err(|e| PairError::Runtime(e.code()))?
        .ok_or(PairError::Invalid)?;
    let origin =
        Origin::parse(&format!("http://127.0.0.1:{}", i.port)).map_err(|_| PairError::Invalid)?;
    let old = store
        .load()
        .map_err(|_| PairError::Storage)?
        .into_iter()
        .find(|c| {
            c.kind == Kind::Bundled
                && c.bundled
                    .as_ref()
                    .is_some_and(|b| b.endpoint == i.endpoint && b.container == i.container)
        });
    let old_token = old
        .as_ref()
        .map(|c| tokens.get(&token_account(c.id)))
        .transpose()
        .map_err(PairError::Token)?
        .flatten();
    if let Some(control) = control {
        control.checkpoint()?;
    }
    progress(InstallStep::Owner);
    match ctl
        .exec_json(
            &["plur1bus", "user", "create", "--owner", "--json"],
            Duration::from_secs(15),
        )
        .await
    {
        Ok(value)
            if value.get("schema").and_then(|v| v.as_str()) == Some("user.create/1")
                && value
                    .get("userId")
                    .and_then(|v| v.as_str())
                    .is_some_and(|s| !s.is_empty()) => {}
        Err(CtlError::ExecFailed {
            error_code: Some(ref code),
            ..
        }) if code == "E_EXISTS" => {}
        Ok(_) => return Err(PairError::Invalid),
        Err(e) => return Err(PairError::Runtime(e.code())),
    }
    if let Some(control) = control {
        control.checkpoint()?;
    }
    progress(InstallStep::Pairing);
    let args = crate::contract::exec::bundled_pair(name);
    let mut full = vec!["plur1bus".to_string()];
    full.extend(args);
    let argv = full.iter().map(String::as_str).collect::<Vec<_>>();
    let value = ctl
        .exec_json(&argv, Duration::from_secs(15))
        .await
        .map_err(|e| PairError::Runtime(e.code()))?;
    let code: PairCode = serde_json::from_value(value).map_err(|_| PairError::Invalid)?;
    if code.schema != "device.pair/1" || code.code.is_empty() {
        return Err(PairError::Invalid);
    }
    let secret_code = zeroize::Zeroizing::new(code.code);
    let mut pending: Vec<String> = if ctl.dir.join("pair-revocations.json").exists() {
        serde_json::from_str(
            &crate::controller::read_private_json(&ctl.dir, "pair-revocations.json", 16384)
                .map_err(|_| PairError::Storage)?,
        )
        .map_err(|_| PairError::Storage)?
    } else {
        vec![]
    };
    if pending.len() > 64 {
        return Err(PairError::Storage);
    }
    if let Some(old) = &old {
        if !pending.contains(&old.device_id) {
            pending.push(old.device_id.clone());
        }
    }
    crate::controller::atomic_json(&ctl.dir, "pair-revocations.json", &pending)
        .map_err(|_| PairError::Storage)?;
    let bundled = crate::connections::BundledRef {
        runtime: match i.runtime {
            crate::runtime::RuntimeKind::Apple => crate::connections::RuntimeKind::Apple,
            crate::runtime::RuntimeKind::Docker => crate::connections::RuntimeKind::Docker,
        },
        endpoint: i.endpoint.clone(),
        container: i.container.clone(),
        image_digest: i.image_digest.clone(),
    };
    let paired = pair_using_client_inner(
        HarnessClient::new(origin, None),
        &secret_code,
        name,
        Kind::Bundled,
        old.as_ref().map(|c| c.installation_id.as_str()),
        old.clone(),
        tokens,
        store,
        Some(bundled),
        control,
    )
    .await;
    let connection = match paired {
        Ok(c) => c,
        Err(e) => {
            if matches!(e, PairError::Storage) {
                if let (Some(old), Some(token)) = (&old, &old_token) {
                    tokens
                        .set(&token_account(old.id), token)
                        .map_err(PairError::Token)?
                }
            }
            return Err(e);
        }
    };
    // IDs survive process termination and retry; only revoke after durable token+ownership metadata.
    while let Some(id) = pending.first().cloned() {
        if id != connection.device_id {
            ctl.exec_json(
                &["plur1bus", "device", "revoke", &id, "--json"],
                Duration::from_secs(15),
            )
            .await
            .map_err(|e| PairError::Runtime(e.code()))?;
        }
        pending.remove(0);
        crate::controller::atomic_json(&ctl.dir, "pair-revocations.json", &pending)
            .map_err(|_| PairError::Storage)?;
    }
    store
        .set_active(connection.id)
        .map_err(|_| PairError::Storage)?;
    progress(InstallStep::Done);
    Ok(connection)
}
#[derive(Default)]
pub struct BundledRepair {
    attempted: std::collections::HashSet<uuid::Uuid>,
}
impl BundledRepair {
    pub fn manual_retry(&mut self, id: uuid::Uuid) {
        self.attempted.remove(&id);
    }
    pub async fn repair_once(
        &mut self,
        ctl: &crate::controller::Controller,
        connection: &Connection,
        tokens: &dyn TokenStore,
        store: &Store,
    ) -> Result<Connection, PairError> {
        if connection.kind != Kind::Bundled || !self.attempted.insert(connection.id) {
            return Err(PairError::PairingNeeded);
        }
        pair_bundled(ctl, tokens, store, &connection.name, |_| {}).await
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PairBoundary {
    Pending,
    Cancelled,
    Committed,
}
pub struct PairControl {
    boundary: std::sync::Mutex<PairBoundary>,
}
impl Default for PairControl {
    fn default() -> Self {
        Self {
            boundary: std::sync::Mutex::new(PairBoundary::Pending),
        }
    }
}
impl PairControl {
    /// Runs on a blocking worker if a native credential commit is in flight.
    pub fn cancel(&self) -> bool {
        let Ok(mut boundary) = self.boundary.lock() else {
            return false;
        };
        if *boundary == PairBoundary::Committed {
            return false;
        }
        *boundary = PairBoundary::Cancelled;
        true
    }
    fn checkpoint(&self) -> Result<(), PairError> {
        if *self.boundary.lock().map_err(|_| PairError::Invalid)? == PairBoundary::Cancelled {
            Err(PairError::Cancelled)
        } else {
            Ok(())
        }
    }
}
