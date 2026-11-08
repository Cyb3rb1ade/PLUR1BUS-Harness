//! Dedicated capture fixtures; recall's shared fixtures remain unchanged.
#![allow(clippy::unwrap_used)]

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use plur1bus_engine::capture::accept::CaptureRuntime;
use plur1bus_engine::contract::{
    AgentId, Cancel, Decision, EgressGate, EmbedError, EmbedKind, EngineConfig, HostError,
    HostServices, JournalBacklog, LlmPort, PlatformCapabilities, SecretPort, Target,
    VectorSpaceIdentity,
};
use plur1bus_engine::embedding::EmbeddingProvider;

pub struct Host {
    state: PathBuf,
    workspace: PathBuf,
    config: EngineConfig,
    platform: PlatformCapabilities,
    llm: Option<Arc<dyn LlmPort>>,
}

impl Host {
    pub fn new(state: PathBuf, workspace: PathBuf, config: EngineConfig) -> Self {
        Self {
            state,
            workspace,
            config,
            platform: PlatformCapabilities::default(),
            llm: None,
        }
    }
    pub fn with_llm(mut self, llm: Arc<dyn LlmPort>) -> Self {
        self.llm = Some(llm);
        self
    }
}

impl HostServices for Host {
    fn state_dir(&self) -> &Path {
        &self.state
    }
    fn config(&self) -> EngineConfig {
        self.config.clone()
    }
    fn workspace_dir(&self, _agent: &AgentId) -> Result<Option<PathBuf>, HostError> {
        Ok(Some(self.workspace.clone()))
    }
    fn llm(&self) -> Option<&dyn LlmPort> {
        self.llm.as_deref()
    }
    fn secrets(&self) -> Option<&dyn SecretPort> {
        None
    }
    fn egress(&self) -> &dyn EgressGate {
        self
    }
    fn emit(&self, _event: &str, _payload: serde_json::Value) {}
    fn now_ms(&self) -> i64 {
        1_710_000_000_000
    }
    fn platform(&self) -> &PlatformCapabilities {
        &self.platform
    }
    fn journal_backlog(&self) -> Option<JournalBacklog> {
        None
    }
}

impl EgressGate for Host {
    fn decide(&self, _target: &Target) -> Decision {
        Decision::Deny {
            reason: "capture fixture refuses network".into(),
        }
    }
}

pub struct HashEmbedder {
    identity: VectorSpaceIdentity,
    flat: bool,
}

impl HashEmbedder {
    pub fn new(flat: bool) -> Self {
        Self {
            identity: serde_json::from_value(serde_json::json!({
                "provider":"fixture", "model":"capture-hash", "revision":"1", "dimension":384,
                "normalization":"l2", "prefixScheme":"fixture", "instruction":"", "dtype":"f32",
                "tokenCap":null,"pooling":"mean","artifacts":[]
            }))
            .unwrap(),
            flat,
        }
    }
}

impl EmbeddingProvider for HashEmbedder {
    fn identity(&self) -> &VectorSpaceIdentity {
        &self.identity
    }
    fn embed(
        &self,
        texts: &[String],
        _kind: EmbedKind,
        cancel: &Cancel,
    ) -> Result<Vec<Vec<f32>>, EmbedError> {
        cancel.check().map_err(EmbedError::Cancelled)?;
        Ok(texts
            .iter()
            .map(|text| {
                if self.flat {
                    return (0..384)
                        .map(|index| if index == 0 { 1.0 } else { 0.0 })
                        .collect();
                }
                let mut hash = 0x811c_9dc5u32;
                for unit in text.encode_utf16() {
                    hash ^= u32::from(unit);
                    hash = hash.wrapping_mul(0x0100_0193);
                }
                let scale = 1.0 / 384f64.sqrt();
                (0..384)
                    .map(|index| {
                        if hash >> (index % 24) & 1 != 0 {
                            scale as f32
                        } else {
                            -scale as f32
                        }
                    })
                    .collect()
            })
            .collect())
    }
}

pub struct RuntimeGuard(pub CaptureRuntime);
impl Drop for RuntimeGuard {
    fn drop(&mut self) {
        let _ = self.0.close(Duration::from_secs(3));
    }
}
