//! The secret names the engine may resolve (P4D-29, R-20-35, R-20-36): `engine/secret-scope.ts`, over the same schema.
//!
//! One definition, read from the configuration schema and nowhere else:
//!
//! - every value of the engine's part of the configuration (`engine`) that sits in a field marked `x-secret-reference`
//!   and is a valid secret name. A store reference of the object form (`{ "source": "store", "provider", "id" }`)
//!   names its `id`; an environment, file or exec reference names nothing the store holds;
//! - the names a block falls back to without a reference of its own: the schema marks the block `x-secret-default`,
//!   and the names are allowed exactly while that block is an object in the configuration. Neither the provider nor
//!   the host of the block is judged; whichever name the engine falls back to is on the list.
//!
//! No field name, block name or name pattern is written here. `fixtures/parity/secrets/engine-scope.json` holds what
//! this and the TypeScript set must both give; both replay it.
//!
//! **The set of a home ([`EngineScope`], R-20-37).** The front door asks it for every `host.secret.get` of the engine.
//! It is the set of the last `config.json` that was a valid configuration: a file that is cut off, no JSON or no
//! configuration changes nothing until a valid one is there, as the TypeScript core keeps its last valid configuration
//! (a typing mistake in the file must not take every key from a running engine). Before any valid file was read the
//! set is empty; a file that is not there is the defaults, as `readConfigFile` has it.
//!
//! The file is read again only when it is another file than the one the set was built from: its size, its
//! modification time to the nanosecond, its inode and its device. Otherwise a request costs one `stat`. A file whose
//! modification time is younger than [`SETTLE`] is read at every request, because a second write within the
//! granularity of the file system's clock would leave all four as they were. What is kept can therefore never go on
//! allowing a reference that a valid newer file took out.
//!
//! The file is read through one descriptor, opened without waiting (`O_NONBLOCK`): only a regular file is read (a
//! link to one is, since people link their `config.json`), and at most the loader's limit and one byte. A pipe, a
//! device or a file that is too large is no configuration and changes nothing.
use crate::config::load::{config_from_bytes, MAX_CONFIG_BYTES};
use crate::secrets::types::is_secret_name;
use plur1bus_config::{reference_paths_with_schema, SCHEMA_JSON};
use serde_json::Value;
use std::collections::BTreeSet;
use std::fs::{File, Metadata};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::{Duration, SystemTime};

fn schema() -> Option<&'static Value> {
    static SCHEMA: OnceLock<Option<Value>> = OnceLock::new();
    SCHEMA
        .get_or_init(|| serde_json::from_str(SCHEMA_JSON).ok())
        .as_ref()
}

fn referenced(config: &Value, schema: &Value, names: &mut BTreeSet<String>) {
    for pointer in reference_paths_with_schema(config, schema) {
        if !pointer.starts_with("/engine/") {
            continue;
        }
        let Some(value) = config.pointer(&pointer) else {
            continue;
        };
        let name = match value {
            Value::String(name) => Some(name.as_str()),
            Value::Object(fields)
                if fields.get("source").and_then(Value::as_str) == Some("store") =>
            {
                fields.get("id").and_then(Value::as_str)
            }
            _ => None,
        };
        if let Some(name) = name.filter(|name| is_secret_name(name)) {
            names.insert(name.to_owned());
        }
    }
}

fn defaults(schema: &Value, value: &Value, names: &mut BTreeSet<String>) {
    let (Some(_), Some(members)) = (schema.as_object(), value.as_object()) else {
        return;
    };
    // A node can carry its members beside `x-value-schema` (the `engine` node does); both views count.
    for view in [Some(schema), schema.get("x-value-schema")]
        .into_iter()
        .flatten()
    {
        if let Some(marked) = view.get("x-secret-default").and_then(Value::as_array) {
            names.extend(
                marked
                    .iter()
                    .filter_map(Value::as_str)
                    .filter(|name| is_secret_name(name))
                    .map(str::to_owned),
            );
        }
        if let Some(children) = view.get("properties").and_then(Value::as_object) {
            for (key, child) in children {
                if let Some(inner) = members.get(key) {
                    defaults(child, inner, names);
                }
            }
        }
    }
}

/// The set for one configuration; a configuration without an engine part gives the empty set.
pub fn engine_secret_names(config: &Value) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    let (Some(schema), Some(engine)) = (schema(), config.get("engine").filter(|v| v.is_object()))
    else {
        return names;
    };
    referenced(config, schema, &mut names);
    if let Some(engine_schema) = schema.pointer("/properties/engine") {
        defaults(engine_schema, engine, &mut names);
    }
    names
}

/// How old a file's modification time must be before the set built from it is kept without reading the file again.
/// Longer than the coarsest clock a file system stamps a file with (two seconds, FAT).
pub const SETTLE: Duration = Duration::from_secs(3);

/// What tells one `config.json` from another without reading it.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Identity {
    len: u64,
    modified: Option<SystemTime>,
    inode: u64,
    device: u64,
}

impl Identity {
    fn of(meta: &Metadata) -> Identity {
        #[cfg(unix)]
        let (inode, device) = {
            use std::os::unix::fs::MetadataExt;
            (meta.ino(), meta.dev())
        };
        // No inode without a handle there; a file put in the place of another has its own creation time.
        #[cfg(not(unix))]
        let (inode, device) = (
            meta.created()
                .ok()
                .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_nanos() as u64),
            0,
        );
        Identity {
            len: meta.len(),
            modified: meta.modified().ok(),
            inode,
            device,
        }
    }

    /// Whether the file was last written long enough ago for a later write to show in its modification time.
    fn settled(&self, now: SystemTime) -> bool {
        self.modified
            .and_then(|at| now.duration_since(at).ok())
            .is_some_and(|age| age >= SETTLE)
    }
}

/// What was at the path when the set was last brought up to date.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Seen {
    /// No file: the defaults.
    Missing,
    /// This file, read or refused; `true` when it need not be opened again while it stays this file.
    File(Identity, bool),
}

struct Kept {
    seen: Option<Seen>,
    names: Arc<BTreeSet<String>>,
}

/// Why a file was not read.
#[derive(Debug, PartialEq, Eq)]
enum Unread {
    /// No regular file, or larger than a configuration can be: no configuration, as long as it is this file.
    NoConfiguration,
    /// The read failed: the next request tries again.
    Failed,
}

/// Opens `path` without waiting and reads it when it is a regular file of at most [`MAX_CONFIG_BYTES`]: its identity
/// as the descriptor has it, and its bytes. Never waits for a writer of a pipe, and never reads more than the limit
/// and one byte, whatever the path leads to.
fn read_bounded(path: &Path) -> Result<(Identity, Vec<u8>), Unread> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file: File = options.open(path).map_err(|_| Unread::Failed)?;
    let meta = file.metadata().map_err(|_| Unread::Failed)?;
    if !meta.is_file() || meta.len() > MAX_CONFIG_BYTES {
        return Err(Unread::NoConfiguration);
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    (&file)
        .take(MAX_CONFIG_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Unread::Failed)?;
    if bytes.len() as u64 > MAX_CONFIG_BYTES {
        return Err(Unread::NoConfiguration);
    }
    // The file as it was when the read ended: a write during the read shows here, and the next request reads again.
    let after = file.metadata().map_err(|_| Unread::Failed)?;
    if Identity::of(&after) != Identity::of(&meta) {
        return Err(Unread::Failed);
    }
    Ok((Identity::of(&meta), bytes))
}

/// The secret names the engine of one home may resolve, kept between requests (see the module text).
pub struct EngineScope {
    path: PathBuf,
    kept: Mutex<Kept>,
    #[cfg(test)]
    reads: std::sync::atomic::AtomicUsize,
}

impl EngineScope {
    /// For the configuration file at `path`. Reads nothing until it is asked.
    pub fn new(path: PathBuf) -> EngineScope {
        EngineScope {
            path,
            kept: Mutex::new(Kept {
                seen: None,
                names: Arc::new(BTreeSet::new()),
            }),
            #[cfg(test)]
            reads: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    /// Whether the configuration that holds now lets the engine resolve `name`.
    pub fn allows(&self, name: &str) -> bool {
        self.names().contains(name)
    }

    /// The set that holds now: the one of the last valid configuration, brought up to date first.
    pub fn names(&self) -> Arc<BTreeSet<String>> {
        // One request at a time brings the set up to date; the others wait for it rather than read the file as well.
        let mut kept = self.kept.lock().unwrap_or_else(PoisonError::into_inner);
        let at_path = match std::fs::metadata(&self.path) {
            Ok(meta) => Some(Identity::of(&meta)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => None,
            // The path cannot be looked at: nothing is known to have changed.
            Err(_) => return kept.names.clone(),
        };
        let unchanged = match (&kept.seen, &at_path) {
            (Some(Seen::Missing), None) => true,
            (Some(Seen::File(seen, true)), Some(now)) => seen == now,
            _ => false,
        };
        if unchanged {
            return kept.names.clone();
        }
        let Some(at_path) = at_path else {
            kept.seen = Some(Seen::Missing);
            kept.names = Arc::new(engine_secret_names(&plur1bus_config::defaults()));
            return kept.names.clone();
        };
        #[cfg(test)]
        self.reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        match read_bounded(&self.path) {
            Ok((identity, bytes)) => {
                // A file that is no valid configuration changes nothing (R-20-37); a valid one is the set from here on.
                if let Ok(config) = config_from_bytes(&self.path, &bytes) {
                    kept.names = Arc::new(engine_secret_names(&config));
                }
                let settled = identity.settled(SystemTime::now());
                kept.seen = Some(Seen::File(identity, settled));
            }
            Err(Unread::NoConfiguration) => {
                let settled = at_path.settled(SystemTime::now());
                kept.seen = Some(Seen::File(at_path, settled));
            }
            Err(Unread::Failed) => kept.seen = Some(Seen::File(at_path, false)),
        }
        kept.names.clone()
    }

    /// How often the file was opened.
    #[cfg(test)]
    pub(crate) fn reads(&self) -> usize {
        self.reads.load(std::sync::atomic::Ordering::SeqCst)
    }
}

#[cfg(test)]
#[path = "engine_scope_tests.rs"]
mod file_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_vectors_shared_with_typescript() {
        let path = format!(
            "{}/../../fixtures/parity/secrets/engine-scope.json",
            env!("CARGO_MANIFEST_DIR")
        );
        let doc: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let cases = doc["cases"].as_array().unwrap();
        assert!(cases.len() >= 34, "the vectors are there");
        for case in cases {
            let expected: Vec<String> = case["names"]
                .as_array()
                .unwrap()
                .iter()
                .map(|n| n.as_str().unwrap().to_owned())
                .collect();
            let got: Vec<String> = engine_secret_names(&case["config"]).into_iter().collect();
            assert_eq!(got, expected, "{}", case["name"]);
        }
    }

    #[test]
    fn every_default_name_of_the_schema_is_a_secret_name() {
        let schema = schema().unwrap();
        let mut found = Vec::new();
        fn walk(node: &Value, found: &mut Vec<String>) {
            match node {
                Value::Object(map) => {
                    for (key, child) in map {
                        if key == "x-secret-default" {
                            for name in child.as_array().unwrap() {
                                found.push(name.as_str().unwrap().to_owned());
                            }
                        } else {
                            walk(child, found);
                        }
                    }
                }
                Value::Array(items) => items.iter().for_each(|i| walk(i, found)),
                _ => {}
            }
        }
        walk(schema, &mut found);
        assert!(!found.is_empty());
        assert!(found.iter().all(|n| is_secret_name(n)), "{found:?}");
    }
}
