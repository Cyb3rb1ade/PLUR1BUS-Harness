//! Host-owned temperament selection and mood state shared by capture and recall.
use super::{
    emotion_state::EmotionalState,
    emotion_store::{MoodCommit, MoodStore},
};
use crate::{
    context::RequestContext,
    contract::{AgentContext, Cancel, EngineError, HostServices, Principal, StoreError},
    text::json::{parse_json, TolerantJsonValue as Json},
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

/// Per-agent configuration, with per-owner/workspace persistence enforced by MoodStore.
pub struct EmotionalPool {
    host: Arc<dyn HostServices>,
    config: Value,
    stores: Mutex<HashMap<String, Arc<MoodStore>>>,
    transient: Mutex<HashMap<(String, String, String), EmotionalState>>,
}
impl EmotionalPool {
    /// Capture a resolved emotion configuration; no files are created by construction.
    pub fn new(host: Arc<dyn HostServices>, emotion_config: Value) -> Self {
        Self {
            host,
            config: emotion_config,
            stores: Mutex::new(HashMap::new()),
            transient: Mutex::new(HashMap::new()),
        }
    }
    fn options(&self, agent: &str) -> Result<Json, EngineError> {
        let profiles = &self.config["temperaments"];
        let profile = profiles
            .get(agent)
            .filter(|v| !v.is_null())
            .unwrap_or(&profiles["default"]);
        let mut options = profile.as_object().cloned().unwrap_or_default();
        let influence = profile["moodInfluence"]
            .as_f64()
            .filter(|n| n.is_finite())
            .or_else(|| self.config["moodInfluence"].as_f64())
            .unwrap_or(0.3);
        options.insert("moodInfluence".into(), json!(influence));
        parse_json(&Value::Object(options).to_string()).map_err(|_| StoreError::InvalidInput.into())
    }
    fn store(&self, agent: &str) -> Result<Arc<MoodStore>, EngineError> {
        let mut stores = self.stores.lock().map_err(|_| StoreError::Corrupt)?;
        if let Some(store) = stores.get(agent) {
            return Ok(store.clone());
        }
        let store = Arc::new(MoodStore::new(self.host.clone(), self.options(agent)?)?);
        stores.insert(agent.into(), store.clone());
        Ok(store)
    }
    fn binding(
        &self,
        p: &Principal,
        a: &AgentContext,
    ) -> Result<(RequestContext, bool), EngineError> {
        let before = self.host.workspace_dir(&p.agent_id)?;
        let context = RequestContext::build(p, a, self.host.as_ref())?;
        if before != self.host.workspace_dir(&p.agent_id)? {
            return Err(StoreError::InvalidInput.into());
        }
        Ok((context, before.is_some()))
    }
    /// Read a bound persistent state, or the caller's private in-memory state without a workspace.
    pub fn read<T>(
        &self,
        p: &Principal,
        a: &AgentContext,
        cancel: &Cancel,
        project: impl FnOnce(&mut EmotionalState, i64) -> Result<T, EngineError>,
    ) -> Result<T, EngineError> {
        cancel.check()?;
        let (context, persistent) = self.binding(p, a)?;
        if persistent {
            return self
                .store(context.agent_id.as_str())?
                .read(p, a, cancel, project);
        }
        let now = self.host.now_ms();
        let key = (
            context.agent_id.to_string(),
            context.owner_user_id,
            context.workspace_key,
        );
        let states = self.transient.lock().map_err(|_| StoreError::Corrupt)?;
        let mut state = match states.get(&key) {
            Some(state) => state.clone(),
            None => EmotionalState::new(&self.options(&key.0)?, now)?,
        };
        let result = project(&mut state, now)?;
        if self.host.workspace_dir(&p.agent_id)?.is_some() {
            return Err(StoreError::InvalidInput.into());
        }
        cancel.check()?;
        Ok(result)
    }
    /// Update under the same ownership boundary. No-workspace state is explicitly process-local.
    pub fn update<T>(
        &self,
        p: &Principal,
        a: &AgentContext,
        cancel: &Cancel,
        update: impl FnOnce(&mut EmotionalState, i64) -> Result<T, EngineError>,
    ) -> Result<MoodCommit<T>, EngineError> {
        cancel.check()?;
        let (context, persistent) = self.binding(p, a)?;
        if persistent {
            return self
                .store(context.agent_id.as_str())?
                .update(p, a, cancel, update);
        }
        let now = self.host.now_ms();
        let key = (
            context.agent_id.to_string(),
            context.owner_user_id,
            context.workspace_key,
        );
        let mut states = self.transient.lock().map_err(|_| StoreError::Corrupt)?;
        let mut state = match states.get(&key) {
            Some(state) => state.clone(),
            None => EmotionalState::new(&self.options(&key.0)?, now)?,
        };
        let value = update(&mut state, now)?;
        if self.host.workspace_dir(&p.agent_id)?.is_some() {
            return Err(StoreError::InvalidInput.into());
        }
        cancel.check()?;
        states.insert(key, state);
        Ok(MoodCommit {
            value,
            display_written: false,
        })
    }
}
