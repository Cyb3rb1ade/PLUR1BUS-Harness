//! Host-supplied configuration, identity, optional providers and egress policy.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::{
    AgentId, Cancel, EngineConfig, HostError, IpcAddress, IpcAddressKind, JournalBacklog,
    LlmParams, LlmResult, SecurePathResult, SecurePathResultReason,
};

/// The host services required by the engine, with optional LLM and secret ports.
pub trait HostServices: Send + Sync {
    /// Return the root of the engine's persistent host state.
    fn state_dir(&self) -> &Path;
    /// Read the current engine configuration without changing host configuration.
    fn config(&self) -> EngineConfig;
    /// Resolve an agent's workspace, or None when no workspace exists.
    fn workspace_dir(&self, agent: &AgentId) -> Result<Option<PathBuf>, HostError>;
    /// Return the optional host LLM provider.
    fn llm(&self) -> Option<&dyn LlmPort>;
    /// Return the optional host secret store.
    fn secrets(&self) -> Option<&dyn SecretPort>;
    /// Return the policy gate consulted before each outbound hop.
    fn egress(&self) -> &dyn EgressGate;
    /// Emit a named event with its structured payload.
    fn emit(&self, event: &str, payload: serde_json::Value);
    /// Return host-clock epoch milliseconds.
    fn now_ms(&self) -> i64;
    /// Return the host platform's capabilities.
    fn platform(&self) -> &PlatformCapabilities;
    /// Return the journal backlog, or None when the host reports no journal.
    fn journal_backlog(&self) -> Option<JournalBacklog>;
}

/// Optional host LLM completion callback; cancellation is checked at each boundary.
pub trait LlmPort: Send + Sync {
    /// Complete the supplied messages without exposing provider bodies in errors.
    fn complete(&self, params: LlmParams, cancel: &Cancel) -> Result<LlmResult, HostError>;
}

/// Optional host secret-store callback. Names identify secrets, never their values.
pub trait SecretPort: Send + Sync {
    /// Resolve a configured secret name; an unknown name returns None.
    fn get(&self, name: &str) -> Result<Option<SecretValue>, HostError>;
}

/// An intentionally non-printable secret value, kept only for the provider call.
/// It implements neither Debug nor Display so routine diagnostics cannot reveal it.
///
/// ```compile_fail
/// use plur1bus_engine::contract::SecretValue;
/// let value = SecretValue::new("test-only-secret");
/// let diagnostic = format!("{value:?}");
/// ```
///
/// ```compile_fail
/// use plur1bus_engine::contract::SecretValue;
/// let value = SecretValue::new("test-only-secret");
/// let diagnostic = format!("{value}");
/// ```
pub struct SecretValue(String);

impl SecretValue {
    /// Wrap a resolved secret without adding diagnostic formatting implementations.
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// Access the value explicitly for one provider call; never log or persist it.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

/// An HTTP scheme accepted by the outbound transport.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum Scheme {
    /// Plain HTTP.
    Http,
    /// TLS-protected HTTP.
    Https,
}

/// The next outbound hop, before DNS resolution or connection.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct Target {
    /// The requested HTTP scheme.
    pub scheme: Scheme,
    /// The requested host name, before DNS resolution.
    pub host: String,
    /// The requested destination port.
    pub port: u16,
}

/// A synchronous per-hop policy decision; address checks still follow resolution.
pub trait EgressGate: Send + Sync {
    /// Decide whether the target may be resolved and connected to.
    fn decide(&self, target: &Target) -> Decision;
}

/// The policy decision for a single outbound hop.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Decision {
    /// Permit the hop subject to checking every resolved address against these rules.
    Allow {
        /// Address classes permitted by the policy decision.
        address_rules: AddressRules,
    },
    /// Refuse the hop before DNS resolution or connection.
    Deny {
        /// A log-safe policy reason, without credentials or response bodies.
        reason: String,
    },
}

/// Address classes independently authorized by an egress policy.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct AddressRules {
    /// Permit loopback addresses.
    pub allow_loopback: bool,
    /// Permit private and link-local addresses, excluding metadata unless separately allowed.
    pub allow_private: bool,
    /// Permit known cloud metadata endpoints.
    pub allow_metadata: bool,
}

/// A callback that applies host-native filesystem permissions.
pub type SecurePathCallback = dyn Fn(&Path, Option<u32>) -> SecurePathResult + Send + Sync;
/// A callback that derives a host-native IPC address without binding it.
pub type IpcAddressCallback = dyn Fn(&Path) -> IpcAddress + Send + Sync;
/// A callback that identifies unsafe filesystem links.
pub type UnsafeLinkCallback = dyn Fn(&Path) -> bool + Send + Sync;
/// A callback that canonicalizes a path for persistent identity comparisons.
pub type CanonicalIdentityPathCallback = dyn Fn(&Path) -> PathBuf + Send + Sync;

/// Host-native filesystem and address callbacks, shared safely between engine stages.
#[derive(Clone)]
pub struct PlatformCapabilities {
    /// Apply platform-native permission controls, with an optional POSIX mode.
    pub secure_path: Arc<SecurePathCallback>,
    /// Derive the platform's IPC address from a state root, without opening a listener.
    pub ipc_address: Arc<IpcAddressCallback>,
    /// Identify paths that are unsafe links before filesystem operations.
    pub is_unsafe_link: Arc<UnsafeLinkCallback>,
    /// Normalize a path for persistent identity comparisons.
    pub canonical_identity_path: Arc<CanonicalIdentityPathCallback>,
}

impl Default for PlatformCapabilities {
    fn default() -> Self {
        Self {
            secure_path: Arc::new(|_, _| SecurePathResult {
                applied: false,
                reason: Some(SecurePathResultReason::UnsupportedPlatform),
                mechanism: None,
            }),
            ipc_address: Arc::new(|_| IpcAddress {
                kind: IpcAddressKind::UnixSocket,
                address: String::new(),
            }),
            is_unsafe_link: Arc::new(|_| true),
            canonical_identity_path: Arc::new(Path::to_path_buf),
        }
    }
}

impl PlatformCapabilities {
    /// Apply host-native permission controls through the configured callback.
    pub fn secure_path(&self, path: &Path, mode: Option<u32>) -> SecurePathResult {
        (self.secure_path)(path, mode)
    }

    /// Derive the host-native IPC address without binding it.
    pub fn ipc_address(&self, state_root: &Path) -> IpcAddress {
        (self.ipc_address)(state_root)
    }

    /// Check the host's unsafe-link policy without implicit filesystem access.
    pub fn is_unsafe_link(&self, path: &Path) -> bool {
        (self.is_unsafe_link)(path)
    }

    /// Normalize a path through the host's identity callback.
    pub fn canonical_identity_path(&self, path: &Path) -> PathBuf {
        (self.canonical_identity_path)(path)
    }
}
