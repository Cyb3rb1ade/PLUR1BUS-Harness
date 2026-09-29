//! `extensions/state.json`: one package record per installed extension (spec §6.2), schema-versioned, written
//! atomically with mode 0600. `skills/index.json` and `modules.<name>.enabled` own the enabled flags; this file owns
//! everything else about where an item came from.
use super::paths::ExtPaths;
use plur1bus_ext::manifest::FileEntry;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::io::{self, Write};
use std::path::Path;
use std::sync::OnceLock;

/// The state schema (draft 2020-12, closed): `https://plur1bus.dev/schema/ext-state/1/ext-state.schema.json` (X1-R27).
pub const STATE_SCHEMA_JSON: &str = include_str!("../../schema/ext-state.schema.json");
pub const STATE_VERSION: u32 = 1;

/// The result of the last integrity re-hash (X1-R17): when, whether every file matched, and which payload paths did
/// not.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Integrity {
    pub checked_at: String,
    pub ok: bool,
    pub paths: Vec<String>,
}

/// One installed extension.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemRecord {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub version: String,
    /// `file` in X1.
    pub source: String,
    /// A `plur1bus_ext::trust::Tier` in kebab case.
    pub trust: String,
    #[serde(default)]
    pub key_id: Option<String>,
    /// The label of the trusted key that verified the signature (`ExtTrust.label`), when one did.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_label: Option<String>,
    pub package_sha256: String,
    pub installed_at: String,
    #[serde(default)]
    pub previous_version: Option<String>,
    /// Payload-relative path to digest, size and exec bit.
    pub files: BTreeMap<String, FileEntry>,
    pub capabilities: Value,
    #[serde(default)]
    pub capabilities_ack: Option<String>,
    pub scripts: Vec<String>,
    pub required_secrets: Vec<String>,
    pub removed_by_user: bool,
    #[serde(default)]
    pub integrity: Option<Integrity>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtState {
    pub schema_version: u32,
    /// Keyed by item name.
    pub items: BTreeMap<String, ItemRecord>,
}

impl Default for ExtState {
    fn default() -> Self {
        ExtState {
            schema_version: STATE_VERSION,
            items: BTreeMap::new(),
        }
    }
}

/// Built on first use, so commands that never read the state do not pay for it (B1).
fn validator() -> &'static jsonschema::Validator {
    static V: OnceLock<jsonschema::Validator> = OnceLock::new();
    V.get_or_init(|| {
        let schema: Value =
            serde_json::from_str(STATE_SCHEMA_JSON).expect("embedded ext-state schema");
        jsonschema::options()
            .with_draft(jsonschema::Draft::Draft202012)
            .build(&schema)
            .expect("ext-state schema compiles")
    })
}

/// Reads `state.json`. A missing file is the empty state. A file written by a newer harness is refused before its
/// content is looked at (an old binary must never rewrite a newer file); anything the schema rejects is an error that
/// names the file and every violation.
pub fn read(p: &ExtPaths) -> Result<ExtState, String> {
    let text = match std::fs::read_to_string(&p.state) {
        Ok(t) => t,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(ExtState::default()),
        Err(e) => return Err(format!("{}: {e}", p.state.display())),
    };
    let v: Value =
        serde_json::from_str(&text).map_err(|e| format!("{}: not JSON: {e}", p.state.display()))?;
    if let Some(n) = v.get("schemaVersion").and_then(Value::as_u64) {
        if n > u64::from(STATE_VERSION) {
            return Err(format!(
                "{}: state schema version {n} is newer than {STATE_VERSION}; update PLUR1BUS",
                p.state.display()
            ));
        }
    }
    let errs: Vec<String> = validator()
        .iter_errors(&v)
        .map(|e| format!("{}: {e}", e.instance_path))
        .collect();
    if !errs.is_empty() {
        return Err(format!("{}: {}", p.state.display(), errs.join("; ")));
    }
    serde_json::from_value(v).map_err(|e| format!("{}: {e}", p.state.display()))
}

/// Writes `state.json` atomically: `state.json.tmp-<pid>`, fsync, rename; mode 0600.
pub fn write(p: &ExtPaths, s: &ExtState) -> io::Result<()> {
    let mut text = serde_json::to_string_pretty(s).map_err(io::Error::other)?;
    text.push('\n');
    write_private_atomic(&p.state, text.as_bytes())
}

/// How long a rename or removal is retried: 10 s on Windows (`fs-retry.ts` `rmRetry`, where Defender or the indexer
/// can hold a handle on a fresh file for a moment, M8); not at all elsewhere.
fn retry_budget() -> std::time::Duration {
    if cfg!(windows) {
        std::time::Duration::from_secs(10)
    } else {
        std::time::Duration::ZERO
    }
}

/// A failure a transient handle on Windows causes: access denied, a sharing violation or a lock violation.
fn transient(e: &io::Error) -> bool {
    e.kind() == io::ErrorKind::PermissionDenied
        || e.kind() == io::ErrorKind::ResourceBusy
        || (cfg!(windows) && matches!(e.raw_os_error(), Some(5 | 32 | 33)))
}

fn retrying(mut op: impl FnMut() -> io::Result<()>) -> io::Result<()> {
    let deadline = std::time::Instant::now() + retry_budget();
    loop {
        match op() {
            Err(e) if transient(&e) && std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            r => return r,
        }
    }
}

/// `fs::rename`, retried while the failure is a transient handle on Windows.
pub(crate) fn rename_retrying(from: &Path, to: &Path) -> io::Result<()> {
    retrying(|| std::fs::rename(from, to))
}

/// `fs::remove_file`, retried like [`rename_retrying`]; a file that is already gone is success.
pub(crate) fn remove_retrying(path: &Path) -> io::Result<()> {
    match retrying(|| std::fs::remove_file(path)) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        r => r,
    }
}

/// `fs::remove_dir_all`, retried like [`rename_retrying`]; a directory that is already gone is success.
pub(crate) fn remove_dir_all_retrying(path: &Path) -> io::Result<()> {
    match retrying(|| std::fs::remove_dir_all(path)) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        r => r,
    }
}

/// `fs::remove_dir` (an empty directory), retried like [`rename_retrying`]; a directory that is already gone is success.
pub(crate) fn remove_empty_dir_retrying(path: &Path) -> io::Result<()> {
    match retrying(|| std::fs::remove_dir(path)) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        r => r,
    }
}

/// `fs::create_dir`, retried like [`rename_retrying`]; a directory that already exists is success.
pub(crate) fn create_dir_retrying(path: &Path) -> io::Result<()> {
    match retrying(|| std::fs::create_dir(path)) {
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists && path.is_dir() => Ok(()),
        r => r,
    }
}

/// The atomic private write every ext file uses (global constraints): `<name>.tmp-<pid>` created private to the user
/// (0600, a protected DACL on Windows), `fsync`, `rename`. Creates the parent directory. A failed write leaves no
/// temp file behind.
pub(crate) fn write_private_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".tmp-{}", std::process::id()));
    let tmp = path.with_file_name(name);
    let res = (|| {
        let mut f = crate::audit::create_private(&tmp, true)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        rename_retrying(&tmp, path)
    })();
    if res.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    res
}
