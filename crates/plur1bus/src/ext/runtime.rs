//! Metadata-only Core ports for extension setup and process holds. Values are never requested through RPC;
//! one operation owns its lazy availability snapshot, so a later operation always observes fresh metadata.
use super::ExtError;
use crate::paths::{core_address, Layout};
use plur1bus_rpc::{Client, ConnectOptions, Endpoint};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::io::{Read, Write};
use std::time::{Duration, Instant};

/// The complete set of known secret names, or an unavailable/incomplete metadata answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SecretPresence {
    Unknown,
    Known(BTreeSet<String>),
}

impl SecretPresence {
    /// Reduces `secret.status` to names only; backend failures never masquerade as an empty available store.
    pub fn from_status(status: &Value) -> Self {
        if !matches!(
            status["backend"].as_str(),
            Some("keyring" | "file" | "memory")
        ) {
            return Self::Unknown;
        }
        let Some(entries) = status["secrets"].as_array() else {
            return Self::Unknown;
        };
        let mut names = BTreeSet::new();
        for entry in entries {
            let Some(name) = entry["name"]
                .as_str()
                .filter(|name| !name.is_empty() && name.len() <= 256 && !name.contains('\0'))
            else {
                return Self::Unknown;
            };
            if !names.insert(name.to_string()) {
                return Self::Unknown;
            }
        }
        Self::Known(names)
    }

    /// Required slots whose canonical names are absent or cannot currently be checked.
    pub fn missing_for(&self, name: &str, required: &[String]) -> Vec<String> {
        required
            .iter()
            .filter(|slot| match self {
                Self::Unknown => true,
                Self::Known(names) => !names.contains(&format!("ext:{name}:{slot}")),
            })
            .cloned()
            .collect()
    }
}

/// One operation's lazy metadata snapshot. A new operation starts with no availability knowledge.
#[derive(Default)]
pub struct OperationPresence {
    snapshot: Option<SecretPresence>,
}

impl OperationPresence {
    pub fn missing_with(
        &mut self,
        name: &str,
        required: &[String],
        fetch: impl FnOnce() -> SecretPresence,
    ) -> Vec<String> {
        if required.is_empty() {
            return vec![];
        }
        self.snapshot
            .get_or_insert_with(fetch)
            .missing_for(name, required)
    }

    pub fn missing(&mut self, layout: &Layout, name: &str, required: &[String]) -> Vec<String> {
        self.missing_with(name, required, || fresh(layout))
    }

    pub fn require_store(&mut self, layout: &Layout) -> Result<(), ExtError> {
        match self.snapshot.get_or_insert_with(|| fresh(layout)) {
            SecretPresence::Known(_) => Ok(()),
            SecretPresence::Unknown => Err(store_unavailable()),
        }
    }
}

fn fresh(layout: &Layout) -> SecretPresence {
    call_core(layout, "secret.status", json!({})).map_or(SecretPresence::Unknown, |value| {
        SecretPresence::from_status(&value)
    })
}

fn store_unavailable() -> ExtError {
    ExtError::new(
        "E_NOT_AVAILABLE",
        "secret-store-unavailable",
        "the authenticated Core secret store is required to purge declared slots",
    )
}

fn unavailable() -> ExtError {
    ExtError::new(
        "E_NOT_AVAILABLE",
        "core-unavailable",
        "the extension runtime could not contact the authenticated Core",
    )
}

/// Authenticated metadata/control only. This port has no secret-value method or forwarded credential.
pub(crate) fn call_core(layout: &Layout, method: &str, params: Value) -> Result<Value, ExtError> {
    call_core_budget(layout, method, params, Duration::from_secs(2))
}

fn call_core_budget(
    layout: &Layout,
    method: &str,
    params: Value,
    timeout: Duration,
) -> Result<Value, ExtError> {
    if !matches!(
        method,
        "secret.status"
            | "secret.delete"
            | "admin.extensions.runtime.hold"
            | "admin.extensions.runtime.release"
            | "admin.extensions.runtime.status"
    ) {
        return Err(ExtError::new(
            "E_DENIED",
            "runtime-port",
            "the extension runtime port only accepts metadata and lifecycle control",
        ));
    }
    let token = layout
        .read_token_file(&layout.core_token())
        .map_err(|_| unavailable())?;
    let pid = layout.recorded_pid(Endpoint::Core);
    if cfg!(windows) && pid.is_none() {
        return Err(unavailable());
    }
    let address = core_address(
        &layout.home,
        if cfg!(windows) { "windows" } else { "posix" },
    );
    let mut client = Client::connect(
        &address,
        token.trim(),
        ConnectOptions {
            endpoint: Endpoint::Core,
            connect_timeout: timeout,
            call_timeout: timeout,
            expected_server_pid: pid,
        },
    )
    .map_err(|_| unavailable())?;
    client.call(method, params).map_err(|_| unavailable())
}

/// A live Core must acknowledge stopping this MCP runtime before its code or activation can move.
pub fn hold(layout: &Layout, name: &str) -> Result<bool, ExtError> {
    let address = core_address(
        &layout.home,
        if cfg!(windows) { "windows" } else { "posix" },
    );
    let live = layout
        .recorded_pid(Endpoint::Core)
        .is_some_and(crate::proc::pid_alive);
    if !live && (cfg!(windows) || !std::path::Path::new(&address).exists()) {
        return Ok(false);
    }
    recorded_hold(layout, name, || {
        let value = call_core(
            layout,
            "admin.extensions.runtime.hold",
            json!({"name":name}),
        )?;
        if value["name"] != name || value["held"] != true {
            return Err(unavailable());
        }
        Ok(())
    })?;
    Ok(true)
}

pub fn release(layout: &Layout, name: &str) -> Result<(), ExtError> {
    release_budget(layout, name, Duration::from_secs(2))
}

fn release_budget(layout: &Layout, name: &str, timeout: Duration) -> Result<(), ExtError> {
    recorded_release(layout, name, || {
        let value = call_core_budget(
            layout,
            "admin.extensions.runtime.release",
            json!({"name":name}),
            timeout,
        )?;
        if value["name"] != name || value["released"] != true {
            return Err(unavailable());
        }
        Ok(())
    })
}

/// Runtime status is names and fixed overlays only; malformed or offline responses add no invented status.
pub fn status(layout: &Layout, name: &str) -> Option<super::overlays::Overlay> {
    let value = call_core(
        layout,
        "admin.extensions.runtime.status",
        json!({"name":name}),
    )
    .ok()?;
    if value["name"] != name {
        return None;
    }
    match value["overlay"].as_str() {
        Some("needs-setup") => Some(super::overlays::Overlay::NeedsSetup),
        Some("error") => Some(super::overlays::Overlay::Error),
        _ => None,
    }
}

pub fn delete_declared(layout: &Layout, name: &str, slots: &[String]) -> Result<(), ExtError> {
    for slot in slots {
        if !valid_slot(slot) {
            return Err(ExtError::new(
                "E_STORAGE",
                "state-invalid",
                "invalid declared extension secret slot",
            ));
        }
        call_core(
            layout,
            "secret.delete",
            json!({"name":format!("ext:{name}:{slot}")}),
        )
        .map_err(|_| store_unavailable())?;
    }
    Ok(())
}

pub fn valid_slot(slot: &str) -> bool {
    let bytes = slot.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0].is_ascii_alphabetic()
        && bytes
            .iter()
            .all(|c| c.is_ascii_alphanumeric() || *c == b'_')
}

pub fn declared_slots(capabilities: &Value) -> Result<Vec<String>, ExtError> {
    let Some(raw) = capabilities.get("secrets") else {
        return Ok(vec![]);
    };
    let invalid = || {
        ExtError::new(
            "E_STORAGE",
            "state-invalid",
            "invalid declared extension secret slots",
        )
    };
    let slots = raw.as_array().ok_or_else(invalid)?;
    if slots.len() > 256 {
        return Err(invalid());
    }
    let mut names = BTreeSet::new();
    for entry in slots {
        let slot = entry["slot"]
            .as_str()
            .filter(|s| valid_slot(s))
            .ok_or_else(invalid)?;
        if !names.insert(slot.to_string()) {
            return Err(invalid());
        }
    }
    Ok(names.into_iter().collect())
}

const HOLD_JOURNAL_BYTES: u64 = 512 * 1024;
const HOLD_JOURNAL_NAMES: usize = 4096;

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct HoldJournal {
    version: u8,
    names: BTreeSet<String>,
}

fn journal_error() -> ExtError {
    ExtError::new(
        "E_STORAGE",
        "runtime-hold-journal",
        "the private extension hold journal is not trusted or readable",
    )
}

pub fn recovery_needed(layout: &Layout) -> bool {
    !matches!(std::fs::symlink_metadata(layout.run().join("ext-runtime-holds.json")), Err(error) if error.kind() == std::io::ErrorKind::NotFound)
}

fn pending_names(layout: &Layout) -> Result<BTreeSet<String>, ExtError> {
    let path = layout.run().join("ext-runtime-holds.json");
    if matches!(std::fs::symlink_metadata(layout.run()), Err(error) if error.kind() == std::io::ErrorKind::NotFound)
    {
        return Ok(BTreeSet::new());
    }
    plur1bus_rpc::trust::verify_run_dir(&layout.run()).map_err(|_| journal_error())?;
    match std::fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeSet::new()),
        Ok(metadata)
            if metadata.is_file()
                && !metadata.file_type().is_symlink()
                && metadata.len() <= HOLD_JOURNAL_BYTES => {}
        _ => return Err(journal_error()),
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000);
    } // FILE_FLAG_OPEN_REPARSE_POINT
    let file = options.open(&path).map_err(|_| journal_error())?;
    let metadata = file.metadata().map_err(|_| journal_error())?;
    if !metadata.is_file() || metadata.len() > HOLD_JOURNAL_BYTES {
        return Err(journal_error());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // SAFETY: geteuid has no preconditions and does not mutate process state.
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
            return Err(journal_error());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(journal_error());
        }
    }
    let mut bytes = Vec::new();
    file.take(HOLD_JOURNAL_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| journal_error())?;
    if bytes.len() as u64 > HOLD_JOURNAL_BYTES {
        return Err(journal_error());
    }
    let journal: HoldJournal = serde_json::from_slice(&bytes).map_err(|_| journal_error())?;
    if journal.version != 1
        || journal.names.len() > HOLD_JOURNAL_NAMES
        || journal
            .names
            .iter()
            .any(|name| !super::record::skill_id_ok(name))
    {
        return Err(journal_error());
    }
    Ok(journal.names)
}

fn store_names(layout: &Layout, names: BTreeSet<String>) -> Result<(), ExtError> {
    plur1bus_rpc::trust::verify_run_dir(&layout.run()).map_err(|_| journal_error())?;
    let path = layout.run().join("ext-runtime-holds.json");
    if names.is_empty() {
        return super::state::remove_retrying(&path).map_err(|_| journal_error());
    }
    if names.len() > HOLD_JOURNAL_NAMES {
        return Err(journal_error());
    }
    let bytes =
        serde_json::to_vec(&HoldJournal { version: 1, names }).map_err(|_| journal_error())?;
    let temporary = layout
        .run()
        .join(format!("ext-runtime-holds.{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> std::io::Result<()> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            use windows_sys::Win32::{Foundation::GENERIC_WRITE, Storage::FileSystem::WRITE_DAC};
            options
                .access_mode(GENERIC_WRITE | WRITE_DAC)
                .custom_flags(0x0020_0000);
        }
        let mut file = options.open(&temporary)?;
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            plur1bus_rpc::win::restrict_to_user(file.as_raw_handle())?;
        }
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        super::state::rename_retrying(&temporary, &path)?;
        #[cfg(unix)]
        std::fs::File::open(layout.run())?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result.map_err(|_| journal_error())
}

fn recorded_hold(
    layout: &Layout,
    name: &str,
    control: impl FnOnce() -> Result<(), ExtError>,
) -> Result<(), ExtError> {
    if !super::record::skill_id_ok(name) {
        return Err(journal_error());
    }
    let mut names = pending_names(layout)?;
    names.insert(name.to_string());
    store_names(layout, names)?;
    control() // Even an uncertain acknowledgment must remain recoverable.
}

fn recorded_release(
    layout: &Layout,
    name: &str,
    control: impl FnOnce() -> Result<(), ExtError>,
) -> Result<(), ExtError> {
    control()?;
    let mut names = pending_names(layout)?;
    if names.remove(name) {
        store_names(layout, names)?;
    }
    Ok(())
}

/// Called only after ext::recover, with the caller's ext mutation guard held. Bounded batches preserve names even
/// when uninstall removed their state records; only the authenticated Core's explicit acknowledgment clears them.
pub fn settle(layout: &Layout) -> Result<(), ExtError> {
    let deadline = Instant::now() + Duration::from_secs(4);
    let names = pending_names(layout)?;
    let mut failed = false;
    for name in names.iter().take(32) {
        let Some(remaining) = deadline
            .checked_duration_since(Instant::now())
            .filter(|duration| *duration > Duration::from_millis(20))
        else {
            break;
        };
        let timeout = (remaining / 2).min(Duration::from_millis(500));
        if release_budget(layout, name, timeout).is_err() {
            failed = true;
        }
    }
    if failed || !pending_names(layout)?.is_empty() {
        return Err(unavailable());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn status_metadata_distinguishes_present_missing_and_unavailable_slots() {
        let presence = SecretPresence::from_status(&json!({
            "backend": "memory", "secrets": [{"name": "ext:docs:apiKey"}, {"name": "OTHER_KEY"}]
        }));
        assert_eq!(
            presence.missing_for("docs", &["apiKey".into(), "missing".into()]),
            vec!["missing"]
        );
        assert_eq!(
            presence.missing_for("other", &["apiKey".into()]),
            vec!["apiKey"]
        );
        assert_eq!(
            SecretPresence::from_status(&json!({"backend": "memory", "secrets": []})),
            SecretPresence::Known(BTreeSet::new())
        );
        for unavailable in [
            json!({"backend": "none", "secrets": []}),
            json!({"backend": "memory"}),
            json!({"backend": "memory", "secrets": [{}]}),
        ] {
            let presence = SecretPresence::from_status(&unavailable);
            assert_eq!(presence, SecretPresence::Unknown);
            assert_eq!(
                presence.missing_for("docs", &["apiKey".into()]),
                vec!["apiKey"]
            );
        }
    }

    #[test]
    fn metadata_debug_retains_names_and_never_retains_values_or_descriptions() {
        let presence = SecretPresence::from_status(&json!({
            "backend": "memory", "secrets": [{"name": "ext:docs:apiKey", "value": "marker-secret-value", "description": "marker-secret-description"}]
        }));
        let shown = format!("{presence:?}");
        assert!(shown.contains("ext:docs:apiKey"));
        assert!(!shown.contains("marker-secret"));
    }

    #[test]
    fn metadata_is_lazy_once_per_operation_and_the_next_operation_observes_rotation() {
        let calls = std::cell::Cell::new(0);
        let fetch = || {
            calls.set(calls.get() + 1);
            SecretPresence::from_status(
                &json!({"backend":"memory","secrets":[{"name":"ext:docs:apiKey"}]}),
            )
        };
        let mut operation = OperationPresence::default();
        assert!(operation.missing_with("docs", &[], fetch).is_empty());
        assert_eq!(calls.get(), 0);
        assert!(operation
            .missing_with("docs", &["apiKey".into()], fetch)
            .is_empty());
        assert_eq!(
            operation.missing_with("docs", &["missing".into()], fetch),
            ["missing"]
        );
        assert_eq!(calls.get(), 1);
        let mut next = OperationPresence::default();
        assert_eq!(
            next.missing_with("docs", &["apiKey".into()], || SecretPresence::Known(
                BTreeSet::new()
            )),
            ["apiKey"]
        );
    }

    fn journal_home() -> (tempfile::TempDir, Layout) {
        let directory = tempfile::tempdir().unwrap();
        let layout = Layout::new(directory.path().join("h"));
        std::fs::create_dir_all(layout.run()).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(layout.run(), std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        (directory, layout)
    }

    #[test]
    fn hold_journal_precedes_core_control_and_only_an_acknowledged_release_removes_it() {
        let (_directory, layout) = journal_home();
        let failure = recorded_hold(&layout, "removed-package", || {
            assert!(
                pending_names(&layout).unwrap().contains("removed-package"),
                "the record must survive an uncertain Core acknowledgment"
            );
            Err(unavailable())
        });
        assert!(failure.is_err());
        assert!(pending_names(&layout).unwrap().contains("removed-package"));
        assert!(recorded_release(&layout, "removed-package", || Err(unavailable())).is_err());
        assert!(pending_names(&layout).unwrap().contains("removed-package"));
        recorded_release(&layout, "removed-package", || Ok(())).unwrap();
        assert!(pending_names(&layout).unwrap().is_empty());
        assert!(!layout.run().join("ext-runtime-holds.json").exists());
    }

    #[test]
    fn hold_journal_rejects_invalid_names_oversize_and_symlinks_without_touching_targets() {
        let (_directory, layout) = journal_home();
        let file = layout.run().join("ext-runtime-holds.json");
        let write = |bytes: &[u8]| {
            super::super::state::write_private_atomic(&file, bytes).unwrap();
        };
        for bytes in [
            br#"{"version":1,"names":["../other"]}"#.to_vec(),
            vec![b' '; 512 * 1024 + 1],
        ] {
            write(&bytes);
            assert!(pending_names(&layout).is_err());
        }
        std::fs::remove_file(&file).unwrap();
        #[cfg(unix)]
        {
            let target = layout.home.join("target");
            std::fs::write(&target, b"journal-target-canary").unwrap();
            std::os::unix::fs::symlink(&target, &file).unwrap();
            assert!(pending_names(&layout).is_err());
            assert!(recorded_hold(&layout, "fixture", || Ok(())).is_err());
            assert_eq!(std::fs::read(target).unwrap(), b"journal-target-canary");
        }
    }
}
