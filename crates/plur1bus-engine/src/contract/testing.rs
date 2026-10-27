//! In-memory host services for engine contract and downstream stage tests.

use std::collections::{BTreeMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};

use serde_json::Value;

use super::{
    AgentId, Cancel, Decision, EgressGate, EngineConfig, HostError, HostServices, JournalBacklog,
    LlmParams, LlmPort, LlmResult, PlatformCapabilities, SecretPort, SecretValue, Target,
};

/// A deterministic host backed entirely by in-memory configuration and fixture maps.
/// Optional provider ports become available only after a fixture configures them.
/// Values are intentionally not printable so the secret map cannot enter diagnostics.
pub struct FakeHost {
    state_dir: PathBuf,
    config: Mutex<EngineConfig>,
    workspaces: Mutex<BTreeMap<String, PathBuf>>,
    secrets: Mutex<BTreeMap<String, String>>,
    secrets_enabled: AtomicBool,
    llm_answers: Mutex<VecDeque<Result<LlmResult, HostError>>>,
    llm_calls: Mutex<Vec<LlmParams>>,
    llm_enabled: AtomicBool,
    events: Mutex<Vec<(String, Value)>>,
    now_ms: AtomicI64,
    egress: Mutex<Decision>,
    platform: PlatformCapabilities,
    journal_backlog: Mutex<Option<JournalBacklog>>,
}

impl FakeHost {
    /// Create a host with the supplied state root and configuration, a zero clock,
    /// absent optional ports and an egress policy that denies every request.
    pub fn new(state_dir: PathBuf, config: EngineConfig) -> Self {
        Self {
            state_dir,
            config: Mutex::new(config),
            workspaces: Mutex::new(BTreeMap::new()),
            secrets: Mutex::new(BTreeMap::new()),
            secrets_enabled: AtomicBool::new(false),
            llm_answers: Mutex::new(VecDeque::new()),
            llm_calls: Mutex::new(Vec::new()),
            llm_enabled: AtomicBool::new(false),
            events: Mutex::new(Vec::new()),
            now_ms: AtomicI64::new(0),
            egress: Mutex::new(Decision::Deny {
                reason: "test host denies outbound requests".to_owned(),
            }),
            platform: PlatformCapabilities::default(),
            journal_backlog: Mutex::new(None),
        }
    }

    /// Replace the live configuration returned by subsequent host reads.
    pub fn set_config(&self, config: EngineConfig) {
        *lock(&self.config) = config;
    }

    /// Resolve this agent to the supplied workspace without accessing the filesystem.
    pub fn set_workspace(&self, agent: &AgentId, path: PathBuf) {
        lock(&self.workspaces).insert(agent.to_string(), path);
    }

    /// Store a named secret fixture and enable the optional secret port.
    pub fn set_secret(&self, name: &str, value: &str) {
        lock(&self.secrets).insert(name.to_owned(), value.to_owned());
        self.secrets_enabled.store(true, Ordering::Release);
    }

    /// Queue one LLM completion result and enable the optional LLM port.
    /// Once enabled, the port remains available after its answer queue is empty.
    pub fn queue_llm_result(&self, result: Result<LlmResult, HostError>) {
        lock(&self.llm_answers).push_back(result);
        self.llm_enabled.store(true, Ordering::Release);
    }

    /// Return the completion requests accepted after their cancellation check.
    pub fn llm_calls(&self) -> Vec<LlmParams> {
        lock(&self.llm_calls).clone()
    }

    /// Return a snapshot of named events emitted through the host port.
    pub fn events(&self) -> Vec<(String, Value)> {
        lock(&self.events).clone()
    }

    /// Set the deterministic clock in epoch milliseconds.
    pub fn set_now_ms(&self, now_ms: i64) {
        self.now_ms.store(now_ms, Ordering::Release);
    }

    /// Replace the decision returned for every outbound target.
    pub fn set_egress(&self, decision: Decision) {
        *lock(&self.egress) = decision;
    }

    /// Supply the native platform callbacks used by this host.
    pub fn set_platform(&mut self, platform: PlatformCapabilities) {
        self.platform = platform;
    }

    /// Set the backlog reported by the optional host journal.
    pub fn set_journal_backlog(&self, backlog: Option<JournalBacklog>) {
        *lock(&self.journal_backlog) = backlog;
    }
}

// A fixture panic must not make the host's unrelated state unreadable during cleanup.
// Recovering the guarded value keeps later assertions and teardown deterministic.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl HostServices for FakeHost {
    fn state_dir(&self) -> &Path {
        &self.state_dir
    }

    fn config(&self) -> EngineConfig {
        lock(&self.config).clone()
    }

    fn workspace_dir(&self, agent: &AgentId) -> Result<Option<PathBuf>, HostError> {
        Ok(lock(&self.workspaces).get::<str>(agent).cloned())
    }

    fn llm(&self) -> Option<&dyn LlmPort> {
        self.llm_enabled.load(Ordering::Acquire).then_some(self)
    }

    fn secrets(&self) -> Option<&dyn SecretPort> {
        self.secrets_enabled.load(Ordering::Acquire).then_some(self)
    }

    fn egress(&self) -> &dyn EgressGate {
        self
    }

    fn emit(&self, event: &str, payload: Value) {
        lock(&self.events).push((event.to_owned(), payload));
    }

    fn now_ms(&self) -> i64 {
        self.now_ms.load(Ordering::Acquire)
    }

    fn platform(&self) -> &PlatformCapabilities {
        &self.platform
    }

    fn journal_backlog(&self) -> Option<JournalBacklog> {
        lock(&self.journal_backlog).clone()
    }
}

impl LlmPort for FakeHost {
    fn complete(&self, params: LlmParams, cancel: &Cancel) -> Result<LlmResult, HostError> {
        cancel.check()?;
        lock(&self.llm_calls).push(params);
        lock(&self.llm_answers)
            .pop_front()
            .unwrap_or(Err(HostError::Unavailable))
    }
}

impl SecretPort for FakeHost {
    fn get(&self, name: &str) -> Result<Option<SecretValue>, HostError> {
        Ok(lock(&self.secrets).get(name).cloned().map(SecretValue::new))
    }
}

impl EgressGate for FakeHost {
    fn decide(&self, _target: &Target) -> Decision {
        lock(&self.egress).clone()
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]
    use super::*;
    use crate::contract::{
        AddressRules, AgentId, Cancel, Decision, EngineConfig, HostServices, LlmParams, LlmResult,
        Scheme, Target,
    };
    use serde_json::json;
    use std::path::PathBuf;

    fn host() -> FakeHost {
        let config: EngineConfig = serde_json::from_value(json!({})).unwrap();
        FakeHost::new(PathBuf::from("/memory-test"), config)
    }

    fn agent() -> AgentId {
        serde_json::from_value(json!("agent-one")).unwrap()
    }

    #[test]
    fn fake_host_resolves_workspaces_and_named_secrets_from_memory() {
        let host = host();
        assert!(host.workspace_dir(&agent()).unwrap().is_none());
        assert!(host.secrets().is_none());
        host.set_workspace(&agent(), PathBuf::from("/workspace/agent-one"));
        host.set_secret("providers/embedding", "test-only-key");
        assert_eq!(
            host.workspace_dir(&agent()).unwrap(),
            Some(PathBuf::from("/workspace/agent-one"))
        );
        let secrets = host.secrets().unwrap();
        assert_eq!(
            secrets
                .get("providers/embedding")
                .unwrap()
                .unwrap()
                .expose(),
            "test-only-key"
        );
        assert!(secrets.get("unknown").unwrap().is_none());
    }

    #[test]
    fn fake_host_uses_the_fixed_clock_and_records_events() {
        let host = host();
        host.set_now_ms(1_700_000_000_123);
        host.emit("capture.finished", json!({"stored": 1}));
        assert_eq!(host.now_ms(), 1_700_000_000_123);
        assert_eq!(
            host.events(),
            vec![("capture.finished".to_owned(), json!({"stored": 1}))]
        );
    }

    #[test]
    fn fake_host_denies_egress_until_explicitly_configured() {
        let host = host();
        let target = Target {
            scheme: Scheme::Https,
            host: "example.test".to_owned(),
            port: 443,
        };
        assert!(matches!(
            host.egress().decide(&target),
            Decision::Deny { .. }
        ));
        let rules = AddressRules {
            allow_loopback: true,
            ..AddressRules::default()
        };
        host.set_egress(Decision::Allow {
            address_rules: rules,
        });
        assert_eq!(
            host.egress().decide(&target),
            Decision::Allow {
                address_rules: rules
            }
        );
    }

    #[test]
    fn fake_host_returns_scripted_llm_answers_and_preserves_cancelled_answers() {
        let host = host();
        assert!(host.llm().is_none());
        let result: LlmResult = serde_json::from_value(json!({"text": "scripted answer"})).unwrap();
        host.queue_llm_result(Ok(result));
        let cancelled = Cancel::never();
        cancelled.cancel();
        let params: LlmParams = serde_json::from_value(json!({"messages": []})).unwrap();
        assert!(host
            .llm()
            .unwrap()
            .complete(params.clone(), &cancelled)
            .is_err());
        let result = host
            .llm()
            .unwrap()
            .complete(params, &Cancel::never())
            .unwrap();
        assert_eq!(result.text, "scripted answer");
        assert_eq!(host.llm_calls().len(), 1);
        let params: LlmParams = serde_json::from_value(json!({"messages": []})).unwrap();
        assert!(matches!(
            host.llm().unwrap().complete(params, &Cancel::never()),
            Err(HostError::Unavailable)
        ));
    }
}
