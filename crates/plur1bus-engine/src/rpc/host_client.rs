//! Authenticated reverse RPC to Core-owned host services.
//!
//! Connections and egress decisions are deliberately not cached. The blocking shared
//! client discards notifications, so it cannot reliably observe live policy changes.
//! Each host call reads the current Core identity and authenticates a new connection;
//! a missing or restarted Core therefore cannot leave a sticky unavailable client.

use std::fs;
use std::io::Read;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use plur1bus_rpc::{Client, ConnectOptions, RpcError};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};

use crate::contract::{
    AddressRules, AgentId, Cancel, Decision, EgressGate, EngineConfig, HostError, HostServices,
    JournalBacklog, LlmParams, LlmPort, LlmResult, PlatformCapabilities, Scheme, SecretPort,
    SecretValue, Target,
};

/// Core-backed host ports, with an independent engine delegation credential.
///
/// This type intentionally has no diagnostic formatting implementation: it owns a
/// credential and may briefly handle resolved secrets and provider responses.
/// Native platform capabilities default to fail closed and can be supplied through
/// [`RpcHost::with_platform`]. Construction never connects to Core or reads secrets.
pub struct RpcHost {
    home: PathBuf,
    state: PathBuf,
    engine_token: String,
    config: EngineConfig,
    platform: PlatformCapabilities,
}

impl RpcHost {
    /// Construct host services without requiring a running Core process.
    /// `home` is the same normalized absolute home passed to Core; its spelling is
    /// retained because Windows named-pipe identity hashes that configured path.
    pub fn new(home: PathBuf, engine_token: String, config: EngineConfig) -> Self {
        Self {
            state: home.join("state"),
            home,
            engine_token,
            config,
            platform: PlatformCapabilities::default(),
        }
    }

    /// Supply the process host's native filesystem and address callbacks.
    pub fn with_platform(mut self, platform: PlatformCapabilities) -> Self {
        self.platform = platform;
        self
    }

    /// Complete work for its actual owning agent, preserving the outer wire scope.
    ///
    /// Core independently verifies that this engine currently owns active work for
    /// the agent. The RE-01 `LlmParams` has no agent field; callers must carry that
    /// attribution from their operation rather than guessing a configured agent.
    pub fn complete_for(
        &self,
        agent: &AgentId,
        params: &LlmParams,
        cancel: &Cancel,
    ) -> Result<LlmResult, HostError> {
        cancel.check()?;
        let response = self.call(
            "host.llm.complete",
            json!({ "agentId": agent, "params": params }),
            Some(cancel),
        );
        cancel.check()?;
        decode(response?)
    }

    fn call(
        &self,
        method: &str,
        params: Value,
        cancel: Option<&Cancel>,
    ) -> Result<Value, HostError> {
        if let Some(cancel) = cancel {
            cancel.check()?;
        }
        let run = self.home.join("run");
        // Verify before reading the owner credential. Refuse linked run files too;
        // this adapter must never silently follow a replaced identity file.
        plur1bus_rpc::trust::verify_run_dir(&run).map_err(|error| map_rpc_error(&error))?;
        let token = read_identity_file(&run.join("core.token"))?;
        let token = token.trim();
        if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(HostError::Unavailable);
        }
        let identity = read_identity_file(&run.join("core.pid"))?;
        let mut fields = identity.split_whitespace();
        let pid = fields
            .next()
            .and_then(|field| field.parse::<u32>().ok())
            .filter(|pid| *pid != 0)
            .ok_or(HostError::Unavailable)?;
        if fields.next().is_none() || fields.next().is_some() {
            return Err(HostError::Unavailable);
        }
        let remaining = cancel.and_then(Cancel::remaining);
        let mut options = ConnectOptions {
            expected_server_pid: Some(pid),
            ..ConnectOptions::default()
        };
        if let Some(remaining) = remaining {
            if remaining.is_zero() {
                if let Some(cancel) = cancel {
                    cancel.check()?;
                }
                return Err(HostError::Unavailable);
            }
            options.connect_timeout = options.connect_timeout.min(remaining);
            options.call_timeout = options.call_timeout.min(remaining);
        }
        let address = super::layout::unit_address(&self.home, "core");
        // The shared transport verifies Unix peer ownership / Windows server pid
        // before writing either the Core token or the independent delegation.
        let mut client = Client::connect_with_auth(
            &address,
            json!({
                "token": token,
                "engine": { "clientId": "plur1bus-engine", "token": self.engine_token }
            }),
            options,
        )
        .map_err(|error| map_rpc_error(&error))?;
        if let Some(cancel) = cancel {
            cancel.check()?;
        }
        client
            .call(method, params)
            .map_err(|error| map_rpc_error(&error))
    }
}

impl HostServices for RpcHost {
    fn state_dir(&self) -> &Path {
        &self.state
    }

    fn config(&self) -> EngineConfig {
        self.config.clone()
    }

    fn workspace_dir(&self, agent: &AgentId) -> Result<Option<PathBuf>, HostError> {
        let response = self.call("host.workspaceDir", json!({ "agentId": agent }), None)?;
        match response.get("path") {
            Some(Value::Null) => Ok(None),
            Some(Value::String(path)) => Ok(Some(PathBuf::from(path))),
            _ => Err(HostError::InvalidResponse),
        }
    }

    fn llm(&self) -> Option<&dyn LlmPort> {
        Some(self)
    }

    fn secrets(&self) -> Option<&dyn SecretPort> {
        Some(self)
    }

    fn egress(&self) -> &dyn EgressGate {
        self
    }

    fn emit(&self, event: &str, payload: Value) {
        let _ = self.call(
            "host.event",
            json!({ "name": event, "payload": payload }),
            None,
        );
    }

    fn now_ms(&self) -> i64 {
        let elapsed = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or(Duration::ZERO);
        i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
    }

    fn platform(&self) -> &PlatformCapabilities {
        &self.platform
    }

    fn journal_backlog(&self) -> Option<JournalBacklog> {
        self.call("host.journalBacklog", json!({}), None)
            .ok()
            .and_then(|value| decode::<Option<JournalBacklog>>(value).ok())
            .flatten()
    }
}

impl LlmPort for RpcHost {
    fn complete(&self, _params: LlmParams, cancel: &Cancel) -> Result<LlmResult, HostError> {
        cancel.check()?;
        // RE-01's trait cannot express the owning agent. Fail before connecting;
        // only complete_for may cross the guarded Core completion boundary.
        Err(HostError::Denied)
    }
}

impl SecretPort for RpcHost {
    fn get(&self, name: &str) -> Result<Option<SecretValue>, HostError> {
        let response = self.call("host.secret.get", json!({ "name": name }), None)?;
        match response.get("value") {
            Some(Value::Null) => Ok(None),
            Some(Value::String(value)) => Ok(Some(SecretValue::new(value.clone()))),
            _ => Err(HostError::InvalidResponse),
        }
    }
}

impl EgressGate for RpcHost {
    fn cache_decisions(&self) -> bool {
        // The synchronous reverse client cannot observe policy notifications.
        false
    }

    fn decide(&self, target: &Target) -> Decision {
        let scheme = match target.scheme {
            Scheme::Http => "http",
            Scheme::Https => "https",
        };
        let response = match self.call(
            "host.egress.decide",
            json!({ "scheme": scheme, "host": target.host, "port": target.port }),
            None,
        ) {
            Ok(response) => response,
            Err(HostError::Denied) => return deny("host-denied"),
            Err(HostError::InvalidResponse) => return deny("host-invalid-response"),
            Err(_) => return deny("host-unavailable"),
        };
        match response.get("allowed").and_then(Value::as_bool) {
            Some(false) => {
                let reason = response
                    .get("reason")
                    .and_then(Value::as_str)
                    .filter(|reason| {
                        matches!(
                            *reason,
                            "invalid-url"
                                | "scheme"
                                | "port"
                                | "host-not-allowed"
                                | "loopback"
                                | "private-address"
                                | "not-found"
                        )
                    })
                    .unwrap_or("host-denied");
                deny(reason)
            }
            Some(true) => {
                let host = response.get("host").and_then(Value::as_str);
                let address = response
                    .get("address")
                    .and_then(Value::as_str)
                    .and_then(|value| value.parse::<IpAddr>().ok());
                let Some(address) = address else {
                    return deny("host-invalid-response");
                };
                let family = if address.is_ipv4() { 4 } else { 6 };
                if !host.is_some_and(|host| {
                    host.eq_ignore_ascii_case(target.host.trim_end_matches('.'))
                }) || response.get("port").and_then(Value::as_u64)
                    != Some(u64::from(target.port))
                    || response.get("family").and_then(Value::as_u64) != Some(family)
                {
                    return deny("host-invalid-response");
                }
                let address_rules = AddressRules {
                    // Core only allows loopback when the origin itself is a loopback
                    // spelling. Recheck that invariant before granting the local resolver
                    // permission to dial any loopback record. Private/metadata stay denied.
                    allow_loopback: loopback(address) && loopback_host(&target.host),
                    ..AddressRules::default()
                };
                if !crate::transport::target::address_allowed(address, address_rules) {
                    return deny("host-invalid-response");
                }
                Decision::Allow { address_rules }
            }
            None => deny("host-invalid-response"),
        }
    }
}

/// Read a private run identity through a bounded, no-follow held file.
/// Any unsafe metadata or filesystem error becomes a body-free unavailable error.
pub(crate) fn read_identity_file(path: &Path) -> Result<String, HostError> {
    const MAX_IDENTITY_BYTES: u64 = 4096;
    let parent = path.parent().ok_or(HostError::Unavailable)?;
    plur1bus_rpc::trust::verify_run_dir(parent).map_err(|_| HostError::Unavailable)?;
    crate::store::paths::assert_trusted_path(path).map_err(|_| HostError::Unavailable)?;
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // O_NONBLOCK also prevents an unexpectedly replaced FIFO from blocking
        // before the held descriptor can be checked as a regular file.
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
        };
        // Hold the name stable while inspecting its DACL and reading its bytes.
        options
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .share_mode(FILE_SHARE_READ);
    }
    let file = options.open(path).map_err(|_| HostError::Unavailable)?;
    let metadata = file.metadata().map_err(|_| HostError::Unavailable)?;
    if !metadata.is_file() || metadata.len() > MAX_IDENTITY_BYTES {
        return Err(HostError::Unavailable);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // SAFETY: geteuid has no preconditions and cannot fail.
        let euid = unsafe { libc::geteuid() };
        if metadata.uid() != euid || metadata.mode() & 0o077 != 0 || metadata.nlink() != 1 {
            return Err(HostError::Unavailable);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_REPARSE_POINT,
        };
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(HostError::Unavailable);
        }
        // SAFETY: this POD is immediately populated using the live held file.
        let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        // SAFETY: the handle and writable output remain valid throughout this query.
        if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut information) } == 0
            || information.nNumberOfLinks != 1
        {
            return Err(HostError::Unavailable);
        }
        let user = plur1bus_rpc::win::user_sid().map_err(|_| HostError::Unavailable)?;
        for protected in [parent, path] {
            let entries = plur1bus_rpc::win::file_dacl_report_strict(protected)
                .map_err(|_| HostError::Unavailable)?;
            if entries.iter().any(|entry| {
                entry.allow
                    && entry.mask != 0
                    && entry.sid != user
                    && entry.sid != plur1bus_rpc::acl::SYSTEM_SID
            }) {
                return Err(HostError::Unavailable);
            }
        }
    }
    let mut bytes = Vec::new();
    file.take(MAX_IDENTITY_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| HostError::Unavailable)?;
    if bytes.len() > MAX_IDENTITY_BYTES as usize {
        return Err(HostError::Unavailable);
    }
    String::from_utf8(bytes).map_err(|_| HostError::Unavailable)
}

fn decode<T: DeserializeOwned>(value: Value) -> Result<T, HostError> {
    serde_json::from_value(value).map_err(|_| HostError::InvalidResponse)
}

fn map_rpc_error(error: &RpcError) -> HostError {
    // Do not retain or format arbitrary remote message/reason/detail fields.
    match error {
        RpcError::Unavailable { .. } | RpcError::Version { .. } => HostError::Unavailable,
        RpcError::Protocol(_) => HostError::InvalidResponse,
        RpcError::Call { error, .. } => match error {
            plur1bus_rpc::types::ErrorCode::EDenied
            | plur1bus_rpc::types::ErrorCode::EUnauthorized => HostError::Denied,
            plur1bus_rpc::types::ErrorCode::ENotAvailable
            | plur1bus_rpc::types::ErrorCode::ECoreUnavailable => HostError::Unavailable,
            _ => HostError::Failed,
        },
    }
}

fn deny(reason: &str) -> Decision {
    Decision::Deny {
        reason: reason.to_owned(),
    }
}

fn loopback(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => address.is_loopback(),
        IpAddr::V6(address) => address
            .to_ipv4_mapped()
            .map_or_else(|| address.is_loopback(), |address| address.is_loopback()),
    }
}

fn loopback_host(host: &str) -> bool {
    let host = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.')
        .to_ascii_lowercase();
    host == "localhost" || host.ends_with(".localhost") || host.parse().is_ok_and(loopback)
}
