//! Canonical per-agent/workspace enablement, persisted before cache invalidation.
use crate::{
    context::{normalize_workspace_target, validated_identity},
    store::{
        lock::{JobLock, LockBusy},
        paths::assert_trusted_path,
        state_file::StateFile,
    },
    text::js::locale_compare,
};
use serde_json::{json, Value};
use std::{
    fmt,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::Duration,
};
const MAX_SAFE: u64 = 9_007_199_254_740_991;
/// Safe policy failures. Debug/Display never include persisted text or identity values.
pub enum PolicyError {
    /// Invalid caller input.
    Invalid,
    /// An existing policy file failed validation.
    InvalidState,
    /// The expected tuple revision differs from the persisted one.
    Conflict {
        /// Current canonical record, returned only to the authorized operator.
        current: Value,
    },
    /// A filesystem or competing-writer failure.
    Storage,
    /// A context has no canonical agent/workspace tuple.
    IdentityRequired,
    /// The tuple is disabled.
    Disabled {
        /// Canonical policy responsible for the disabled decision.
        policy: Value,
    },
    /// Re-embedding is switching the active generation.
    Maintenance,
}
impl PolicyError {
    /// Node's fixed machine code, without data from the invalid input.
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::Invalid => "invalid",
            Self::InvalidState => "workspace_policy_state_invalid",
            Self::Conflict { .. } => "workspace_policy_revision_conflict",
            Self::Storage => "storage",
            Self::IdentityRequired => "workspace_identity_required",
            Self::Disabled { .. } => "workspace_disabled",
            Self::Maintenance => "migration_switching",
        }
    }
}
impl fmt::Debug for PolicyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}
impl fmt::Display for PolicyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}
impl std::error::Error for PolicyError {}
fn identity(input: &Value) -> Result<(String, String), PolicyError> {
    let agent = input["agentId"].as_str().ok_or(PolicyError::Invalid)?;
    crate::context::safe_agent_id(agent).map_err(|_| PolicyError::Invalid)?;
    let workspace = normalize_workspace_target(
        input["workspaceIdentity"]
            .as_str()
            .ok_or(PolicyError::Invalid)?,
        "workspace identity",
    )
    .map_err(|_| PolicyError::Invalid)?;
    Ok((agent.to_owned(), workspace))
}
fn revision(value: &Value) -> Result<u64, PolicyError> {
    let number = value.as_f64().ok_or(PolicyError::Invalid)?;
    if number < 0. || number > MAX_SAFE as f64 || number.fract() != 0. {
        return Err(PolicyError::Invalid);
    }
    Ok(number as u64)
}
fn timestamp(value: &Value) -> Result<u64, PolicyError> {
    let number = value.as_f64().ok_or(PolicyError::Invalid)?;
    if !(0. ..=1e15).contains(&number) {
        return Err(PolicyError::Invalid);
    }
    Ok(number.floor() as u64)
}
fn actor(value: &Value) -> Result<String, PolicyError> {
    validated_identity(
        value.as_str(),
        crate::contract::limits::PRINCIPAL,
        "policy actor",
        true,
    )
    .map_err(|_| PolicyError::Invalid)
}
fn key(agent: &str, workspace: &str) -> String {
    format!("{agent}\0{workspace}")
}
fn external(mut record: Value) -> Value {
    record["source"] = json!("override");
    record
}
fn default_record(agent: &str, workspace: &str) -> Value {
    json!({"agentId":agent,"workspaceIdentity":workspace,"enabled":true,"revision":0,"source":"default"})
}
fn validate_state(raw: &Value) -> Result<Value, PolicyError> {
    let fields = raw.as_object().ok_or(PolicyError::InvalidState)?;
    if fields.len() != 3
        || raw["schemaVersion"].as_f64() != Some(1.)
        || !fields.contains_key("revision")
        || !fields.contains_key("policies")
    {
        return Err(PolicyError::InvalidState);
    }
    let revision = revision(&raw["revision"]).map_err(|_| PolicyError::InvalidState)?;
    let mut records = serde_json::Map::new();
    for (stored_key, record) in raw["policies"]
        .as_object()
        .ok_or(PolicyError::InvalidState)?
    {
        let value = validate_record(stored_key, record).map_err(|_| PolicyError::InvalidState)?;
        records.insert(stored_key.clone(), value);
    }
    Ok(json!({"schemaVersion":1,"revision":revision,"policies":records}))
}
fn validate_record(stored_key: &str, record: &Value) -> Result<Value, PolicyError> {
    let fields = record.as_object().ok_or(PolicyError::Invalid)?;
    let allowed = [
        "agentId",
        "workspaceIdentity",
        "enabled",
        "revision",
        "updatedAt",
        "actorId",
    ];
    if fields
        .keys()
        .any(|field| !allowed.contains(&field.as_str()))
    {
        return Err(PolicyError::Invalid);
    }
    let (agent, workspace) = identity(record)?;
    if key(&agent, &workspace) != stored_key {
        return Err(PolicyError::Invalid);
    }
    Ok(json!({
        "agentId": agent,
        "workspaceIdentity": workspace,
        "enabled": record["enabled"].as_bool().ok_or(PolicyError::Invalid)?,
        "revision": revision(&record["revision"])?,
        "updatedAt": timestamp(&record["updatedAt"])?,
        "actorId": actor(&record["actorId"])?
    }))
}
/// Internal operator store. Public caller-bound administration is composed separately.
pub struct PolicyStore {
    path: PathBuf,
}
impl PolicyStore {
    /// Validate a host-owned root; reads never create policy directories.
    pub fn new(state_root: &Path) -> Result<Self, PolicyError> {
        let path = state_root.join("control/workspace-policy.json");
        assert_trusted_path(&path).map_err(|_| PolicyError::Storage)?;
        Ok(Self { path })
    }
    fn read(&self) -> Result<Value, PolicyError> {
        match StateFile::<Value>::load(&self.path) {
            Ok(Some(raw)) => validate_state(&raw),
            Ok(None) => Ok(json!({"schemaVersion":1,"revision":0,"policies":{}})),
            Err(_) => Err(PolicyError::InvalidState),
        }
    }
    /// Read one canonical tuple, defaulting to enabled without writing it.
    pub fn get(&self, input: &Value) -> Result<Value, PolicyError> {
        let (a, w) = identity(input)?;
        let state = self.read()?;
        Ok(state["policies"]
            .get(key(&a, &w))
            .cloned()
            .map_or_else(|| default_record(&a, &w), external))
    }
    /// Internal operator list in Node's pinned locale order; not a caller-authorized API.
    pub fn list(&self) -> Result<Value, PolicyError> {
        let state = self.read()?;
        let mut rows = state["policies"]
            .as_object()
            .ok_or(PolicyError::InvalidState)?
            .values()
            .cloned()
            .map(external)
            .collect::<Vec<_>>();
        rows.sort_by(|a, b| {
            locale_compare(
                &key(
                    a["agentId"].as_str().unwrap_or(""),
                    a["workspaceIdentity"].as_str().unwrap_or(""),
                ),
                &key(
                    b["agentId"].as_str().unwrap_or(""),
                    b["workspaceIdentity"].as_str().unwrap_or(""),
                ),
            )
        });
        Ok(Value::Array(rows))
    }
    /// Compare-and-set one tuple; revision and durable state advance together.
    pub fn set(&self, input: &Value, now: i64) -> Result<Value, PolicyError> {
        let (a, w) = identity(input)?;
        let enabled = input["enabled"].as_bool().ok_or(PolicyError::Invalid)?;
        let expected = revision(&input["expectedRevision"])?;
        let actor = actor(&input["actorId"])?;
        static WRITER: OnceLock<Mutex<()>> = OnceLock::new();
        let _serial = WRITER
            .get_or_init(|| Mutex::new(()))
            .lock()
            .map_err(|_| PolicyError::Storage)?;
        let directory = self.path.parent().ok_or(PolicyError::Storage)?;
        let lease = JobLock::acquire(directory, "workspace-policy", Duration::from_secs(30))
            .map_err(|e| match e {
                LockBusy::Held | LockBusy::Store(_) => PolicyError::Storage,
            })?;
        let mut state = self.read()?;
        let key = key(&a, &w);
        let current = state["policies"].get(&key);
        let current_revision = current
            .map(|r| revision(&r["revision"]))
            .transpose()?
            .unwrap_or(0);
        if current_revision != expected {
            return Err(PolicyError::Conflict {
                current: current
                    .cloned()
                    .map_or_else(|| default_record(&a, &w), external),
            });
        }
        let global = revision(&state["revision"])?;
        if current_revision == MAX_SAFE || global == MAX_SAFE {
            return Err(PolicyError::InvalidState);
        }
        let record = json!({"agentId":a,"workspaceIdentity":w,"enabled":enabled,"revision":current_revision+1,"updatedAt":timestamp(&json!(now))?,"actorId":actor});
        state["revision"] = json!(global + 1);
        state["policies"][key] = record.clone();
        if !lease.is_owned() {
            return Err(PolicyError::Storage);
        }
        StateFile::store(&self.path, &state).map_err(|_| PolicyError::Storage)?;
        Ok(external(record))
    }
    /// Maintenance takes precedence over enablement and identity lookup.
    pub fn decision(&self, context: &Value, maintenance: bool) -> Result<Value, PolicyError> {
        if maintenance {
            return Ok(
                json!({"allowed":false,"reason":"migration_switching","retryable":true,"policy":null}),
            );
        }
        if context["agentId"].as_str().is_none_or(str::is_empty)
            || context["workspaceIdentity"]
                .as_str()
                .is_none_or(str::is_empty)
        {
            return Err(PolicyError::IdentityRequired);
        }
        let policy = self.get(context)?;
        Ok(json!({"allowed":policy["enabled"],"policy":policy}))
    }
    /// Explicit paths reject disabled or switching workspaces.
    pub fn require_enabled(
        &self,
        context: &Value,
        maintenance: bool,
    ) -> Result<Value, PolicyError> {
        let result = self.decision(context, maintenance)?;
        if result["allowed"] == true {
            return Ok(result["policy"].clone());
        }
        if result["reason"] == "migration_switching" {
            Err(PolicyError::Maintenance)
        } else {
            Err(PolicyError::Disabled {
                policy: result["policy"].clone(),
            })
        }
    }
    /// Automatic paths fail closed, including unreadable state and missing identity.
    #[must_use]
    pub fn automatic(&self, context: &Value, maintenance: bool) -> Value {
        match self.decision(context, maintenance) {
            Ok(v) if v["allowed"] == true => json!({"allowed":true}),
            Ok(v) if v["reason"] == "migration_switching" => {
                json!({"allowed":false,"reason":"migration_switching","retryable":true})
            }
            Ok(_) => json!({"allowed":false,"reason":"workspace_disabled"}),
            Err(e) => json!({"allowed":false,"reason":e.code()}),
        }
    }
    /// Invalidate host-owned readers only after the new policy is durable.
    pub fn set_and_invalidate(
        &self,
        input: &Value,
        now: i64,
        invalidate: impl FnOnce(&Value) -> Result<(), PolicyError>,
    ) -> Result<Value, PolicyError> {
        let policy = self.set(input, now)?;
        invalidate(
            &json!({"agentId":policy["agentId"],"workspaceIdentity":policy["workspaceIdentity"]}),
        )?;
        Ok(policy)
    }
}
