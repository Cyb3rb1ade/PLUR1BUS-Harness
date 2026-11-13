//! `config-disclosure.ts`: installed module privacy declarations supplement the embedded config schema. Loading never reads
//! the secret store. [`load_config_disclosure_policy`] reads the manifests of `<home>/modules/*/module.json` into an
//! immutable [`ConfigDisclosurePolicy`]; missing, damaged or unsupported metadata keeps the module's values private.
//! [`watch_config_disclosure_policy`] reports changes of the registry by polling its stamp (TypeScript additionally uses
//! directory events to be prompt; here the interval is the only trigger, and it is a parameter).
use super::policy::plain;
use plur1bus_config::{
    config_text_secret_values, configuration_warnings, secret_text_values_with_schema,
    supports_config_disclosure_policy, ConfigWarning,
};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, OnceLock};
use std::thread::JoinHandle;
use std::time::Duration;

/// How often the registry is checked (default), as in TypeScript.
pub const POLICY_POLL_MS: u64 = 1000;
const MAX_POLICY_READ_ATTEMPTS: usize = 3;
const MAX_WARNINGS: usize = 50;

#[derive(Debug, Clone, PartialEq)]
struct ModulePolicy {
    name: String,
    schema: Option<Value>,
    unavailable: bool,
}

/// Immutable policy snapshot. Module manifests are read in bulk at startup and before accepted module changes.
#[derive(Debug, Clone, PartialEq)]
pub struct ConfigDisclosurePolicy {
    policies: Vec<ModulePolicy>,
    unavailable: bool,
}

fn manifest_validator() -> Option<&'static jsonschema::Validator> {
    static V: OnceLock<Option<jsonschema::Validator>> = OnceLock::new();
    V.get_or_init(|| {
        let schema: Value = serde_json::from_str(include_str!(
            "../../../../packages/module-api/schema/manifest.schema.json"
        ))
        .ok()?;
        jsonschema::options()
            .with_draft(jsonschema::Draft::Draft202012)
            .build(&schema)
            .ok()
    })
    .as_ref()
}

/// `modulePolicy`: the privacy declaration of one installed module, or an unavailable marker.
fn module_policy(directory: &Path, name: &str) -> ModulePolicy {
    let unavailable = || ModulePolicy {
        name: name.to_owned(),
        schema: None,
        unavailable: true,
    };
    let Ok(bytes) = fs::read(directory.join(name).join("module.json")) else {
        return unavailable();
    };
    let Ok(manifest) = serde_json::from_str::<Value>(&String::from_utf8_lossy(&bytes)) else {
        return unavailable();
    };
    if !manifest_validator().is_some_and(|v| v.is_valid(&manifest))
        || manifest.get("name").and_then(Value::as_str) != Some(name)
    {
        return unavailable();
    }
    let Some(schema) = manifest.get("configSchema") else {
        return ModulePolicy {
            name: name.to_owned(),
            schema: None,
            unavailable: false,
        };
    };
    if !supports_config_disclosure_policy(schema) {
        return unavailable();
    }
    // Harness owns `enabled` even if the module omits it. The module's root and local definitions stay intact.
    let mut schema = schema.clone();
    if let Some(root) = schema.as_object_mut() {
        let mut properties = root
            .get("properties")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        properties.insert("enabled".into(), json!({"type": "boolean"}));
        root.insert("properties".into(), Value::Object(properties));
    }
    ModulePolicy {
        name: name.to_owned(),
        schema: Some(schema),
        unavailable: false,
    }
}

/// `privateModuleValues`: every text value of a module whose metadata is unavailable.
fn private_module_values(value: &Value) -> Vec<String> {
    // enabled is a Harness boolean control; damaged module metadata cannot turn every logged false into a secret.
    let private = match value.as_object() {
        Some(module) if module.get("enabled").is_some_and(Value::is_boolean) => Value::Object(
            module
                .iter()
                .filter(|(name, _)| name.as_str() != "enabled")
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
        ),
        _ => value.clone(),
    };
    secret_text_values_with_schema(&private, &json!({"x-sensitive": true}))
}

impl ConfigDisclosurePolicy {
    fn snapshot(policies: Vec<ModulePolicy>, unavailable: bool) -> Self {
        Self {
            policies,
            unavailable,
        }
    }

    /// A snapshot with no module metadata: nothing installed.
    pub fn empty() -> Self {
        Self::snapshot(Vec::new(), false)
    }

    /// A snapshot whose registry could not be read: every configured module value stays private.
    pub fn unavailable() -> Self {
        Self::snapshot(Vec::new(), true)
    }

    /// The text values of `config` that must be registered as secrets: the Harness schema's, with each installed module's
    /// own declarations applied to `modules.<name>`. The values are returned sorted and de-duplicated.
    pub fn values(&self, config: &Value) -> Vec<String> {
        let root = config.as_object();
        let configured = root
            .and_then(|r| r.get("modules"))
            .and_then(Value::as_object);
        let mut known: BTreeMap<&str, ModulePolicy> = self
            .policies
            .iter()
            .filter(|p| p.schema.is_some() || p.unavailable)
            .map(|p| (p.name.as_str(), p.clone()))
            .collect();
        if self.unavailable {
            for name in configured.into_iter().flat_map(Map::keys) {
                known.insert(
                    name,
                    ModulePolicy {
                        name: name.clone(),
                        schema: None,
                        unavailable: true,
                    },
                );
            }
        }
        // The base pass must never register a known module's public values before its own schema grants exemptions.
        let base = match (root, configured) {
            (Some(root), Some(configured)) => {
                let mut copy = root.clone();
                copy.insert(
                    "modules".into(),
                    Value::Object(
                        configured
                            .iter()
                            .filter(|(name, _)| !known.contains_key(name.as_str()))
                            .map(|(k, v)| (k.clone(), v.clone()))
                            .collect(),
                    ),
                );
                Value::Object(copy)
            }
            _ => config.clone(),
        };
        let mut values: BTreeSet<String> = config_text_secret_values(&base).into_iter().collect();
        for (name, policy) in &known {
            let Some(module) = configured.and_then(|c| c.get(*name)) else {
                continue;
            };
            match (&policy.schema, policy.unavailable) {
                (Some(schema), false) => {
                    values.extend(secret_text_values_with_schema(module, schema))
                }
                _ => values.extend(private_module_values(module)),
            }
        }
        values.into_iter().collect()
    }

    /// Module-only notices; the configuration source already reports the Harness schema's warnings. At most 50.
    pub fn warnings(&self, config: &Value) -> Vec<ConfigWarning> {
        let configured = plain(plain(Some(config)).get("modules"));
        let mut warnings = Vec::new();
        if self.unavailable && !configured.is_empty() {
            warnings.push(ConfigWarning {
                key: "modules".into(),
                message: "Module sensitivity metadata is unavailable; values remain private. Repair the installed module registry.".into(),
            });
        }
        for policy in &self.policies {
            if !configured.contains_key(&policy.name) || warnings.len() >= MAX_WARNINGS {
                continue;
            }
            if policy.unavailable {
                warnings.push(ConfigWarning {
                    key: format!("modules.{}", policy.name),
                    message: "Module sensitivity metadata is unavailable; values remain private. Repair its module.json manifest.".into(),
                });
            } else if let Some(schema) = &policy.schema {
                for warning in configuration_warnings(&configured[&policy.name], schema) {
                    if warnings.len() >= MAX_WARNINGS {
                        break;
                    }
                    let key = if warning.key.is_empty() {
                        format!("modules.{}", policy.name)
                    } else {
                        format!("modules.{}.{}", policy.name, warning.key)
                    };
                    warnings.push(ConfigWarning {
                        key,
                        message: warning.message,
                    });
                }
            }
        }
        warnings
    }
}

fn module_directories(directory: &Path) -> io::Result<Vec<String>> {
    let mut names = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if entry.file_type()?.is_dir() && !name.starts_with('.') && !name.contains(".tmp-") {
            names.push(name);
        }
    }
    names.sort();
    Ok(names)
}

#[cfg(unix)]
fn file_stamp(meta: &fs::Metadata) -> String {
    use std::os::unix::fs::MetadataExt;
    format!(
        "{}:{}.{:09}:{}.{:09}:{}",
        meta.ino(),
        meta.mtime(),
        meta.mtime_nsec(),
        meta.ctime(),
        meta.ctime_nsec(),
        meta.len()
    )
}

#[cfg(not(unix))]
fn file_stamp(meta: &fs::Metadata) -> String {
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos());
    format!("{modified}:{}", meta.len())
}

#[cfg(unix)]
fn directory_stamp(meta: &fs::Metadata) -> String {
    use std::os::unix::fs::MetadataExt;
    meta.ino().to_string()
}

#[cfg(not(unix))]
fn directory_stamp(_meta: &fs::Metadata) -> String {
    String::new()
}

/// `registryStamp`: changes whenever a module's manifest is installed, updated, removed or replaced.
fn registry_stamp(directory: &Path) -> String {
    let stamp = || -> io::Result<String> {
        let root = fs::metadata(directory)?;
        let mut files: Vec<String> = module_directories(directory)?
            .into_iter()
            .map(
                |name| match fs::metadata(directory.join(&name).join("module.json")) {
                    Ok(meta) => format!("{name}:{}", file_stamp(&meta)),
                    Err(_) => format!("{name}:unavailable"),
                },
            )
            .collect();
        files.sort();
        Ok(format!("{}|{}", directory_stamp(&root), files.join("|")))
    };
    stamp().unwrap_or_else(|_| "unavailable".to_owned())
}

/// `loadConfigDisclosurePolicy`: loads local manifests without retrieval; missing or unreadable metadata keeps module
/// values private. A registry that changes while it is read is read again (three attempts), so concurrent installs never
/// publish a mixture of old and new declarations.
pub fn load_config_disclosure_policy(home: &Path) -> ConfigDisclosurePolicy {
    let directory = home.join("modules");
    for _ in 0..MAX_POLICY_READ_ATTEMPTS {
        let before = registry_stamp(&directory);
        match module_directories(&directory) {
            Ok(names) => {
                let policies = names
                    .iter()
                    .map(|name| module_policy(&directory, name))
                    .collect();
                if before == registry_stamp(&directory) {
                    return ConfigDisclosurePolicy::snapshot(policies, false);
                }
            }
            Err(e) => {
                return ConfigDisclosurePolicy::snapshot(
                    Vec::new(),
                    e.kind() != io::ErrorKind::NotFound,
                )
            }
        }
    }
    ConfigDisclosurePolicy::snapshot(Vec::new(), true)
}

/// The stop handle of [`watch_config_disclosure_policy`]. Dropping it stops the watcher too.
pub struct PolicyWatch {
    stop: Option<Sender<()>>,
    closed: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl PolicyWatch {
    /// Stops the watcher and waits for its thread; `changed` is not called after this returns. Idempotent.
    pub fn stop(&mut self) {
        self.closed.store(true, Ordering::SeqCst);
        self.stop.take();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for PolicyWatch {
    fn drop(&mut self) {
        self.stop();
    }
}

/// `watchConfigDisclosurePolicy`: observes install, update, removal and manifest repair independently of process children
/// or config edits. A polling thread compares the registry's stamp every `poll` and calls `changed` when it differs from
/// the last one it saw; the first check happens at once and, as in TypeScript, reports the starting state as a change.
/// `changed` runs on the watcher's thread, never concurrently with itself.
pub fn watch_config_disclosure_policy(
    home: &Path,
    poll: Duration,
    changed: impl Fn() + Send + 'static,
) -> PolicyWatch {
    let directory: PathBuf = home.join("modules");
    let (tx, rx) = mpsc::channel::<()>();
    let closed = Arc::new(AtomicBool::new(false));
    let seen_closed = Arc::clone(&closed);
    let thread = std::thread::spawn(move || {
        let mut stamp: Option<String> = None;
        loop {
            let next = registry_stamp(&directory);
            if !seen_closed.load(Ordering::SeqCst) && stamp.as_deref() != Some(next.as_str()) {
                stamp = Some(next);
                changed();
            }
            match rx.recv_timeout(poll) {
                Err(RecvTimeoutError::Timeout) => {}
                _ => break,
            }
        }
    });
    PolicyWatch {
        stop: Some(tx),
        closed,
        thread: Some(thread),
    }
}
