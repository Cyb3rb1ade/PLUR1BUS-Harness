//! Authenticated workspace mood state. Node's ownerless restoration is not authority (RE-D51).
use super::{
    emotion_json::{entries, num, object, string},
    emotion_state::{format_mood_file, EmotionalState},
    wal::kernel_lock,
};
use crate::{
    context::RequestContext,
    contract::{AgentContext, Cancel, EngineError, HostServices, Principal, StoreError},
    store::{atomic_write::atomic_write, directory::TrustedDirectory, state_file::StateFile},
    text::{
        js::JsString,
        json::{parse_json, write_json, TolerantJsonValue as Json},
    },
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::Read,
    sync::{Arc, Mutex},
};

const STATE: &str = ".emotional-state.json";
const DISPLAY: &str = ".current-mood.txt";
const MAX_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Clone, PartialEq, Eq, Hash)]
struct Binding {
    agent: String,
    workspace: String,
    owner: String,
    directory: String,
}
impl Binding {
    fn json(&self) -> Json {
        object([
            ("version", num(1.)),
            ("agentId", string(&self.agent)),
            ("workspaceIdentity", string(&self.workspace)),
            ("ownerUserId", string(&self.owner)),
            ("directory", string(&self.directory)),
        ])
    }

    fn files(&self) -> (String, String) {
        if !self.owner.starts_with("user:v2:") {
            return (STATE.into(), DISPLAY.into());
        }
        let key = format!("{:x}", Sha256::digest(write_json(&self.json()).as_bytes()));
        (
            format!(".emotional-state-{key}.json"),
            format!(".current-mood-{key}.txt"),
        )
    }
}
struct Cached {
    disk: Option<String>,
    state: EmotionalState,
}
/// Result after the authoritative JSON is durable. A failed derived display is explicitly partial.
pub struct MoodCommit<T> {
    /// Caller computation performed against the committed state.
    pub value: T,
    /// Whether the optional human-readable companion was also published successfully.
    pub display_written: bool,
}
/// A host-owned pool. Every call rebuilds request authority; no caller may select a file path.
pub struct MoodStore {
    host: Arc<dyn HostServices>,
    options: Json,
    cache: Mutex<HashMap<Binding, Cached>>,
}
impl MoodStore {
    /// Own one configuration snapshot; changing temperament creates a fresh pool.
    pub fn new(host: Arc<dyn HostServices>, options: Json) -> Result<Self, EngineError> {
        EmotionalState::new(&options, host.now_ms())?;
        Ok(Self {
            host,
            options,
            cache: Mutex::new(HashMap::new()),
        })
    }
    fn bind(
        &self,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<(Binding, TrustedDirectory), EngineError> {
        let first = self
            .host
            .workspace_dir(&principal.agent_id)?
            .ok_or(StoreError::InvalidInput)?;
        let ctx = RequestContext::build(principal, agent, self.host.as_ref())?;
        let second = self.host.workspace_dir(&principal.agent_id)?;
        if second.as_ref() != Some(&first) || ctx.workspace_key.is_empty() {
            return Err(StoreError::InvalidInput.into());
        }
        let directory = TrustedDirectory::open(&first)?;
        let physical = directory.path().to_str().ok_or(StoreError::InvalidInput)?;
        let binding = Binding {
            agent: ctx.agent_id.to_string(),
            workspace: ctx.workspace_key,
            owner: ctx.owner_user_id,
            directory: physical.into(),
        };
        Ok((binding, directory))
    }
    fn state(
        &self,
        cache: &HashMap<Binding, Cached>,
        binding: &Binding,
        record: Option<&Json>,
        now: i64,
    ) -> Result<EmotionalState, EngineError> {
        let disk = record.map(write_json);
        if let Some(previous) = cache.get(binding).filter(|v| v.disk == disk) {
            return Ok(previous.state.clone());
        }
        let mut state = EmotionalState::new(&self.options, now)?;
        if record.is_some() && !state.hydrate_once(record, now)? {
            return Err(StoreError::Corrupt.into());
        }
        Ok(state)
    }
    /// Read-only decay/projection. No state, directory or lease file is created.
    pub fn read<T>(
        &self,
        p: &Principal,
        a: &AgentContext,
        cancel: &Cancel,
        project: impl FnOnce(&mut EmotionalState, i64) -> Result<T, EngineError>,
    ) -> Result<T, EngineError> {
        cancel.check()?;
        let (binding, directory) = self.bind(p, a)?;
        let cache = self.cache.lock().map_err(|_| StoreError::Corrupt)?;
        let (state_file, _) = binding.files();
        let record = load_bound(&directory, &binding, &state_file)?;
        let now = self.host.now_ms();
        let mut state = self.state(&cache, &binding, record.as_ref(), now)?;
        let result = project(&mut state, now)?;
        directory.assert_unchanged()?;
        cancel.check()?;
        Ok(result)
    }
    /// Serialize updates across processes, reread ownership, then fsync JSON before publishing display.
    /// Failed work never changes the cache. After the JSON commit cancellation cannot undo that commit.
    pub fn update<T>(
        &self,
        p: &Principal,
        a: &AgentContext,
        cancel: &Cancel,
        update: impl FnOnce(&mut EmotionalState, i64) -> Result<T, EngineError>,
    ) -> Result<MoodCommit<T>, EngineError> {
        cancel.check()?;
        let (binding, directory) = self.bind(p, a)?;
        let (state_file, display_file) = binding.files();
        // Reject foreign/corrupt state before even creating lock metadata.
        load_bound(&directory, &binding, &state_file)?;
        let locks = directory.create_child(".mood-leases")?;
        let lease_key = if state_file == STATE {
            "state"
        } else {
            &state_file
        };
        let lease = kernel_lock::acquire(&locks, lease_key, cancel, &mut || {})?;
        let mut cache = self.cache.lock().map_err(|_| StoreError::Corrupt)?;
        let existing = load(&directory, &binding, &state_file)?;
        let display_owned = display_matches(&directory, &binding, &display_file, existing.as_ref());
        let record = bound_or_legacy(existing, &directory, &binding, &state_file)?;
        let now = self.host.now_ms();
        let mut state = self.state(&cache, &binding, record.as_ref(), now)?;
        let value = update(&mut state, now)?;
        let mood = state.describe(now)?;
        let mut fields = entries(&mood);
        fields.extend([
            ("agentId".into(), string(&binding.agent)),
            ("ts".into(), num(now as f64)),
            ("state".into(), state.serialize_state(now)?),
            ("ownership".into(), binding.json()),
        ]);
        let record = object(fields);
        // Match the reader bound so an acknowledged state can always be reopened.
        if write_json(&record).len() as u64 + 1 > MAX_BYTES {
            return Err(StoreError::InvalidInput.into());
        }
        let display = format_mood_file(&mood, &binding.agent, now)?;
        lease.check(&locks)?;
        directory.assert_unchanged()?;
        cancel.check()?;
        StateFile::<Json>::store(&directory.path().join(&state_file), &record)?;
        directory.assert_unchanged()?;
        cache.insert(
            binding,
            Cached {
                disk: Some(write_json(&record)),
                state,
            },
        );
        // JSON is authoritative. Companion failure does not misreport a durable update as rolled back.
        let display_path = directory.path().join(display_file);
        let display_written = display_owned
            && directory.assert_unchanged().is_ok()
            && crate::store::paths::assert_trusted_path(&display_path).is_ok()
            && atomic_write(&display_path, display.as_bytes()).is_ok()
            && directory.assert_unchanged().is_ok();
        Ok(MoodCommit {
            value,
            display_written,
        })
    }
}
fn exact<'a>(value: &'a Json, key: &str) -> Result<&'a Json, StoreError> {
    let Json::Object(fields) = value else {
        return Err(StoreError::Corrupt);
    };
    let mut matches = fields
        .iter()
        .filter(|(name, _)| name == &JsString::from(key));
    let field = matches.next().ok_or(StoreError::Corrupt)?;
    if matches.next().is_some() {
        return Err(StoreError::Corrupt);
    }
    Ok(&field.1)
}
fn display_matches(
    directory: &TrustedDirectory,
    binding: &Binding,
    name: &str,
    record: Option<&Json>,
) -> bool {
    let file = match directory.open_file(name) {
        Ok(file) => file,
        Err(StoreError::Io {
            kind: std::io::ErrorKind::NotFound,
        }) => return true,
        Err(_) => return false,
    };
    let Some(record) = record else {
        return false;
    };
    let Ok(Json::Number(timestamp)) = exact(record, "ts") else {
        return false;
    };
    let Ok(timestamp) = timestamp.parse::<i64>() else {
        return false;
    };
    let Ok(expected) = format_mood_file(record, &binding.agent, timestamp) else {
        return false;
    };
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1).read_to_end(&mut bytes).is_ok() && bytes == expected.as_bytes()
}
fn load_bound(
    directory: &TrustedDirectory,
    binding: &Binding,
    name: &str,
) -> Result<Option<Json>, StoreError> {
    let record = load(directory, binding, name)?;
    bound_or_legacy(record, directory, binding, name)
}

fn bound_or_legacy(
    record: Option<Json>,
    directory: &TrustedDirectory,
    binding: &Binding,
    name: &str,
) -> Result<Option<Json>, StoreError> {
    if record.is_some() || name == STATE {
        return Ok(record);
    }
    // Adopt only an exactly matching legacy record. The shared file and any foreign or
    // malformed legacy state stay untouched when this person starts their own state.
    match load(directory, binding, STATE) {
        Ok(legacy) => Ok(legacy),
        Err(StoreError::Corrupt | StoreError::UntrustedPath) => Ok(None),
        Err(error) => Err(error),
    }
}

fn load(
    directory: &TrustedDirectory,
    binding: &Binding,
    name: &str,
) -> Result<Option<Json>, StoreError> {
    let file = match directory.open_file(name) {
        Ok(f) => f,
        Err(StoreError::Io {
            kind: std::io::ErrorKind::NotFound,
        }) => return Ok(None),
        Err(e) => return Err(e),
    };
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(StoreError::from)?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(StoreError::Corrupt);
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| StoreError::Corrupt)?;
    let value = parse_json(text).map_err(|_| StoreError::Corrupt)?;
    if exact(&value, "agentId")? != &string(&binding.agent)
        || exact(&value, "ownership")? != &binding.json()
    {
        return Err(StoreError::Corrupt);
    }
    let state = exact(&value, "state")?;
    exact(state, "current")?;
    directory.assert_unchanged()?;
    Ok(Some(value))
}
